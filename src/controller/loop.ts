import type { AgentAdapter } from '../agents/types.js';
import type { CheckDefinition } from '../verification/types.js';
import { LeaseConflictError, type Store } from '../storage/database.js';
import { runControllerRound, type ControllerRunResult, WorkItemAlreadyCompletedError } from './controller.js';
import { runFairGoalScheduler, runIndependentWorkItems, type ScheduleResult } from './scheduler.js';
import { classifyFailure, failureFingerprint, type FailureKind } from '../recovery/index.js';
import { recoverGoalAttempts } from '../recovery/orchestrator.js';

export interface ControllerRecoveryContext {
  attempt: number;
  failureKind?: FailureKind;
  strategy?: string;
}

export interface ControllerLoopItemConfig {
  workspace: string;
  contractVersion: string;
  candidateDigest: string;
  environmentFingerprint: string;
  inputDigest: string;
  resolveCandidateDigest?: () => Promise<string>;
  checks: CheckDefinition[];
  qualityProfile?: 'mandatory';
  artifactDir?: string;
  budget: { maxRuns?: number };
  action?: string;
  leaseTtlMs?: number;
  /** Enable persisted retry decisions for Gate failures. */
  recovery?: { maxAttempts: number; strategy?: string };
}

export interface ControllerLoopInput {
  goalId: string;
  maxConcurrency?: number;
  /** Stop after this many executed controller rounds, leaving remaining items skipped. */
  maxRounds?: number;
  /** Optional goal-level leader election for multiple controller processes. */
  leaderElection?: { controllerId: string; leaseTtlMs?: number };
  configure(item: ReturnType<Store['getWorkItem']> & {}, context?: ControllerRecoveryContext): ControllerLoopItemConfig;
  agentFor(item: ReturnType<Store['getWorkItem']> & {}, context?: ControllerRecoveryContext): AgentAdapter;
  strategyFor?(item: ReturnType<Store['getWorkItem']> & {}, failureKind: FailureKind, attempt: number): string | undefined;
}

export interface ControllerLoopResult extends ScheduleResult {
  rounds: number;
  results: Record<string, ControllerRunResult>;
}

export interface ControllerPoolResult {
  completed: string[];
  failed: string[];
  skipped: string[];
  turns: number;
  results: Record<string, ControllerLoopResult>;
}

export class LeaderLeaseLostError extends Error {
  readonly code = 'LEADER_LEASE_LOST';
  constructor(goalId: string) { super(`controller leader lease lost: ${goalId}`); }
}

/** Run one persisted controller round per Goal in fair round-robin order. */
export async function runControllerPool(store: Store, inputs: ControllerLoopInput[], options: { maxConcurrency?: number; maxTurns?: number } = {}): Promise<ControllerPoolResult> {
  const ids = new Set<string>();
  for (const input of inputs) {
    if (ids.has(input.goalId)) throw new Error(`duplicate goal id: ${input.goalId}`);
    ids.add(input.goalId);
  }
  const results: Record<string, ControllerLoopResult> = {};
  const schedule = await runFairGoalScheduler(inputs.map(input => ({
    goalId: input.goalId,
    async step() {
      const result = await runControllerLoop(store, { ...input, maxConcurrency: 1, maxRounds: 1 });
      results[input.goalId] = result;
      const active = store.listWorkItems(input.goalId).some(item => ['PENDING', 'READY', 'RUNNING', 'FAILED'].includes(item.status));
      return { done: !active };
    }
  })), options);
  return { ...schedule, results };
}

/** 持久化工作项之上的滚动主循环；每一项的完成资格仍由独立 verifier/gate 决定。 */
export async function runControllerLoop(store: Store, input: ControllerLoopInput): Promise<ControllerLoopResult> {
  if (input.maxRounds !== undefined && (!Number.isInteger(input.maxRounds) || input.maxRounds < 1)) throw new Error('maxRounds must be a positive integer');
  const currentGoal = store.getGoal(input.goalId);
  if (!currentGoal) throw new Error(`Goal 不存在: ${input.goalId}`);
  if (currentGoal.status !== 'RECOVERING' && !['DRAFT', 'PLANNING', 'RUNNING'].includes(currentGoal.status)) {
    return { completed: [], failed: [], skipped: store.listWorkItems(input.goalId).filter(item => ['PENDING', 'READY', 'RUNNING', 'FAILED'].includes(item.status)).map(item => item.id), rounds: 0, results: {} };
  }
  if (!input.leaderElection) return runControllerLoopOwned(store, input);
  if (!input.leaderElection.controllerId.trim()) throw new Error('leaderElection.controllerId is required');
  const resourceId = `goal-leader:${input.goalId}`;
  const owner = `controller-leader:${input.leaderElection.controllerId}`;
  const ttlMs = input.leaderElection.leaseTtlMs ?? 120_000;
  try {
    store.acquireLease(resourceId, owner, ttlMs);
  } catch (error) {
    if (!(error instanceof LeaseConflictError)) throw error;
    return {
      completed: [],
      failed: [],
      skipped: store.listWorkItems(input.goalId).filter(item => item.status === 'PENDING' || item.status === 'READY' || item.status === 'RUNNING').map(item => item.id),
      rounds: 0,
      results: {}
    };
  }
  let leaderLost = false;
  const heartbeat = setInterval(() => {
    try { store.renewLease(resourceId, owner, ttlMs); } catch { leaderLost = true; }
  }, Math.max(10, Math.floor(ttlMs / 3)));
  heartbeat.unref();
  try {
    const result = await runControllerLoopOwned(store, input, () => {
      if (leaderLost) return false;
      try { store.assertLease(resourceId, owner); return true; } catch { leaderLost = true; return false; }
    });
    if (!leaderLost) {
      try { store.assertLease(resourceId, owner); } catch { leaderLost = true; }
    }
    if (leaderLost) throw new LeaderLeaseLostError(input.goalId);
    return result;
  } finally {
    clearInterval(heartbeat);
    try { store.revokeLease(resourceId, owner); } catch { /* a newer leader may have taken over after expiry */ }
  }
}

