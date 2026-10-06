export type GoalStatus =
  | 'DRAFT' | 'PLANNING' | 'RUNNING' | 'VERIFYING' | 'DELIVERING'
  | 'SUCCEEDED' | 'WAITING_EXTERNAL' | 'WAITING_HUMAN' | 'PAUSED_BUDGET'
  | 'RECOVERING' | 'FAILED' | 'CLOSED_UNACHIEVABLE';

export type WorkItemStatus = 'PENDING' | 'READY' | 'RUNNING' | 'BLOCKED' | 'SUCCEEDED' | 'FAILED';
export const WORK_ITEM_TRANSITIONS: ReadonlySet<string> = new Set([
  'PENDING->READY', 'READY->RUNNING', 'RUNNING->SUCCEEDED', 'RUNNING->FAILED',
  'RUNNING->BLOCKED', 'READY->BLOCKED', 'BLOCKED->READY', 'FAILED->READY'
]);

export function assertWorkItemTransition(from: WorkItemStatus, to: WorkItemStatus): void {
  if (!WORK_ITEM_TRANSITIONS.has(`${from}->${to}`)) throw new Error(`非法 WorkItem 状态迁移: ${from} -> ${to}`);
}

export interface Goal {
  id: string;
  userIntent: string;
  constraints: unknown;
  acceptanceContract: unknown;
  authorizationPolicy: unknown;
  budget: unknown;
  status: GoalStatus;
  version: number;
}

export interface WorkItem {
  id: string;
  goalId: string;
  description: string;
  dependencies: string[];
  status: WorkItemStatus;
  attemptCount: number;
}

export interface Evidence {
  id: string;
  workItemId?: string;
  requirementId: string;
  contractVersion: string;
  candidateDigest: string;
  checkDefinitionDigest: string;
  environmentFingerprint: string;
  inputDigest: string;
  status: 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'ERROR';
  rawArtifactRefs: string[];
  observedAt: string;
  expiresAt?: string;
}

export interface Attempt { id: string; workItemId: string; baseRevision: string; workspaceId: string; agent: string; startedAt: string; endedAt?: string; result?: unknown; }
export interface Candidate { revision: string; changedPaths: string[]; artifactDigest: string; contractVersion: string; }
export interface Operation { actionId: string; idempotencyKey: string; exactRevision: string; intendedTarget: string; goalId?: string; targetRef?: string; mergeIdempotencyKey?: string; reconciliationStatus: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'; pushReceipt?: unknown; externalReceipt?: unknown; mergeReceipt?: unknown; }
export interface HumanRequest { id: string; goalId: string; question: string; context: unknown; recommendedOptions?: unknown[]; blockingItems?: unknown[]; requiredAuthority: string; status: 'OPEN' | 'ANSWERED' | 'CLOSED'; }

export interface StateTransition {
  entity: 'goal' | 'work_item';
  from: string;
  to: string;
}

export const GOAL_TRANSITIONS: ReadonlySet<string> = new Set([
  'DRAFT->PLANNING', 'PLANNING->RUNNING', 'RUNNING->VERIFYING',
  'VERIFYING->RUNNING', 'VERIFYING->DELIVERING', 'DELIVERING->SUCCEEDED',
  'RUNNING->WAITING_EXTERNAL', 'RUNNING->WAITING_HUMAN',
  'RUNNING->PAUSED_BUDGET', 'RUNNING->FAILED', 'FAILED->RUNNING',
  'WAITING_EXTERNAL->RUNNING', 'WAITING_HUMAN->RUNNING',
  'PAUSED_BUDGET->RUNNING', 'RUNNING->RECOVERING', 'RECOVERING->RUNNING',
  'RECOVERING->FAILED', 'FAILED->CLOSED_UNACHIEVABLE'
]);

export function assertGoalTransition(from: GoalStatus, to: GoalStatus): void {
  if (!GOAL_TRANSITIONS.has(`${from}->${to}`)) {
    throw new Error(`非法 Goal 状态迁移: ${from} -> ${to}`);
  }
}
