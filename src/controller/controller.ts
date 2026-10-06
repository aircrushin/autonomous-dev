import type { CommandExecutor } from '../environments/types.js';
import type { AgentAdapter } from '../agents/types.js';
import type { Store } from '../storage/database.js';
import type { CheckDefinition, VerificationResult } from '../verification/types.js';
import { assertQualityProfile, mandatoryQualityChecks, verifyChecks } from '../verification/runner.js';
import { decideGate, type GateDecision } from '../verification/gate.js';
import { assertAuthorized } from '../policy/authorization.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

export interface ControllerRunInput {
  goalId: string;
  workItemId: string;
  workspace: string;
  contractVersion: string;
  candidateDigest: string;
  environmentFingerprint: string;
  inputDigest: string;
  checks: CheckDefinition[];
  artifactDir?: string;
  verificationExecutor?: CommandExecutor;
  qualityProfile?: 'mandatory';
  /** Resolve the post-agent candidate digest immediately before verification. */
  resolveCandidateDigest?: () => Promise<string>;
  budget: { maxRuns?: number };
  action?: string;
  authorizationPolicyVersion?: string;
  leaseTtlMs?: number;
}

export interface ControllerRunResult { agentResult: Awaited<ReturnType<AgentAdapter['run']>>; verification: VerificationResult[]; gate: GateDecision; resolvedCandidateDigest?: string; }

export class WorkItemAlreadyCompletedError extends Error {
  readonly code = 'WORK_ITEM_COMPLETED';
  constructor(workItemId: string) { super(`work item already completed: ${workItemId}`); }
}

function assertControllerGoalRunnable(status: string): void {
  if (!['DRAFT', 'PLANNING', 'RUNNING'].includes(status)) {
    throw new Error(`Goal is not runnable from ${status}`);
  }
}

function versionOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const version = (value as Record<string, unknown>).version;
  return version === undefined ? undefined : String(version);
}
function checkDependencyDigest(workspace: string, checks: CheckDefinition[]): string {
  const hash = createHash('sha256');
  const files = new Set<string>();
  for (const check of checks) for (const arg of check.command.slice(1)) {
    const path = isAbsolute(arg) ? arg : resolve(workspace, arg);
    try { if (!statSync(path).isFile() || relative(resolve(workspace), resolve(path)).startsWith('..')) continue; files.add(path); } catch { /* command arguments are often flags or inline scripts */ }
  }
  for (const check of checks) {
    const runner = check.command[0]?.split('/').pop();
    if ((runner === 'pnpm' || runner === 'npm' || runner === 'yarn') && check.command.slice(1).includes('test')) {
      files.add(join(workspace, 'package.json'));
      const collectTests = (directory: string, depth = 0): void => {
        if (depth > 8 || files.size > 5000) return;
        try {
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory() && !['node_modules', 'dist', '.git'].includes(entry.name)) collectTests(path, depth + 1);
            else if (entry.isFile() && /\.(?:ts|tsx|js|jsx|mjs|cjs|json|txt)$/.test(entry.name)) files.add(path);
          }
        } catch { /* runner may target a remote workspace without a local tests directory */ }
      };
      collectTests(join(workspace, 'tests'));
    }
  }
  for (const path of [...files].sort()) { try { hash.update(relative(resolve(workspace), resolve(path))).update('\0').update(readFileSync(path)); } catch { /* file may disappear between snapshots */ } }
  return hash.digest('hex');
}

