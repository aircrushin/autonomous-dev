import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Attempt, Evidence, Goal, GoalStatus, HumanRequest, Operation, WorkItem, WorkItemStatus } from '../contracts/index.js';
import { assertGoalTransition, assertWorkItemTransition } from '../contracts/index.js';
import { nextPolicyVersion, type AuthorizationPolicy } from '../policy/authorization.js';
import { validateGoalPlan, type GoalPlan } from '../planner/index.js';

function withBusyRetry<T>(operation: () => T): T {
  for (let attempt = 0; ; attempt += 1) {
    try { return operation(); }
    catch (error) {
      if (attempt >= 20 || !/database is locked|database is busy/i.test(String(error))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export interface ProviderLease {
  resourceKey: string;
  owner: string;
  token: string;
  expiresAt: number;
}
export interface GoalTransitionContext { reason?: string; diagnostic?: unknown; }

export interface GoalSnapshot {
  goal: Goal;
  workItems: WorkItem[];
  attempts: Attempt[];
  evidence: Evidence[];
  humanRequests: HumanRequest[];
  operations: Operation[];
  events: Array<Record<string, unknown>>;
  reservedBudget: number;
}

export class LeaseConflictError extends Error {
  readonly code = 'LEASE_HELD';
  constructor(resourceId: string) { super(`lease held by another owner: ${resourceId}`); }
}

function normalizeAuthorizationPolicy(value: unknown): AuthorizationPolicy {
  const policy = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
  if (typeof policy.version !== 'string' || policy.version.length === 0) policy.version = 'v1';
  return policy as AuthorizationPolicy;
}

function contractVersion(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'version' in value) {
    return (value as Record<string, unknown>).version;
  }
  return undefined;
}

function versionString(value: unknown): string | undefined {
  const version = contractVersion(value);
  return version === undefined ? undefined : String(version);
}

function bumpContractVersion(previous: unknown, currentVersion: unknown): unknown {
  let nextVersion: string | number = 1;
  if (typeof currentVersion === 'number' && Number.isFinite(currentVersion)) nextVersion = currentVersion + 1;
  else if (typeof currentVersion === 'string' && currentVersion.length > 0) {
    if (/^\d+$/.test(currentVersion)) nextVersion = String(Number(currentVersion) + 1);
    else {
      const match = /^(.*?)(\d+)$/.exec(currentVersion);
      if (match) nextVersion = `${match[1]}${Number(match[2]) + 1}`;
      else nextVersion = `${currentVersion}.1`;
    }
  }
  if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
    return { ...(previous as Record<string, unknown>), version: nextVersion };
  }
  return { definition: previous, version: nextVersion };
}

function assertGoalMutable(goal: Goal): void {
  if (goal.status === 'SUCCEEDED' || goal.status === 'CLOSED_UNACHIEVABLE') {
    throw new Error(`Goal cannot be updated from ${goal.status}`);
  }
}

function assertOperationReconciliationTransition(from: Operation['reconciliationStatus'], to: Operation['reconciliationStatus']): void {
  if (from === 'SUCCEEDED' || from === 'FAILED') {
    throw new Error(`Operation cannot be updated from ${from}`);
  }
  if (from === to || ['PENDING', 'UNKNOWN', 'SUCCEEDED', 'FAILED'].includes(to)) return;
  throw new Error(`非法 Operation 状态迁移: ${from} -> ${to}`);
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    withBusyRetry(() => this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY, user_intent TEXT NOT NULL, constraints_json TEXT NOT NULL,
        acceptance_json TEXT NOT NULL, authorization_json TEXT NOT NULL, budget_json TEXT NOT NULL,
        status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), description TEXT NOT NULL,
        dependencies_json TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, work_item_id TEXT, requirement_id TEXT NOT NULL, contract_version TEXT NOT NULL, candidate_digest TEXT NOT NULL,
        check_definition_digest TEXT NOT NULL, environment_fingerprint TEXT NOT NULL,
        input_digest TEXT NOT NULL, status TEXT NOT NULL, raw_artifact_refs_json TEXT NOT NULL,
        observed_at TEXT NOT NULL, expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id), base_revision TEXT NOT NULL,
        workspace_id TEXT NOT NULL, agent TEXT NOT NULL, result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS operations (
        action_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, exact_revision TEXT NOT NULL,
        intended_target TEXT NOT NULL, goal_id TEXT, target_ref TEXT, reconciliation_status TEXT NOT NULL,
        push_receipt_json TEXT, external_receipt_json TEXT, merge_receipt_json TEXT, merge_idempotency_key TEXT
      );
      CREATE TABLE IF NOT EXISTS human_requests (
        id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES goals(id), question TEXT NOT NULL,
        context_json TEXT NOT NULL, recommended_options_json TEXT, blocking_items_json TEXT,
        required_authority TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        resource_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS provider_leases (
        resource_key TEXT PRIMARY KEY, owner TEXT NOT NULL, token TEXT NOT NULL,
        expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS retry_state (
        work_item_id TEXT PRIMARY KEY REFERENCES work_items(id), attempts INTEGER NOT NULL DEFAULT 0, last_fingerprint TEXT, last_decision TEXT
      );
      CREATE TABLE IF NOT EXISTS budget_usage (
        goal_id TEXT PRIMARY KEY REFERENCES goals(id), reserved INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    `));
    // Upgrade existing local databases without discarding task history.
    withBusyRetry(() => this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(attempts)').all().map(row => row.name);
      if (!columns.includes('started_at')) this.db.exec('ALTER TABLE attempts ADD COLUMN started_at TEXT');
      if (!columns.includes('ended_at')) this.db.exec('ALTER TABLE attempts ADD COLUMN ended_at TEXT');
      const evidenceColumns = this.db.prepare('PRAGMA table_info(evidence)').all().map(row => row.name);
      if (!evidenceColumns.includes('work_item_id')) this.db.exec('ALTER TABLE evidence ADD COLUMN work_item_id TEXT');
      if (!evidenceColumns.includes('expires_at')) this.db.exec('ALTER TABLE evidence ADD COLUMN expires_at TEXT');
      const operationColumns = this.db.prepare('PRAGMA table_info(operations)').all().map(row => row.name);
      if (!operationColumns.includes('goal_id')) this.db.exec('ALTER TABLE operations ADD COLUMN goal_id TEXT');
      if (!operationColumns.includes('target_ref')) this.db.exec('ALTER TABLE operations ADD COLUMN target_ref TEXT');
      if (!operationColumns.includes('push_receipt_json')) this.db.exec('ALTER TABLE operations ADD COLUMN push_receipt_json TEXT');
      if (!operationColumns.includes('external_receipt_json')) this.db.exec('ALTER TABLE operations ADD COLUMN external_receipt_json TEXT');
      if (!operationColumns.includes('merge_receipt_json')) this.db.exec('ALTER TABLE operations ADD COLUMN merge_receipt_json TEXT');
      if (!operationColumns.includes('merge_idempotency_key')) this.db.exec('ALTER TABLE operations ADD COLUMN merge_idempotency_key TEXT');
      const humanRequestColumns = this.db.prepare('PRAGMA table_info(human_requests)').all().map(row => row.name);
      if (!humanRequestColumns.includes('recommended_options_json')) this.db.exec('ALTER TABLE human_requests ADD COLUMN recommended_options_json TEXT');
      if (!humanRequestColumns.includes('blocking_items_json')) this.db.exec('ALTER TABLE human_requests ADD COLUMN blocking_items_json TEXT');
      const retryColumns = this.db.prepare('PRAGMA table_info(retry_state)').all().map(row => row.name);
      if (!retryColumns.includes('last_decision')) this.db.exec('ALTER TABLE retry_state ADD COLUMN last_decision TEXT');
    }));
  }

  createGoal(input: Pick<Goal, 'id' | 'userIntent' | 'constraints' | 'acceptanceContract' | 'authorizationPolicy' | 'budget'>): Goal {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const authorizationPolicy = normalizeAuthorizationPolicy(input.authorizationPolicy);
      this.db.prepare(`INSERT INTO goals VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', 1, ?)`).run(
        input.id, input.userIntent, JSON.stringify(input.constraints), JSON.stringify(input.acceptanceContract),
        JSON.stringify(authorizationPolicy), JSON.stringify(input.budget), now);
      this.event('goal', input.id, 'GOAL_CREATED', { status: 'DRAFT' });
      return this.getGoal(input.id)!;
    });
  }

  /** Persist a validated planner result atomically with its Goal and WorkItems. */
  createGoalWithPlan(input: Omit<Pick<Goal, 'id' | 'userIntent' | 'constraints' | 'authorizationPolicy' | 'budget'>, 'id'> & { id: string; plan: GoalPlan }): { goal: Goal; workItems: WorkItem[] } {
    validateGoalPlan(input.plan);
    return this.transaction(() => {
      const now = new Date().toISOString();
      const authorizationPolicy = normalizeAuthorizationPolicy(input.authorizationPolicy);
      this.db.prepare(`INSERT INTO goals VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', 1, ?)`).run(
        input.id, input.userIntent, JSON.stringify(input.constraints), JSON.stringify({ version: input.plan.contractVersion, requirements: input.plan.requirements }),
        JSON.stringify(authorizationPolicy), JSON.stringify(input.budget), now);
      this.event('goal', input.id, 'GOAL_CREATED', { status: 'DRAFT', planned: true });
      for (const item of input.plan.workItems) {
        this.db.prepare(`INSERT INTO work_items VALUES (?, ?, ?, ?, 'PENDING', 0)`).run(item.id, input.id, item.description, JSON.stringify(item.dependencies));
        this.event('work_item', item.id, 'WORK_ITEM_CREATED', { goalId: input.id, planned: true });
      }
      return { goal: this.getGoal(input.id)!, workItems: this.listWorkItems(input.id) };
    });
  }

  getGoal(id: string): Goal | undefined {
    const row = this.db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { id: row.id as string, userIntent: row.user_intent as string,
      constraints: JSON.parse(row.constraints_json as string), acceptanceContract: JSON.parse(row.acceptance_json as string),
      authorizationPolicy: normalizeAuthorizationPolicy(JSON.parse(row.authorization_json as string)), budget: JSON.parse(row.budget_json as string),
      status: row.status as GoalStatus, version: row.version as number };
  }

  listGoals(): Goal[] {
    const rows = this.db.prepare('SELECT * FROM goals ORDER BY id').all() as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: String(row.id), userIntent: String(row.user_intent),
      constraints: JSON.parse(String(row.constraints_json)), acceptanceContract: JSON.parse(String(row.acceptance_json)),
      authorizationPolicy: normalizeAuthorizationPolicy(JSON.parse(String(row.authorization_json))), budget: JSON.parse(String(row.budget_json)),
      status: row.status as GoalStatus, version: Number(row.version) }));
  }

  getGoalSnapshot(goalId: string): GoalSnapshot | undefined {
    const goal = this.getGoal(goalId);
    if (!goal) return undefined;
    const workItems = this.listWorkItems(goalId);
    const workItemIds = new Set(workItems.map(item => item.id));
    return {
      goal,
      workItems,
      attempts: this.listAttempts().filter(attempt => workItemIds.has(attempt.workItemId)),
      evidence: this.listEvidenceForGoal(goalId),
      humanRequests: this.listHumanRequests(goalId),
      operations: this.listOperations().filter(operation => operation.goalId === goalId),
      events: this.listGoalEvents(goalId),
      reservedBudget: this.reservedBudget(goalId)
    };
  }

  /** Update the persisted policy with a control-plane-owned monotonic version. */
  updateAuthorizationPolicy(goalId: string, policy: AuthorizationPolicy, options: { expectedVersion?: string; reason?: string } = {}): Goal {
    return this.transaction(() => {
      const goal = this.getGoal(goalId);
      if (!goal) throw new Error(`Goal 不存在: ${goalId}`);
      assertGoalMutable(goal);
      const current = normalizeAuthorizationPolicy(goal.authorizationPolicy);
      if (options.expectedVersion !== undefined && current.version !== options.expectedVersion) {
        throw new Error('authorization policy version changed');
      }
      const next = { ...policy, version: nextPolicyVersion(current.version) };
      this.db.prepare('UPDATE goals SET authorization_json = ?, version = version + 1 WHERE id = ?').run(JSON.stringify(next), goalId);
      this.event('goal', goalId, 'AUTHORIZATION_POLICY_UPDATED', {
        fromVersion: current.version, toVersion: next.version, reason: options.reason ?? 'policy update'
      });
      return this.getGoal(goalId)!;
    });
  }

  /**
   * Change user direction/constraints and advance the acceptance contract
   * revision in the same transaction.  Existing evidence remains immutable
   * and is naturally stale because its contractVersion no longer matches.
   */
  updateGoalDirection(goalId: string, input: {
    userIntent?: string;
    constraints?: unknown;
    acceptanceContract?: unknown;
    expectedGoalVersion?: number;
    reason?: string;
  }): Goal {
    return this.transaction(() => {
      const goal = this.getGoal(goalId);
      if (!goal) throw new Error(`Goal 不存在: ${goalId}`);
      assertGoalMutable(goal);
      if (input.expectedGoalVersion !== undefined && goal.version !== input.expectedGoalVersion) {
        throw new Error('goal version changed');
      }
      if (input.userIntent === undefined && input.constraints === undefined && input.acceptanceContract === undefined) {
        throw new Error('direction update requires a change');
      }
      const nextUserIntent = input.userIntent ?? goal.userIntent;
      const nextConstraints = input.constraints ?? goal.constraints;
      const candidateContract = input.acceptanceContract ?? goal.acceptanceContract;
      const nextContract = bumpContractVersion(candidateContract, contractVersion(goal.acceptanceContract));
      if (JSON.stringify(nextUserIntent) === JSON.stringify(goal.userIntent)
        && JSON.stringify(nextConstraints) === JSON.stringify(goal.constraints)
        && JSON.stringify(nextContract) === JSON.stringify(goal.acceptanceContract)) {
        throw new Error('direction update has no effective change');
      }
      this.db.prepare('UPDATE goals SET user_intent = ?, constraints_json = ?, acceptance_json = ?, version = version + 1 WHERE id = ?').run(
        nextUserIntent, JSON.stringify(nextConstraints), JSON.stringify(nextContract), goalId);
      this.event('goal', goalId, 'GOAL_DIRECTION_UPDATED', {
        fromContractVersion: contractVersion(goal.acceptanceContract), toContractVersion: contractVersion(nextContract), reason: input.reason ?? 'direction update'
      });
      return this.getGoal(goalId)!;
    });
  }

  transitionGoal(id: string, to: GoalStatus, context?: GoalTransitionContext): Goal {
    return this.transaction(() => {
      const goal = this.getGoal(id);
      if (!goal) throw new Error(`Goal 不存在: ${id}`);
      assertGoalTransition(goal.status, to);
      this.assertGoalTransitionFacts(goal, to, context);
      this.db.prepare('UPDATE goals SET status = ?, version = version + 1 WHERE id = ?').run(to, id);
      this.event('goal', id, 'GOAL_STATUS_CHANGED', { from: goal.status, to, ...(context ? { context } : {}) });
      return this.getGoal(id)!;
    });
  }

  transitionGoalWithLease(id: string, to: GoalStatus, resourceId: string, owner: string, now = Date.now(), context?: GoalTransitionContext): Goal {
    return this.transaction(() => {
      this.assertLeaseInTransaction(resourceId, owner, now);
      const resource = this.getWorkItem(resourceId);
      if (!resource || resource.goalId !== id) throw new Error('lease resource does not belong to goal');
      const goal = this.getGoal(id);
      if (!goal) throw new Error(`Goal 不存在: ${id}`);
      assertGoalTransition(goal.status, to);
      this.assertGoalTransitionFacts(goal, to, context);
      this.db.prepare('UPDATE goals SET status = ?, version = version + 1 WHERE id = ?').run(to, id);
      this.event('goal', id, 'GOAL_STATUS_CHANGED', { from: goal.status, to, owner, ...(context ? { context } : {}) });
      return this.getGoal(id)!;
    });
  }

  private assertGoalTransitionFacts(goal: Goal, to: GoalStatus, context?: GoalTransitionContext): void {
    if (to === 'VERIFYING' || to === 'DELIVERING') {
      const workItems = this.listWorkItems(goal.id);
      if (workItems.some(item => item.status !== 'SUCCEEDED' && item.status !== 'BLOCKED')) {
        throw new Error(`Goal requires all WorkItems to be terminal before ${to}`);
      }
    }
    if (to === 'PAUSED_BUDGET') {
      const limit = goal.budget && typeof goal.budget === 'object' && !Array.isArray(goal.budget)
        ? Number((goal.budget as Record<string, unknown>).limit)
        : Number.NaN;
      if (!Number.isFinite(limit) || limit < 0 || this.reservedBudget(goal.id) < limit) {
        throw new Error('Goal requires exhausted budget before PAUSED_BUDGET');
      }
    }
    if (to === 'CLOSED_UNACHIEVABLE') {
      const reason = context?.reason?.trim();
      const diagnostic = context?.diagnostic;
      const hasDiagnostic = (typeof diagnostic === 'string' && diagnostic.trim().length > 0)
        || (typeof diagnostic === 'object' && diagnostic !== null && Object.keys(diagnostic).length > 0);
      if (goal.status !== 'FAILED' || !reason || !hasDiagnostic) throw new Error('Goal closure requires FAILED status, reason, and diagnostic');
    }
    const openRequests = this.db.prepare("SELECT COUNT(*) AS count FROM human_requests WHERE goal_id = ? AND status = 'OPEN'").get(goal.id) as Record<string, unknown>;
    if (to === 'WAITING_HUMAN' && Number(openRequests.count) < 1) throw new Error('Goal requires an OPEN HumanRequest before WAITING_HUMAN');
    if (to === 'RUNNING' && goal.status === 'WAITING_HUMAN' && Number(openRequests.count) > 0) throw new Error('Goal has OPEN HumanRequests');
    const operations = this.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE goal_id = ? AND reconciliation_status IN ('PENDING', 'UNKNOWN')").get(goal.id) as Record<string, unknown>;
    if (to === 'WAITING_EXTERNAL' && Number(operations.count) < 1) throw new Error('Goal requires a PENDING or UNKNOWN Operation before WAITING_EXTERNAL');
    if (to === 'RUNNING' && goal.status === 'WAITING_EXTERNAL' && Number(operations.count) > 0) throw new Error('Goal has pending external Operations');
    if (to === 'RECOVERING') {
      const ids = this.listWorkItems(goal.id).map(item => item.id);
      if (!this.hasRecoverableAttempt(ids, Date.now())) throw new Error('Goal requires a recoverable Attempt before RECOVERING');
    }
  }

  private hasRecoverableAttempt(workItemIds: string[], now: number): boolean {
    if (workItemIds.length === 0) return false;
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM attempts a WHERE a.ended_at IS NULL AND a.work_item_id IN (${workItemIds.map(() => '?').join(',')}) AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.resource_id = a.work_item_id AND l.revoked = 0 AND l.expires_at > ?)`).get(...workItemIds, now) as Record<string, unknown>;
    return Number(row.count) > 0;
  }

  createWorkItem(input: Pick<WorkItem, 'id' | 'goalId' | 'description' | 'dependencies'>): WorkItem {
    return this.transaction(() => {
      const goal = this.getGoal(input.goalId);
      if (!goal) throw new Error(`Goal 不存在: ${input.goalId}`);
      assertGoalMutable(goal);
      for (const dependencyId of input.dependencies) {
        const dependency = this.getWorkItem(dependencyId);
        if (!dependency) throw new Error(`WorkItem dependency does not exist: ${input.id} -> ${dependencyId}`);
        if (dependency.goalId !== input.goalId) throw new Error(`WorkItem dependency crosses Goal: ${input.id} -> ${dependencyId}`);
      }
      this.db.prepare(`INSERT INTO work_items VALUES (?, ?, ?, ?, 'PENDING', 0)`).run(
        input.id, input.goalId, input.description, JSON.stringify(input.dependencies));
      this.event('work_item', input.id, 'WORK_ITEM_CREATED', { goalId: input.goalId });
      return this.getWorkItem(input.id)!;
    });
  }

  transitionWorkItem(id: string, to: WorkItemStatus): WorkItem {
    return this.transaction(() => {
      const item = this.getWorkItem(id);
      if (!item) throw new Error(`WorkItem 不存在: ${id}`);
      if (to === 'RUNNING') this.assertDependenciesReady(item);
      assertWorkItemTransition(item.status, to);
      this.db.prepare('UPDATE work_items SET status = ?, attempt_count = attempt_count + ? WHERE id = ?').run(to, to === 'RUNNING' ? 1 : 0, id);
      this.event('work_item', id, 'WORK_ITEM_STATUS_CHANGED', { from: item.status, to });
      return this.getWorkItem(id)!;
    });
  }

  transitionWorkItemWithLease(id: string, to: WorkItemStatus, resourceId: string, owner: string, now = Date.now()): WorkItem {
    return this.transaction(() => {
      if (resourceId !== id) throw new Error('lease resource does not match work item');
      const lease = this.db.prepare('SELECT * FROM leases WHERE resource_id = ?').get(resourceId) as Record<string, unknown> | undefined;
      if (!lease || lease.owner !== owner || Number(lease.revoked) !== 0 || Number(lease.expires_at) <= now) throw new Error('lease is not writable');
      const item = this.getWorkItem(id);
      if (!item) throw new Error(`WorkItem 不存在: ${id}`);
      if (to === 'RUNNING') this.assertDependenciesReady(item);
      assertWorkItemTransition(item.status, to);
      this.db.prepare('UPDATE work_items SET status = ?, attempt_count = attempt_count + ? WHERE id = ?').run(to, to === 'RUNNING' ? 1 : 0, id);
      this.event('work_item', id, 'WORK_ITEM_STATUS_CHANGED', { from: item.status, to, owner });
      return this.getWorkItem(id)!;
    });
  }

  transitionWorkItemWithLeaseAndGoalVersions(id: string, to: WorkItemStatus, resourceId: string, owner: string, goalId: string, contractVersion?: string, policyVersion?: string, now = Date.now()): WorkItem {
    return this.transaction(() => {
      if (resourceId !== id) throw new Error('lease resource does not match work item');
      this.assertLeaseInTransaction(resourceId, owner, now);
      const item = this.getWorkItem(id);
      if (!item || item.goalId !== goalId) throw new Error('work item goal does not match');
      const goal = this.getGoal(goalId);
      if (!goal) throw new Error(`Goal 不存在: ${goalId}`);
      if (contractVersion !== undefined && versionString(goal.acceptanceContract) !== contractVersion) throw new Error('acceptance contract version changed');
      if (policyVersion !== undefined && (goal.authorizationPolicy as { version?: unknown }).version !== policyVersion) throw new Error('authorization policy version changed');
      if (to === 'RUNNING') this.assertDependenciesReady(item);
      assertWorkItemTransition(item.status, to);
      this.db.prepare('UPDATE work_items SET status = ?, attempt_count = attempt_count + ? WHERE id = ?').run(to, to === 'RUNNING' ? 1 : 0, id);
      this.event('work_item', id, 'WORK_ITEM_STATUS_CHANGED', { from: item.status, to, owner });
      return this.getWorkItem(id)!;
    });
  }

  /** Atomically closes an Attempt and applies its terminal WorkItem state. */
  finishAttemptAndTransitionWorkItemWithLeaseAndGoalVersions(
    attemptId: string, result: unknown, endedAt: string, to: 'SUCCEEDED' | 'FAILED',
    resourceId: string, owner: string, goalId: string, contractVersion?: string, policyVersion?: string, now = Date.now()
  ): WorkItem {
    return this.transaction(() => {
      if (resourceId !== this.getAttempt(attemptId)?.workItemId) throw new Error('attempt is not bound to lease resource');
      this.assertLeaseInTransaction(resourceId, owner, now);
      const attemptRow = this.db.prepare('SELECT work_item_id FROM attempts WHERE id = ? AND ended_at IS NULL').get(attemptId) as Record<string, unknown> | undefined;
      if (!attemptRow) throw new Error(`Attempt 不存在或已结束: ${attemptId}`);
      const item = this.getWorkItem(resourceId);
      if (!item || item.goalId !== goalId) throw new Error('work item goal does not match');
      const goal = this.getGoal(goalId);
      if (!goal) throw new Error(`Goal 不存在: ${goalId}`);
      if (contractVersion !== undefined && versionString(goal.acceptanceContract) !== contractVersion) throw new Error('acceptance contract version changed');
      if (policyVersion !== undefined && (goal.authorizationPolicy as { version?: unknown }).version !== policyVersion) throw new Error('authorization policy version changed');
      assertWorkItemTransition(item.status, to);
      const finished = this.db.prepare('UPDATE attempts SET result_json = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL').run(JSON.stringify(result), endedAt, attemptId);
      if (finished.changes !== 1) throw new Error(`Attempt 不存在或已结束: ${attemptId}`);
      this.event('attempt', attemptId, 'ATTEMPT_FINISHED', { endedAt });
      this.db.prepare('UPDATE work_items SET status = ? WHERE id = ?').run(to, resourceId);
      this.event('work_item', resourceId, 'WORK_ITEM_STATUS_CHANGED', { from: item.status, to, owner });
      return this.getWorkItem(resourceId)!;
    });
  }

  getWorkItem(id: string): WorkItem | undefined {
    const row = this.db.prepare('SELECT * FROM work_items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { id: row.id as string, goalId: row.goal_id as string, description: row.description as string,
      dependencies: JSON.parse(row.dependencies_json as string), status: row.status as WorkItemStatus, attemptCount: row.attempt_count as number };
  }

  private assertDependenciesReady(item: WorkItem): void {
    for (const dependencyId of item.dependencies) {
      const dependency = this.getWorkItem(dependencyId);
      if (!dependency) throw new Error(`WorkItem dependency does not exist: ${item.id} -> ${dependencyId}`);
      if (dependency.goalId !== item.goalId) throw new Error(`WorkItem dependency crosses Goal: ${item.id} -> ${dependencyId}`);
      if (dependency.status !== 'SUCCEEDED') throw new Error(`WorkItem dependency is not complete: ${item.id} -> ${dependencyId} (${dependency.status})`);
    }
  }

  recordAttempt(input: Attempt): Attempt {
    return this.transaction(() => {
      const workItem = this.getWorkItem(input.workItemId);
      if (!workItem) throw new Error(`WorkItem 不存在: ${input.workItemId}`);
      if (workItem.status === 'SUCCEEDED' || workItem.status === 'BLOCKED') throw new Error(`WorkItem cannot record Attempt from ${workItem.status}`);
      if (input.endedAt === undefined && this.hasActiveAttempt(input.workItemId)) throw new Error(`WorkItem already has an active Attempt: ${input.workItemId}`);
      this.db.prepare(`INSERT INTO attempts(id, work_item_id, base_revision, workspace_id, agent, result_json, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.id, input.workItemId, input.baseRevision, input.workspaceId, input.agent, input.result === undefined ? null : JSON.stringify(input.result), input.startedAt, input.endedAt ?? null);
      this.event('attempt', input.id, 'ATTEMPT_RECORDED', { workItemId: input.workItemId });
      return input;
    });
  }

  startAttempt(input: Omit<Attempt, 'endedAt' | 'result'>, lease?: { resourceId: string; owner: string; now?: number }): Attempt {
    return this.transaction(() => {
      const workItem = this.getWorkItem(input.workItemId);
      if (!workItem) throw new Error(`WorkItem 不存在: ${input.workItemId}`);
      if (workItem.status === 'SUCCEEDED' || workItem.status === 'BLOCKED') throw new Error(`WorkItem cannot start Attempt from ${workItem.status}`);
      if (lease) {
        this.assertLeaseInTransaction(lease.resourceId, lease.owner, lease.now ?? Date.now());
        if (input.workItemId !== lease.resourceId) throw new Error('attempt is not bound to lease resource');
      }
      if (this.hasActiveAttempt(input.workItemId)) throw new Error(`WorkItem already has an active Attempt: ${input.workItemId}`);
      this.db.prepare(`INSERT INTO attempts(id, work_item_id, base_revision, workspace_id, agent, result_json, started_at, ended_at) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`).run(input.id, input.workItemId, input.baseRevision, input.workspaceId, input.agent, input.startedAt);
      this.event('attempt', input.id, 'ATTEMPT_STARTED', { workItemId: input.workItemId });
      return input;
    });
  }

  private hasActiveAttempt(workItemId: string): boolean {
    const row = this.db.prepare('SELECT 1 AS present FROM attempts WHERE work_item_id = ? AND ended_at IS NULL LIMIT 1').get(workItemId) as Record<string, unknown> | undefined;
    return row !== undefined;
  }

  finishAttempt(id: string, result: unknown, endedAt = new Date().toISOString(), lease?: { resourceId: string; owner: string; now?: number }): Attempt {
    return this.transaction(() => {
      const attemptRow = this.db.prepare('SELECT work_item_id FROM attempts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!attemptRow) throw new Error(`Attempt 不存在或已结束: ${id}`);
      const workItem = this.getWorkItem(String(attemptRow.work_item_id));
      if (!workItem) throw new Error(`WorkItem 不存在: ${String(attemptRow.work_item_id)}`);
      if (workItem.status === 'SUCCEEDED' || workItem.status === 'BLOCKED') {
        throw new Error(`Attempt cannot finish after WorkItem ${workItem.status}: ${id}`);
      }
      if (lease) {
        this.assertLeaseInTransaction(lease.resourceId, lease.owner, lease.now ?? Date.now());
        if (String(attemptRow.work_item_id) !== lease.resourceId) throw new Error('attempt is not bound to lease resource');
      }
      const changed = this.db.prepare('UPDATE attempts SET result_json = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL').run(JSON.stringify(result), endedAt, id);
      if (changed.changes !== 1) throw new Error(`Attempt 不存在或已结束: ${id}`);
      this.event('attempt', id, 'ATTEMPT_FINISHED', { endedAt });
      return this.getAttempt(id)!;
    });
  }

  getAttempt(id: string): Attempt | undefined {
    const row = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
    if (!row) return undefined;
    return { id: String(row.id), workItemId: String(row.work_item_id), baseRevision: String(row.base_revision),
      workspaceId: String(row.workspace_id), agent: String(row.agent), startedAt: row.started_at === null ? '' : String(row.started_at),
      endedAt: row.ended_at === null ? undefined : String(row.ended_at),
      result: row.result_json === null ? undefined : JSON.parse(String(row.result_json)) };
  }

  listAttempts(workItemId?: string): Attempt[] {
    const rows = (workItemId
      ? this.db.prepare('SELECT * FROM attempts WHERE work_item_id = ? ORDER BY id').all(workItemId)
      : this.db.prepare('SELECT * FROM attempts ORDER BY id').all()) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: String(row.id), workItemId: String(row.work_item_id), baseRevision: String(row.base_revision),
      workspaceId: String(row.workspace_id), agent: String(row.agent), startedAt: row.started_at === null ? '' : String(row.started_at),
      endedAt: row.ended_at === null ? undefined : String(row.ended_at), result: row.result_json === null ? undefined : JSON.parse(String(row.result_json)) }));
  }

  recordEvidence(input: Evidence): Evidence {
    return this.transaction(() => {
      if (input.workItemId !== undefined) {
        const item = this.getWorkItem(input.workItemId);
        if (!item) throw new Error(`WorkItem 不存在: ${input.workItemId}`);
        const goal = this.getGoal(item.goalId);
        if (goal) assertGoalMutable(goal);
        const currentVersion = versionString(goal?.acceptanceContract);
        if (currentVersion !== undefined && input.contractVersion !== currentVersion) throw new Error('acceptance contract version changed');
      }
      this.db.prepare(`INSERT INTO evidence(id, work_item_id, requirement_id, contract_version, candidate_digest, check_definition_digest, environment_fingerprint, input_digest, status, raw_artifact_refs_json, observed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.id, input.workItemId ?? null, input.requirementId, input.contractVersion, input.candidateDigest, input.checkDefinitionDigest, input.environmentFingerprint,
        input.inputDigest, input.status, JSON.stringify(input.rawArtifactRefs), input.observedAt, input.expiresAt ?? null);
      this.event('evidence', input.id, 'EVIDENCE_RECORDED', { status: input.status, candidateDigest: input.candidateDigest });
      return input;
    });
  }

  recordEvidenceWithLease(input: Evidence, resourceId: string, owner: string, now = Date.now(), expected?: { goalId?: string; contractVersion?: string; policyVersion?: string }): Evidence {
    return this.transaction(() => {
      this.assertLeaseInTransaction(resourceId, owner, now);
      if (input.workItemId !== undefined && input.workItemId !== resourceId) throw new Error('evidence work item does not match lease resource');
      const workItem = this.getWorkItem(resourceId);
      if (!workItem) throw new Error(`WorkItem 不存在: ${resourceId}`);
      const goal = this.getGoal(workItem.goalId);
      if (!goal || (expected?.goalId !== undefined && goal.id !== expected.goalId)) throw new Error('evidence goal does not match expected goal');
      assertGoalMutable(goal);
      if (expected?.contractVersion !== undefined && versionString(goal.acceptanceContract) !== expected.contractVersion) throw new Error('acceptance contract version changed');
      if (expected?.policyVersion !== undefined && (goal.authorizationPolicy as { version?: unknown }).version !== expected.policyVersion) throw new Error('authorization policy version changed');
      if (!input.id.startsWith(`${resourceId}:`)) throw new Error('evidence is not bound to lease resource');
      this.db.prepare(`INSERT INTO evidence(id, work_item_id, requirement_id, contract_version, candidate_digest, check_definition_digest, environment_fingerprint, input_digest, status, raw_artifact_refs_json, observed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, resourceId, input.requirementId, input.contractVersion, input.candidateDigest, input.checkDefinitionDigest, input.environmentFingerprint, input.inputDigest, input.status, JSON.stringify(input.rawArtifactRefs), input.observedAt, input.expiresAt ?? null);
      this.event('evidence', input.id, 'EVIDENCE_RECORDED', { status: input.status, candidateDigest: input.candidateDigest, owner });
      return { ...input, workItemId: resourceId };
    });
  }

  createOperation(input: Operation): Operation {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM operations WHERE idempotency_key = ?').get(input.idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        if (existing.exact_revision !== input.exactRevision || existing.intended_target !== input.intendedTarget || (input.goalId !== undefined && (existing.goal_id === null || existing.goal_id !== input.goalId)) || (input.targetRef !== undefined && (existing.target_ref === null || existing.target_ref !== input.targetRef))) throw new Error(`幂等键已绑定不同操作: ${input.idempotencyKey}`);
        return this.operationFromRow(existing);
      }
      if (input.goalId !== undefined) {
        const goal = this.getGoal(input.goalId);
        if (!goal) throw new Error(`Goal 不存在: ${input.goalId}`);
        assertGoalMutable(goal);
      }
      this.db.prepare('INSERT INTO operations(action_id, idempotency_key, exact_revision, intended_target, goal_id, target_ref, merge_idempotency_key, reconciliation_status, push_receipt_json, external_receipt_json, merge_receipt_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)').run(input.actionId, input.idempotencyKey, input.exactRevision, input.intendedTarget, input.goalId ?? null, input.targetRef ?? null, input.mergeIdempotencyKey ?? null, input.reconciliationStatus);
      this.event('operation', input.actionId, 'OPERATION_INTENT_RECORDED', { idempotencyKey: input.idempotencyKey });
      return input;
    });
  }

  private operationFromRow(row: Record<string, unknown>): Operation {
    return {
      actionId: String(row.action_id), idempotencyKey: String(row.idempotency_key), exactRevision: String(row.exact_revision), intendedTarget: String(row.intended_target),
      goalId: row.goal_id === null ? undefined : String(row.goal_id), targetRef: row.target_ref === null ? undefined : String(row.target_ref),
      mergeIdempotencyKey: row.merge_idempotency_key === null || row.merge_idempotency_key === undefined ? undefined : String(row.merge_idempotency_key),
      reconciliationStatus: row.reconciliation_status as Operation['reconciliationStatus'],
      pushReceipt: row.push_receipt_json === null ? undefined : JSON.parse(String(row.push_receipt_json)),
      externalReceipt: row.external_receipt_json === null ? undefined : JSON.parse(String(row.external_receipt_json)),
      mergeReceipt: row.merge_receipt_json === null ? undefined : JSON.parse(String(row.merge_receipt_json))
    };
  }

  updateOperationPushReceipt(actionId: string, receipt: unknown): Operation {
    if (receipt === undefined) throw new Error('push receipt is required');
    return this.transaction(() => {
      const operation = this.getOperation(actionId);
      if (!operation) throw new Error(`Operation 不存在: ${actionId}`);
      if (operation.reconciliationStatus === 'SUCCEEDED' || operation.reconciliationStatus === 'FAILED') {
        throw new Error(`Operation cannot be updated from ${operation.reconciliationStatus}`);
      }
      const result = this.db.prepare('UPDATE operations SET push_receipt_json = ? WHERE action_id = ?').run(JSON.stringify(receipt), actionId);
      if (result.changes !== 1) throw new Error(`Operation 不存在: ${actionId}`);
      this.event('operation', actionId, 'PUSH_RECONCILED', { receipt });
      return this.getOperation(actionId)!;
    });
  }

  updateOperationReceipt(actionId: string, receipt: unknown, status: Operation['reconciliationStatus']): Operation {
    if (receipt === undefined) throw new Error('external receipt is required');
    return this.transaction(() => {
      const operation = this.getOperation(actionId);
      if (!operation) throw new Error(`Operation 不存在: ${actionId}`);
      assertOperationReconciliationTransition(operation.reconciliationStatus, status);
      const result = this.db.prepare('UPDATE operations SET external_receipt_json = ?, reconciliation_status = ? WHERE action_id = ?').run(JSON.stringify(receipt), status, actionId);
      if (result.changes !== 1) throw new Error(`Operation 不存在: ${actionId}`);
      this.event('operation', actionId, 'OPERATION_RECONCILED', { status, receipt });
      const row = this.db.prepare('SELECT * FROM operations WHERE action_id = ?').get(actionId) as Record<string, unknown>;
      return this.operationFromRow(row);
    });
  }

  updateOperationMergeReceipt(actionId: string, receipt: unknown): Operation {
    if (receipt === undefined) throw new Error('merge receipt is required');
    return this.transaction(() => {
      const operation = this.getOperation(actionId);
      if (!operation) throw new Error(`Operation 不存在: ${actionId}`);
      assertOperationReconciliationTransition(operation.reconciliationStatus, 'SUCCEEDED');
      const result = this.db.prepare("UPDATE operations SET merge_receipt_json = ?, reconciliation_status = 'SUCCEEDED' WHERE action_id = ?").run(JSON.stringify(receipt), actionId);
      if (result.changes !== 1) throw new Error(`Operation 不存在: ${actionId}`);
      this.event('operation', actionId, 'MERGE_RECONCILED', { receipt });
      return this.getOperation(actionId)!;
    });
  }

  setOperationMergeIdempotencyKey(actionId: string, key: string): Operation {
    if (!key.trim()) throw new Error('merge idempotency key is required');
    return this.transaction(() => {
      const operation = this.getOperation(actionId);
      if (!operation) throw new Error(`Operation 不存在: ${actionId}`);
      if (operation.reconciliationStatus === 'SUCCEEDED' || operation.reconciliationStatus === 'FAILED') {
        throw new Error(`Operation cannot be updated from ${operation.reconciliationStatus}`);
      }
      if (operation.mergeIdempotencyKey !== undefined) {
        if (operation.mergeIdempotencyKey !== key) throw new Error(`Operation merge idempotency key mismatch: ${actionId}`);
        return operation;
      }
      const result = this.db.prepare('UPDATE operations SET merge_idempotency_key = ? WHERE action_id = ? AND merge_idempotency_key IS NULL').run(key, actionId);
      if (result.changes !== 1) throw new Error(`Operation merge idempotency key mismatch: ${actionId}`);
      this.event('operation', actionId, 'MERGE_IDEMPOTENCY_KEY_SET', { key });
      return this.getOperation(actionId)!;
    });
  }

  getOperation(actionId: string): Operation | undefined {
    const row = this.db.prepare('SELECT * FROM operations WHERE action_id = ?').get(actionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.operationFromRow(row);
  }

  getOperationByIdempotencyKey(key: string): Operation | undefined {
    const row = this.db.prepare('SELECT * FROM operations WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined;
    return row ? this.operationFromRow(row) : undefined;
  }

  listRecoverableAttempts(workItemIds?: Iterable<string>): Attempt[] {
    const ids = workItemIds ? [...workItemIds] : undefined;
    const rows = (ids ? this.db.prepare(`SELECT * FROM attempts WHERE ended_at IS NULL AND work_item_id IN (${ids.map(() => '?').join(',') || "''"})`).all(...ids) : this.db.prepare('SELECT * FROM attempts WHERE ended_at IS NULL').all()) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: String(row.id), workItemId: String(row.work_item_id), baseRevision: String(row.base_revision), workspaceId: String(row.workspace_id), agent: String(row.agent), startedAt: row.started_at === null ? '' : String(row.started_at), endedAt: undefined, result: row.result_json === null ? undefined : JSON.parse(String(row.result_json)) }));
  }

  listWorkItems(goalId?: string): WorkItem[] {
    const rows = (goalId
      ? this.db.prepare('SELECT * FROM work_items WHERE goal_id = ? ORDER BY id').all(goalId)
      : this.db.prepare('SELECT * FROM work_items ORDER BY id').all()) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: String(row.id), goalId: String(row.goal_id), description: String(row.description), dependencies: JSON.parse(String(row.dependencies_json)), status: row.status as WorkItemStatus, attemptCount: Number(row.attempt_count) }));
  }

  listOperations(): Operation[] {
    return (this.db.prepare('SELECT * FROM operations ORDER BY action_id').all() as Array<Record<string, unknown>>).map(row => this.operationFromRow(row));
  }

  cancelOperation(actionId: string, reason: string): Operation {
    if (!reason.trim()) throw new Error('cancellation reason is required');
    return this.transaction(() => {
      const operation = this.getOperation(actionId);
      if (!operation) throw new Error(`Operation 不存在: ${actionId}`);
      if (operation.reconciliationStatus === 'SUCCEEDED') throw new Error('cannot cancel a succeeded operation');
      if (!['PENDING', 'UNKNOWN'].includes(operation.reconciliationStatus)) throw new Error(`operation cannot be cancelled from ${operation.reconciliationStatus}`);
      this.db.prepare("UPDATE operations SET reconciliation_status = 'FAILED', external_receipt_json = ? WHERE action_id = ? AND reconciliation_status IN ('PENDING', 'UNKNOWN')").run(JSON.stringify({ cancelled: true, reason }), actionId);
      this.event('operation', actionId, 'OPERATION_CANCELLED', { reason });
      return this.getOperation(actionId)!;
    });
  }

  listEvidence(): Evidence[] {
    return (this.db.prepare('SELECT * FROM evidence ORDER BY observed_at, id').all() as Array<Record<string, unknown>>).map(row => ({
      id: String(row.id), workItemId: row.work_item_id === null ? undefined : String(row.work_item_id), requirementId: String(row.requirement_id), contractVersion: String(row.contract_version), candidateDigest: String(row.candidate_digest),
      checkDefinitionDigest: String(row.check_definition_digest), environmentFingerprint: String(row.environment_fingerprint), inputDigest: String(row.input_digest),
      status: row.status as Evidence['status'], rawArtifactRefs: JSON.parse(String(row.raw_artifact_refs_json)), observedAt: String(row.observed_at), expiresAt: row.expires_at === null ? undefined : String(row.expires_at)
    }));
  }

  listEvidenceForGoal(goalId: string): Evidence[] {
    const workItems = this.listWorkItems(goalId);
    const ids = new Set(workItems.map(item => item.id));
    const goal = this.getGoal(goalId);
    const currentVersion = versionString(goal?.acceptanceContract);
    const now = Date.now();
    return this.listEvidence().filter(evidence => {
      if (!(evidence.workItemId !== undefined ? ids.has(evidence.workItemId) : [...ids].some(id => evidence.id.startsWith(`${id}:`)))) return false;
      if (currentVersion !== undefined && evidence.contractVersion !== currentVersion) return false;
      return evidence.expiresAt === undefined || Date.parse(evidence.expiresAt) > now;
    });
  }

  listHumanRequests(goalId?: string): HumanRequest[] {
    const rows = (goalId
      ? this.db.prepare('SELECT * FROM human_requests WHERE goal_id = ? ORDER BY id').all(goalId)
      : this.db.prepare('SELECT * FROM human_requests ORDER BY id').all()) as Array<Record<string, unknown>>;
    return rows.map(row => ({ id: String(row.id), goalId: String(row.goal_id), question: String(row.question), context: JSON.parse(String(row.context_json)), recommendedOptions: row.recommended_options_json === null ? undefined : JSON.parse(String(row.recommended_options_json)), blockingItems: row.blocking_items_json === null ? undefined : JSON.parse(String(row.blocking_items_json)), requiredAuthority: String(row.required_authority), status: row.status as HumanRequest['status'] }));
  }

  listGoalEvents(goalId: string): Array<Record<string, unknown>> {
    const workItems = this.listWorkItems(goalId);
    const workItemIds = new Set(workItems.map(item => item.id));
    const attemptIds = new Set((this.db.prepare(`SELECT id FROM attempts WHERE work_item_id IN (${workItems.map(() => '?').join(',') || "''"})`).all(...workItems.map(item => item.id)) as Array<Record<string, unknown>>).map(row => String(row.id)));
    const humanRequestIds = new Set(this.listHumanRequests(goalId).map(request => request.id));
    const operationIds = new Set(this.listOperations().filter(operation => operation.goalId === goalId).map(operation => operation.actionId));
    // Timeline is an immutable history view: expired or superseded evidence
    // remains linked to the Goal even though listEvidenceForGoal filters it
    // from the current eligibility view.
    const evidenceIds = new Set(this.listEvidence().filter(evidence =>
      evidence.workItemId !== undefined
        ? workItemIds.has(evidence.workItemId)
        : [...workItemIds].some(id => evidence.id.startsWith(`${id}:`))
    ).map(evidence => evidence.id));
    return this.listEvents().filter(row => {
      const type = String(row.entity_type); const id = String(row.entity_id);
      return (type === 'goal' && id === goalId) || (type === 'work_item' && workItemIds.has(id)) || (type === 'attempt' && attemptIds.has(id)) || (type === 'human_request' && humanRequestIds.has(id)) || (type === 'operation' && operationIds.has(id)) || (type === 'evidence' && evidenceIds.has(id));
    });
  }

  reservedBudget(goalId: string): number {
    const row = this.db.prepare('SELECT reserved FROM budget_usage WHERE goal_id = ?').get(goalId) as Record<string, unknown> | undefined;
    return Number(row?.reserved ?? 0);
  }

  recoverInterruptedAttempts(now = new Date().toISOString(), workItemIds?: Iterable<string>): Attempt[] {
    return this.transaction(() => {
      const ids = workItemIds ? [...workItemIds] : undefined;
      const nowMs = Date.parse(now);
      const rows = (ids ? this.db.prepare(`SELECT a.* FROM attempts a WHERE a.ended_at IS NULL AND a.work_item_id IN (${ids.map(() => '?').join(',') || "''"}) AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.resource_id = a.work_item_id AND l.revoked = 0 AND l.expires_at > ?)`).all(...ids, nowMs) : this.db.prepare('SELECT a.* FROM attempts a WHERE a.ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.resource_id = a.work_item_id AND l.revoked = 0 AND l.expires_at > ?)').all(nowMs)) as Array<Record<string, unknown>>;
      const attempts = rows.map(row => ({ id: String(row.id), workItemId: String(row.work_item_id), baseRevision: String(row.base_revision), workspaceId: String(row.workspace_id), agent: String(row.agent), startedAt: row.started_at === null ? '' : String(row.started_at), endedAt: undefined, result: row.result_json === null ? undefined : JSON.parse(String(row.result_json)) }));
      for (const attempt of attempts) {
        this.db.prepare('UPDATE attempts SET ended_at = ?, result_json = ? WHERE id = ? AND ended_at IS NULL').run(now, JSON.stringify({ recovered: true, previousResult: attempt.result }), attempt.id);
        this.event('attempt', attempt.id, 'ATTEMPT_RECOVERED', { recoveredAt: now });
      }
      return attempts;
    });
  }

  reserveBudget(goalId: string, units: number, limit: number): number {
    if (!Number.isFinite(units) || units <= 0 || !Number.isFinite(limit) || limit < 0) throw new Error('invalid budget');
    return this.transaction(() => {
      const goal = this.getGoal(goalId);
      if (!goal) throw new Error(`Goal 不存在: ${goalId}`);
      assertGoalMutable(goal);
      const persistedLimit = goal.budget && typeof goal.budget === 'object' && !Array.isArray(goal.budget)
        ? Number((goal.budget as Record<string, unknown>).limit)
        : Number.NaN;
      const effectiveLimit = Number.isFinite(persistedLimit) && persistedLimit >= 0 ? persistedLimit : limit;
      if (Number.isFinite(persistedLimit) && persistedLimit >= 0 && limit !== persistedLimit) throw new Error('budget limit mismatch');
      const current = this.db.prepare('SELECT reserved FROM budget_usage WHERE goal_id = ?').get(goalId) as Record<string, unknown> | undefined;
      const reserved = Number(current?.reserved ?? 0);
      if (reserved + units > effectiveLimit) throw new Error('budget exhausted');
      const next = reserved + units;
      this.db.prepare('INSERT INTO budget_usage(goal_id, reserved) VALUES (?, ?) ON CONFLICT(goal_id) DO UPDATE SET reserved=excluded.reserved').run(goalId, next);
      this.event('goal', goalId, 'BUDGET_RESERVED', { units, reserved: next, limit: effectiveLimit });
      return next;
    });
  }

  createHumanRequest(input: HumanRequest): HumanRequest {
    return this.transaction(() => {
      if (input.status !== 'OPEN') throw new Error('HumanRequest must start OPEN');
      const goal = this.getGoal(input.goalId);
      if (!goal) throw new Error(`Goal 不存在: ${input.goalId}`);
      assertGoalMutable(goal);
      this.db.prepare('INSERT INTO human_requests(id, goal_id, question, context_json, recommended_options_json, blocking_items_json, required_authority, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(input.id, input.goalId, input.question, JSON.stringify(input.context), input.recommendedOptions === undefined ? null : JSON.stringify(input.recommendedOptions), input.blockingItems === undefined ? null : JSON.stringify(input.blockingItems), input.requiredAuthority, input.status);
      this.event('human_request', input.id, 'HUMAN_REQUEST_CREATED', { goalId: input.goalId });
      return input;
    });
  }

  createHumanRequestAndPause(input: HumanRequest): HumanRequest {
    return this.transaction(() => {
      const goal = this.getGoal(input.goalId);
      if (!goal) throw new Error(`Goal 不存在: ${input.goalId}`);
      if (input.status !== 'OPEN') throw new Error('paused human request must be OPEN');
      if (!['RUNNING', 'WAITING_HUMAN'].includes(goal.status)) throw new Error(`Goal cannot wait for human from ${goal.status}`);
      if (goal.status === 'RUNNING') {
        assertGoalTransition(goal.status, 'WAITING_HUMAN');
        this.db.prepare('UPDATE goals SET status = ?, version = version + 1 WHERE id = ?').run('WAITING_HUMAN', input.goalId);
        this.event('goal', input.goalId, 'GOAL_STATUS_CHANGED', { from: goal.status, to: 'WAITING_HUMAN' });
      }
      this.db.prepare('INSERT INTO human_requests(id, goal_id, question, context_json, recommended_options_json, blocking_items_json, required_authority, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(input.id, input.goalId, input.question, JSON.stringify(input.context), input.recommendedOptions === undefined ? null : JSON.stringify(input.recommendedOptions), input.blockingItems === undefined ? null : JSON.stringify(input.blockingItems), input.requiredAuthority, input.status);
      this.event('human_request', input.id, 'HUMAN_REQUEST_CREATED', { goalId: input.goalId });
      return input;
    });
  }

  getHumanRequest(id: string): HumanRequest | undefined {
    const row = this.db.prepare('SELECT * FROM human_requests WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { id: row.id as string, goalId: row.goal_id as string, question: row.question as string, context: JSON.parse(row.context_json as string), recommendedOptions: row.recommended_options_json === null ? undefined : JSON.parse(String(row.recommended_options_json)), blockingItems: row.blocking_items_json === null ? undefined : JSON.parse(String(row.blocking_items_json)), requiredAuthority: row.required_authority as string, status: row.status as HumanRequest['status'] };
  }

  answerHumanRequest(id: string, answer: unknown): HumanRequest {
    return this.transaction(() => {
      const request = this.getHumanRequest(id);
      if (!request) throw new Error(`HumanRequest 不存在: ${id}`);
      if (request.status !== 'OPEN') throw new Error(`HumanRequest 已关闭: ${id}`);
      const result = this.db.prepare("UPDATE human_requests SET status = ?, context_json = ? WHERE id = ? AND status = 'OPEN'").run('ANSWERED', JSON.stringify({ ...request.context as Record<string, unknown>, answer }), id);
      if (result.changes !== 1) throw new Error(`HumanRequest 已关闭: ${id}`);
      this.event('human_request', id, 'HUMAN_REQUEST_ANSWERED', { answer });
      const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM human_requests WHERE goal_id = ? AND status = 'OPEN'").get(request.goalId) as Record<string, unknown>;
      if (Number(remaining.count) === 0) {
        const goal = this.getGoal(request.goalId);
        if (goal?.status === 'WAITING_HUMAN') {
          assertGoalTransition(goal.status, 'RUNNING');
          this.db.prepare('UPDATE goals SET status = ?, version = version + 1 WHERE id = ?').run('RUNNING', request.goalId);
          this.event('goal', request.goalId, 'GOAL_STATUS_CHANGED', { from: goal.status, to: 'RUNNING', resumedBy: id });
        }
      }
      return this.getHumanRequest(id)!;
    });
  }

  listEvents(entityId?: string): Array<Record<string, unknown>> {
    const sql = entityId ? 'SELECT * FROM events WHERE entity_id = ? ORDER BY sequence' : 'SELECT * FROM events ORDER BY sequence';
    return (entityId ? this.db.prepare(sql).all(entityId) : this.db.prepare(sql).all()) as Array<Record<string, unknown>>;
  }

  acquireLease(resourceId: string, owner: string, ttlMs: number, now = Date.now()): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('invalid lease ttl');
    this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM leases WHERE resource_id = ?').get(resourceId) as Record<string, unknown> | undefined;
      if (existing && Number(existing.revoked) === 0 && Number(existing.expires_at) > now && existing.owner !== owner) throw new LeaseConflictError(resourceId);
      this.db.prepare(`INSERT INTO leases(resource_id, owner, expires_at, revoked) VALUES (?, ?, ?, 0) ON CONFLICT(resource_id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at, revoked=0`).run(resourceId, owner, now + ttlMs);
      this.event('lease', resourceId, 'LEASE_ACQUIRED', { owner, expiresAt: now + ttlMs });
    });
  }

  renewLease(resourceId: string, owner: string, ttlMs: number, now = Date.now()): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('invalid lease ttl');
    this.transaction(() => {
      this.assertLeaseInTransaction(resourceId, owner, now);
      this.db.prepare('UPDATE leases SET expires_at = ? WHERE resource_id = ? AND owner = ?').run(now + ttlMs, resourceId, owner);
      this.event('lease', resourceId, 'LEASE_RENEWED', { owner, expiresAt: now + ttlMs });
    });
  }

  revokeLease(resourceId: string, owner: string): void {
    this.transaction(() => {
      const lease = this.db.prepare('SELECT owner FROM leases WHERE resource_id = ?').get(resourceId) as Record<string, unknown> | undefined;
      if (!lease || lease.owner !== owner) throw new Error('lease not owned');
      this.db.prepare('UPDATE leases SET revoked = 1 WHERE resource_id = ?').run(resourceId);
      this.event('lease', resourceId, 'LEASE_REVOKED', { owner });
    });
  }

  assertLease(resourceId: string, owner: string, now = Date.now()): void {
    this.assertLeaseInTransaction(resourceId, owner, now);
  }

  /**
   * Acquire a provider-scoped lease that is safe across Store processes.
   * Each acquisition receives a fresh fencing token. An unexpired lease is
   * never silently replaced, even when requested by the same owner.
   */
  acquireProviderLease(resourceKey: string, owner: string, ttlMs: number, now = Date.now()): ProviderLease {
    this.assertProviderLeaseArguments(resourceKey, owner, ttlMs);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM provider_leases WHERE resource_key = ?').get(resourceKey) as Record<string, unknown> | undefined;
      if (existing && Number(existing.revoked) === 0 && Number(existing.expires_at) > now) {
        throw new Error('provider lease held by another owner');
      }
      const token = randomUUID();
      this.db.prepare(`INSERT INTO provider_leases(resource_key, owner, token, expires_at, revoked)
        VALUES (?, ?, ?, ?, 0)
        ON CONFLICT(resource_key) DO UPDATE SET owner=excluded.owner, token=excluded.token,
          expires_at=excluded.expires_at, revoked=0`).run(resourceKey, owner, token, now + ttlMs);
      this.event('provider_lease', resourceKey, 'PROVIDER_LEASE_ACQUIRED', { owner, token, expiresAt: now + ttlMs });
      return { resourceKey, owner, token, expiresAt: now + ttlMs };
    });
  }

  renewProviderLease(resourceKey: string, token: string, ttlMs: number, now = Date.now()): ProviderLease {
    if (!token.trim()) throw new Error('provider lease token is required');
    this.assertProviderLeaseArguments(resourceKey, 'token-owner', ttlMs);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT owner FROM provider_leases WHERE resource_key = ? AND token = ?').get(resourceKey, token) as Record<string, unknown> | undefined;
      this.assertProviderLeaseInTransaction(resourceKey, token, now);
      const expiresAt = now + ttlMs;
      this.db.prepare('UPDATE provider_leases SET expires_at = ? WHERE resource_key = ? AND token = ?').run(expiresAt, resourceKey, token);
      this.event('provider_lease', resourceKey, 'PROVIDER_LEASE_RENEWED', { owner: row?.owner, token, expiresAt });
      return { resourceKey, owner: String(row?.owner), token, expiresAt };
    });
  }

  releaseProviderLease(resourceKey: string, token: string): void {
    if (!token.trim()) throw new Error('provider lease token is required');
    this.transaction(() => {
      const row = this.db.prepare('SELECT owner FROM provider_leases WHERE resource_key = ? AND token = ?').get(resourceKey, token) as Record<string, unknown> | undefined;
      if (!row) throw new Error('provider lease token is not owned');
      const result = this.db.prepare('UPDATE provider_leases SET revoked = 1 WHERE resource_key = ? AND token = ? AND revoked = 0').run(resourceKey, token);
      if (result.changes !== 1) throw new Error('provider lease is already released');
      this.event('provider_lease', resourceKey, 'PROVIDER_LEASE_RELEASED', { owner: row.owner, token });
    });
  }

  assertProviderLease(resourceKey: string, token: string, now = Date.now()): void {
    this.assertProviderLeaseInTransaction(resourceKey, token, now);
  }

  getProviderLease(resourceKey: string): ProviderLease | undefined {
    const row = this.db.prepare('SELECT * FROM provider_leases WHERE resource_key = ?').get(resourceKey) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { resourceKey, owner: String(row.owner), token: String(row.token), expiresAt: Number(row.expires_at) };
  }

  private assertProviderLeaseArguments(resourceKey: string, owner: string, ttlMs: number): void {
    if (!resourceKey.trim()) throw new Error('provider lease resource key is required');
    if (!owner.trim()) throw new Error('provider lease owner is required');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('invalid provider lease ttl');
  }

  private assertProviderLeaseInTransaction(resourceKey: string, token: string, now: number): void {
    const row = this.db.prepare('SELECT * FROM provider_leases WHERE resource_key = ?').get(resourceKey) as Record<string, unknown> | undefined;
    if (!row || row.token !== token || Number(row.revoked) !== 0 || Number(row.expires_at) <= now) throw new Error('provider lease is not writable');
  }

  private assertLeaseInTransaction(resourceId: string, owner: string, now: number): void {
    const lease = this.db.prepare('SELECT * FROM leases WHERE resource_id = ?').get(resourceId) as Record<string, unknown> | undefined;
    if (!lease || lease.owner !== owner || Number(lease.revoked) !== 0 || Number(lease.expires_at) <= now) throw new Error('lease is not writable');
  }

  nextRetry(workItemId: string, fingerprint: string, maxAttempts: number): { retry: boolean; reason: 'RETRY' | 'NO_PROGRESS' | 'BUDGET_EXHAUSTED' } {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM retry_state WHERE work_item_id = ?').get(workItemId) as Record<string, unknown> | undefined;
      if (row?.last_fingerprint === fingerprint) {
        this.db.prepare('UPDATE retry_state SET last_decision = ? WHERE work_item_id = ?').run('NO_PROGRESS', workItemId);
        this.event('retry', workItemId, 'RETRY_STOPPED', { reason: 'NO_PROGRESS', fingerprint });
        return { retry: false, reason: 'NO_PROGRESS' } as const;
      }
      const attempts = Number(row?.attempts ?? 0) + 1;
      const reason = attempts <= maxAttempts ? 'RETRY' : 'BUDGET_EXHAUSTED';
      this.db.prepare(`INSERT INTO retry_state(work_item_id, attempts, last_fingerprint, last_decision) VALUES (?, ?, ?, ?) ON CONFLICT(work_item_id) DO UPDATE SET attempts=excluded.attempts, last_fingerprint=excluded.last_fingerprint, last_decision=excluded.last_decision`).run(workItemId, attempts, fingerprint, reason);
      this.event('retry', workItemId, reason === 'RETRY' ? 'RETRY_RECORDED' : 'RETRY_STOPPED', { attempts, fingerprint, reason });
      return reason === 'RETRY' ? { retry: true, reason } as const : { retry: false, reason } as const;
    });
  }

  getRetryState(workItemId: string): { attempts: number; fingerprint?: string; decision?: 'RETRY' | 'NO_PROGRESS' | 'BUDGET_EXHAUSTED' } | undefined {
    const row = this.db.prepare('SELECT attempts, last_fingerprint, last_decision FROM retry_state WHERE work_item_id = ?').get(workItemId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const decision = row.last_decision === 'RETRY' || row.last_decision === 'NO_PROGRESS' || row.last_decision === 'BUDGET_EXHAUSTED' ? row.last_decision : undefined;
    return { attempts: Number(row.attempts ?? 0), fingerprint: row.last_fingerprint === null ? undefined : String(row.last_fingerprint), decision };
  }

  close(): void { this.db.close(); }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private event(entityType: string, entityId: string, eventType: string, payload: unknown): void {
    this.db.prepare(`INSERT INTO events(entity_type, entity_id, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)`).run(
      entityType, entityId, eventType, JSON.stringify(payload), new Date().toISOString());
  }
}
