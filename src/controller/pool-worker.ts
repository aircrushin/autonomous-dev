import type { Store } from '../storage/database.js';
import { runControllerPool, type ControllerLoopInput, type ControllerPoolResult } from './loop.js';

export type PoolWorkerStopReason = 'COMPLETED' | 'FAILED' | 'ABORTED' | 'MAX_TURNS' | 'IDLE_LIMIT';

export interface ControllerPoolWorkerOptions {
  /** Maximum goals advanced across all polls. Defaults to unlimited. */
  maxTurns?: number;
  /** Number of goals advanced concurrently in each poll. */
  maxConcurrency?: number;
  /** Delay between polls when work remains. Defaults to 100 ms. */
  pollIntervalMs?: number;
  /** Stop after this many polls without a state change. Defaults to 3. */
  maxIdlePolls?: number;
  signal?: AbortSignal;
  /** Propagated to each input unless it already has leader election. */
  controllerId?: string;
  leaderLeaseTtlMs?: number;
}

export interface ControllerPoolWorkerResult extends ControllerPoolResult {
  polls: number;
  idlePolls: number;
  stopReason: PoolWorkerStopReason;
}

function validateOptions(options: ControllerPoolWorkerOptions): Required<Pick<ControllerPoolWorkerOptions, 'pollIntervalMs' | 'maxIdlePolls'>> {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const maxIdlePolls = options.maxIdlePolls ?? 3;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0) throw new Error('pollIntervalMs must be a non-negative integer');
  if (!Number.isInteger(maxIdlePolls) || maxIdlePolls < 1) throw new Error('maxIdlePolls must be a positive integer');
  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)) throw new Error('maxTurns must be a positive integer');
  if (options.maxConcurrency !== undefined && (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1)) throw new Error('maxConcurrency must be a positive integer');
  if (options.leaderLeaseTtlMs !== undefined && (!Number.isInteger(options.leaderLeaseTtlMs) || options.leaderLeaseTtlMs < 1)) throw new Error('leaderLeaseTtlMs must be a positive integer');
  return { pollIntervalMs, maxIdlePolls };
}

function settled(store: Store, goalId: string): boolean {
  return store.listWorkItems(goalId).every(item => item.status === 'SUCCEEDED' || item.status === 'BLOCKED');
}

/** A FAILED item is terminal only after recovery has explicitly declined retry. */
function terminalFailure(store: Store, goalId: string): boolean {
  const items = store.listWorkItems(goalId);
  const hasActive = items.some(item => item.status === 'PENDING' || item.status === 'READY' || item.status === 'RUNNING');
  const hasRetryableFailure = items.some(item => item.status === 'FAILED' && store.getRetryState(item.id)?.decision === 'RETRY');
  const hasTerminalFailure = items.some(item => item.status === 'FAILED' && store.getRetryState(item.id)?.decision !== 'RETRY');
  return hasTerminalFailure && !hasActive && !hasRetryableFailure;
}

function waitForPoll(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let done = false;
    const finish = (continuePolling: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(continuePolling);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Long-lived, bounded pool service. Each poll executes at most one fair turn
 * per goal, and an abort leaves all unselected work items in their persisted
 * state for a later worker. The wrapper deliberately owns no extra state.
 */
export async function runControllerPoolWorker(
  store: Store,
  inputs: ControllerLoopInput[],
  options: ControllerPoolWorkerOptions = {}
): Promise<ControllerPoolWorkerResult> {
  const { pollIntervalMs, maxIdlePolls } = validateOptions(options);
  const ids = new Set<string>();
  for (const input of inputs) {
    if (ids.has(input.goalId)) throw new Error(`duplicate goal id: ${input.goalId}`);
    ids.add(input.goalId);
  }
  const workerInputs = inputs.map(input => options.controllerId && !input.leaderElection
    ? { ...input, leaderElection: { controllerId: options.controllerId!, leaseTtlMs: options.leaderLeaseTtlMs } }
    : input);
  let turns = 0;
  let polls = 0;
  let idlePolls = 0;
  let stopReason: PoolWorkerStopReason = 'COMPLETED';
  const results: Record<string, ControllerPoolResult['results'][string]> = {};
  const completed = new Set<string>();
  const failed = new Set<string>();

  while (true) {
    if (options.signal?.aborted) { stopReason = 'ABORTED'; break; }
    const failedBeforePoll = workerInputs.find(input => terminalFailure(store, input.goalId));
    if (failedBeforePoll) { failed.add(failedBeforePoll.goalId); stopReason = 'FAILED'; break; }
    if (workerInputs.every(input => settled(store, input.goalId))) { stopReason = 'COMPLETED'; break; }
    if (options.maxTurns !== undefined && turns >= options.maxTurns) { stopReason = 'MAX_TURNS'; break; }
    const before = workerInputs.map(input => store.listWorkItems(input.goalId).map(item => `${item.id}:${item.status}`).join('|')).join('||');
    const remaining = options.maxTurns === undefined ? 1 : Math.min(1, options.maxTurns - turns);
    const poll = await runControllerPool(store, workerInputs, { maxConcurrency: options.maxConcurrency, maxTurns: remaining });
    polls += 1;
    turns += poll.turns;
    for (const [goalId, result] of Object.entries(poll.results)) results[goalId] = result;
    for (const goalId of poll.completed) completed.add(goalId);
    for (const goalId of poll.failed) failed.add(goalId);
    const after = workerInputs.map(input => store.listWorkItems(input.goalId).map(item => `${item.id}:${item.status}`).join('|')).join('||');
    if (before === after) idlePolls += 1;
    else idlePolls = 0;
    const failedAfterPoll = workerInputs.find(input => terminalFailure(store, input.goalId));
    if (failedAfterPoll) { failed.add(failedAfterPoll.goalId); stopReason = 'FAILED'; break; }
    if (workerInputs.every(input => settled(store, input.goalId))) { stopReason = 'COMPLETED'; break; }
    if (options.maxTurns !== undefined && turns >= options.maxTurns) { stopReason = 'MAX_TURNS'; break; }
    if (idlePolls >= maxIdlePolls) { stopReason = 'IDLE_LIMIT'; break; }
    if (!(await waitForPoll(pollIntervalMs, options.signal))) { stopReason = 'ABORTED'; break; }
  }

  const finalCompleted = workerInputs.filter(input => settled(store, input.goalId)).map(input => input.goalId);
  const finalFailed = workerInputs.filter(input => terminalFailure(store, input.goalId)).map(input => input.goalId);
  for (const goalId of finalFailed) failed.add(goalId);
  const finalSkipped = workerInputs.filter(input => !finalCompleted.includes(input.goalId) && !failed.has(input.goalId)).map(input => input.goalId);
  return { completed: finalCompleted.length ? finalCompleted : [...completed], failed: [...failed], skipped: finalSkipped, turns, polls, idlePolls, stopReason, results };
}