/** 受控的一轮执行：Agent 的自报只作为日志，完成资格由 verifier + gate 决定。 */
export async function runControllerRound(store: Store, agent: AgentAdapter, input: ControllerRunInput): Promise<ControllerRunResult> {
  const checks = [...input.checks];
  const mandatory = mandatoryQualityChecks(input.workspace);
  for (const required of mandatory) {
    const existing = checks.find(check => check.id === required.id);
    if (existing && JSON.stringify(existing.command) !== JSON.stringify(required.command)) throw new Error(`mandatory quality check command mismatch: ${required.id}`);
    if (!existing) checks.push(required);
  }
  assertQualityProfile(input.workspace, checks, 'mandatory');
  const goal = store.getGoal(input.goalId);
  const item = store.getWorkItem(input.workItemId);
  if (!goal || !item || item.goalId !== input.goalId) throw new Error('goal/work item mismatch');
  assertControllerGoalRunnable(goal.status);
  const checkBaseline = checkDependencyDigest(input.workspace, checks);
  const policy = goal.authorizationPolicy as { allowedActions?: string[]; deniedActions?: string[]; version?: string };
  if (input.authorizationPolicyVersion !== undefined && policy.version !== input.authorizationPolicyVersion) throw new Error('authorization policy version changed');
  const initialPolicyVersion = policy.version;
  const initialContractVersion = versionOf(goal.acceptanceContract);
  if (initialContractVersion !== undefined && String(input.contractVersion) !== initialContractVersion) throw new Error('acceptance contract version changed');
  if (input.action) assertAuthorized(policy, input.action);
  const leaseOwner = `controller:${input.workItemId}:${randomUUID()}`;
  const leaseTtlMs = input.leaseTtlMs ?? 120_000;
  store.acquireLease(input.workItemId, leaseOwner, leaseTtlMs);
  const currentItemAfterLease = store.getWorkItem(input.workItemId);
  if (currentItemAfterLease?.status === 'SUCCEEDED') {
    store.revokeLease(input.workItemId, leaseOwner);
    throw new WorkItemAlreadyCompletedError(input.workItemId);
  }
  try {
    if (goal.status === 'DRAFT') store.transitionGoalWithLease(goal.id, 'PLANNING', input.workItemId, leaseOwner);
    if (store.getGoal(goal.id)?.status === 'PLANNING') store.transitionGoalWithLease(goal.id, 'RUNNING', input.workItemId, leaseOwner);
    if (item.status === 'PENDING') store.transitionWorkItemWithLease(item.id, 'READY', input.workItemId, leaseOwner);
    if (store.getWorkItem(item.id)?.status === 'READY') store.transitionWorkItemWithLease(item.id, 'RUNNING', input.workItemId, leaseOwner);
  } catch (error) {
    try { store.revokeLease(input.workItemId, leaseOwner); } catch { /* preserve the original failure */ }
    throw error;
  }
  const startedAt = new Date().toISOString();
  const attemptId = randomUUID();
  try {
    store.startAttempt({ id: attemptId, workItemId: input.workItemId, baseRevision: input.candidateDigest, workspaceId: input.workspace, agent: 'configured-agent', startedAt }, { resourceId: input.workItemId, owner: leaseOwner });
  } catch (error) {
    try { store.revokeLease(input.workItemId, leaseOwner); } catch { /* preserve the original failure */ }
    throw error;
  }
  const heartbeat = setInterval(() => {
    try { store.renewLease(input.workItemId, leaseOwner, leaseTtlMs); } catch { /* final fencing check reports expiry */ }
  }, Math.max(10, Math.floor(leaseTtlMs / 3)));
  heartbeat.unref();
  let agentResult: Awaited<ReturnType<AgentAdapter['run']>>;
  try {
    agentResult = await agent.run({ goal: goal.userIntent, workItem: item.description, workspace: input.workspace, budget: input.budget, completionCriteria: checks.map(check => check.id) });
    if (checkDependencyDigest(input.workspace, checks) !== checkBaseline) throw new Error('verification check dependency changed during execution');
  } catch (error) {
    clearInterval(heartbeat);
    try { if (store.getWorkItem(input.workItemId)?.status === 'RUNNING') store.transitionWorkItemWithLease(input.workItemId, 'FAILED', input.workItemId, leaseOwner); } catch { /* preserve the original agent failure */ }
    try { store.revokeLease(input.workItemId, leaseOwner); } catch { /* preserve the original failure */ }
    throw error;
  }
  const currentAfterAgent = store.getGoal(input.goalId);
  const currentPolicyVersion = (currentAfterAgent?.authorizationPolicy as { version?: string } | undefined)?.version;
  const currentContractVersion = versionOf(currentAfterAgent?.acceptanceContract);
  if (!currentAfterAgent || currentPolicyVersion !== initialPolicyVersion || currentContractVersion !== initialContractVersion) {
    clearInterval(heartbeat);
    try { if (store.getWorkItem(input.workItemId)?.status === 'RUNNING') store.transitionWorkItemWithLease(input.workItemId, 'FAILED', input.workItemId, leaseOwner); } catch { /* preserve version fencing failure */ }
    try { store.revokeLease(input.workItemId, leaseOwner); } catch { /* preserve version fencing failure */ }
    throw new Error('goal policy or acceptance contract changed during execution');
  }
  let resolvedCandidateDigest = input.candidateDigest;
  try {
    store.renewLease(input.workItemId, leaseOwner, leaseTtlMs);
    if (input.resolveCandidateDigest) {
      const candidateDigest = await input.resolveCandidateDigest();
      if (typeof candidateDigest !== 'string' || !candidateDigest.trim()) throw new Error('resolved candidate digest is required');
      resolvedCandidateDigest = candidateDigest.trim();
    }
  } catch (error) {
    clearInterval(heartbeat);
    try { if (store.getWorkItem(input.workItemId)?.status === 'RUNNING') store.transitionWorkItemWithLease(input.workItemId, 'FAILED', input.workItemId, leaseOwner); } catch { /* preserve resolver or fencing failure */ }
    try { store.revokeLease(input.workItemId, leaseOwner); } catch { /* preserve the original failure */ }
    throw error;
  }
  let verification: VerificationResult[];
  try {
    const customChecks = await verifyChecks({ workspace: input.workspace, contractVersion: input.contractVersion, candidateDigest: resolvedCandidateDigest, environmentFingerprint: input.environmentFingerprint, inputDigest: input.inputDigest, checks: input.checks, executor: input.verificationExecutor, artifactDir: input.artifactDir });
    const qualityChecks = await verifyChecks({ workspace: input.workspace, contractVersion: input.contractVersion, candidateDigest: resolvedCandidateDigest, environmentFingerprint: input.environmentFingerprint, inputDigest: input.inputDigest, checks: mandatory, executor: existsSync(input.workspace) ? undefined : input.verificationExecutor, artifactDir: input.artifactDir });
    verification = [...customChecks, ...qualityChecks];
  } catch (error) {
    clearInterval(heartbeat);
    try { store.revokeLease(input.workItemId, leaseOwner); } catch { /* preserve the original verifier failure */ }
    throw error;
  }
  const gate = decideGate(verification);
  if (agentResult.result !== 'SUCCEEDED' && gate.result === 'ALLOW') {
    gate.result = 'REPAIR';
    gate.reasonCodes.push('AGENT_RUN_FAILED');
  }
  try {
    const currentBeforeEvidence = store.getGoal(input.goalId);
    if (!currentBeforeEvidence || (currentBeforeEvidence.authorizationPolicy as { version?: string }).version !== initialPolicyVersion || versionOf(currentBeforeEvidence.acceptanceContract) !== initialContractVersion) {
      throw new Error('goal policy or acceptance contract changed during verification');
    }
    for (const result of verification) store.recordEvidenceWithLease({ id: `${input.workItemId}:${result.requirementId}:${result.observedAt}`, workItemId: input.workItemId, requirementId: result.requirementId, contractVersion: result.contractVersion, candidateDigest: result.candidateDigest, checkDefinitionDigest: result.checkDefinitionDigest, environmentFingerprint: result.environmentFingerprint, inputDigest: result.inputDigest, status: result.status, rawArtifactRefs: result.rawArtifactRefs, observedAt: result.observedAt }, input.workItemId, leaseOwner, Date.now(), { goalId: input.goalId, contractVersion: initialContractVersion, policyVersion: initialPolicyVersion });
    const currentBeforeCommit = store.getGoal(input.goalId);
    if (!currentBeforeCommit || (currentBeforeCommit.authorizationPolicy as { version?: string }).version !== initialPolicyVersion || versionOf(currentBeforeCommit.acceptanceContract) !== initialContractVersion) {
      throw new Error('goal policy or acceptance contract changed before completion');
    }
    if (gate.result === 'ALLOW') {
      store.finishAttemptAndTransitionWorkItemWithLeaseAndGoalVersions(attemptId, agentResult, new Date().toISOString(), 'SUCCEEDED', input.workItemId, leaseOwner, input.goalId, initialContractVersion, initialPolicyVersion);
      const currentGoal = store.getGoal(input.goalId);
      if (currentGoal?.status === 'RUNNING' && store.listWorkItems(input.goalId).every(workItem => workItem.status === 'SUCCEEDED' || workItem.status === 'BLOCKED')) {
        store.transitionGoalWithLease(input.goalId, 'VERIFYING', input.workItemId, leaseOwner);
      }
    } else {
      store.finishAttemptAndTransitionWorkItemWithLeaseAndGoalVersions(attemptId, agentResult, new Date().toISOString(), 'FAILED', input.workItemId, leaseOwner, input.goalId, initialContractVersion, initialPolicyVersion);
    }
    return { agentResult, verification, gate, resolvedCandidateDigest };
  } catch (error) {
    try {
      if (store.getWorkItem(input.workItemId)?.status === 'RUNNING') store.transitionWorkItemWithLease(input.workItemId, 'FAILED', input.workItemId, leaseOwner);
    } catch { /* preserve the fencing or verification failure */ }
    throw error;
  } finally {
    try { store.revokeLease(input.workItemId, leaseOwner); } catch { /* a newer owner may have fenced this run */ }
  }
}