async function runControllerLoopOwned(store: Store, input: ControllerLoopInput, leaderGuard?: () => boolean): Promise<ControllerLoopResult> {
  const goal = store.getGoal(input.goalId);
  if (!goal) throw new Error(`Goal 不存在: ${input.goalId}`);
  const recoveryReport = recoverGoalAttempts(store, input.goalId);
  if (goal.status === 'RECOVERING') {
    if (recoveryReport.requeuedWorkItems.length === 0) {
      return { completed: [], failed: [], skipped: store.listWorkItems(input.goalId).filter(item => ['PENDING', 'READY', 'RUNNING', 'FAILED'].includes(item.status)).map(item => item.id), rounds: 0, results: {} };
    }
    store.transitionGoal(input.goalId, 'RUNNING', { reason: 'recovered attempts requeued', diagnostic: { workItems: recoveryReport.requeuedWorkItems } });
  }
  const configured = store.listWorkItems(input.goalId).map(item => {
    if (item.status === 'PENDING') return { ...item, status: 'READY' as const };
    if (item.status === 'FAILED') {
      const retryState = store.getRetryState(item.id);
      const recovery = input.configure(item).recovery;
      if (retryState?.decision === 'RETRY' && recovery && retryState.attempts <= recovery.maxAttempts) {
        store.transitionWorkItem(item.id, 'READY');
        return { ...item, status: 'READY' as const };
      }
    }
    return item;
  }) as Array<ReturnType<Store['getWorkItem']> & { status: 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED' }>;
  const results: Record<string, ControllerRunResult> = {};
  const contended = new Set<string>();
  let rounds = 0;
  const schedule = await runIndependentWorkItems(configured, async item => {
    let recoveryContext: ControllerRecoveryContext = recoveryReport.contexts.get(item.id) ?? { attempt: 1 };
    for (;;) {
      if (input.maxRounds !== undefined && rounds >= input.maxRounds) return { defer: true, stop: true };
      if (leaderGuard && !leaderGuard()) return;
      rounds += 1;
      const currentItem = store.getWorkItem(item.id) ?? item;
      let config = input.configure(currentItem, recoveryContext);
      if (recoveryContext.attempt === 1 && recoveryContext.strategy === undefined && config.recovery?.strategy !== undefined) {
        recoveryContext = { ...recoveryContext, strategy: config.recovery.strategy };
        config = input.configure(currentItem, recoveryContext);
      }
      let result: ControllerRunResult;
      try {
        result = await runControllerRound(store, input.agentFor(currentItem, recoveryContext), { goalId: input.goalId, workItemId: item.id, ...config });
      } catch (error) {
        if (error instanceof WorkItemAlreadyCompletedError) return;
        if (error instanceof LeaseConflictError || (error && typeof error === 'object' && (error as { code?: unknown }).code === 'LEASE_HELD')) {
          contended.add(item.id);
          return;
        }
        throw error;
      }
      if (leaderGuard && !leaderGuard()) return;
      results[item.id] = result;
      if (result.gate.result === 'ALLOW') return;
      if (!config.recovery) throw new Error(`gate ${result.gate.result} for ${item.id}`);
      if (!Number.isInteger(config.recovery.maxAttempts) || config.recovery.maxAttempts < 1) throw new Error('recovery.maxAttempts must be a positive integer');
      const failedCheck = result.verification.find(check => check.status !== 'PASS');
      const failureKind = classifyFailure({
        status: failedCheck?.status ?? result.gate.result,
        stderr: result.verification.map(check => check.stderr).filter(Boolean).join('\n'),
        timedOut: failedCheck?.status === 'INCONCLUSIVE'
      });
      const nextAttempt = recoveryContext.attempt + 1;
      const nextStrategy = input.strategyFor?.(currentItem, failureKind, nextAttempt) ?? config.recovery.strategy;
      recoveryContext = { attempt: nextAttempt, failureKind, strategy: nextStrategy };
      const fingerprint = failureFingerprint({
        strategy: recoveryContext.strategy,
        gate: result.gate,
        agentResult: result.agentResult.result,
        verification: result.verification.map(check => ({ requirementId: check.requirementId, status: check.status, stderr: check.stderr }))
      });
      const decision = store.nextRetry(item.id, fingerprint, config.recovery.maxAttempts);
      if (!decision.retry) throw new Error(`gate ${result.gate.result} for ${item.id}: ${decision.reason}`);
      if (store.getWorkItem(item.id)?.status === 'FAILED') store.transitionWorkItem(item.id, 'READY');
      if (input.maxRounds !== undefined && rounds >= input.maxRounds) return { defer: true, stop: true };
    }
  }, input.maxConcurrency);
  schedule.completed = schedule.completed.filter(id => !contended.has(id));
  schedule.skipped.push(...contended);
  for (const id of schedule.skipped) {
    const item = store.getWorkItem(id);
    if (!item) continue;
    if (contended.has(id)) continue;
    // A bounded round is a cooperative scheduling boundary.  It must leave
    // work that was not selected untouched so a later pool poll can run it.
    if (input.maxRounds !== undefined) continue;
    if (item.status === 'PENDING') store.transitionWorkItem(id, 'READY');
    if (store.getWorkItem(id)?.status === 'READY') store.transitionWorkItem(id, 'BLOCKED');
  }
  return { ...schedule, rounds, results };
}
