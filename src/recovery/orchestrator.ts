import type { Store } from '../storage/database.js';
import type { Attempt } from '../contracts/index.js';
import type { FailureKind } from './index.js';

/** Context used when a new controller process takes over an interrupted run. */
export interface RecoveredAttemptContext {
  attempt: number;
  failureKind: FailureKind;
  strategy?: string;
}

export interface RecoveryReport {
  attempts: Attempt[];
  requeuedWorkItems: string[];
  contexts: Map<string, RecoveredAttemptContext>;
}

/**
 * Reconcile abandoned attempts for one Goal before normal scheduling starts.
 * The operation is deliberately idempotent: once an attempt has been marked
 * recovered it no longer appears in Store.recoverInterruptedAttempts().
 */
export function recoverGoalAttempts(store: Store, goalId: string, now = new Date().toISOString()): RecoveryReport {
  const workItems = store.listWorkItems(goalId);
  const workItemIds = new Set(workItems.map(item => item.id));
  const attempts = store.recoverInterruptedAttempts(now, workItemIds);
  const requeuedWorkItems: string[] = [];
  const contexts = new Map<string, RecoveredAttemptContext>();

  for (const attempt of attempts) {
    const item = store.getWorkItem(attempt.workItemId);
    if (!item || item.goalId !== goalId || item.status !== 'RUNNING') continue;
    store.transitionWorkItem(item.id, 'FAILED');
    store.transitionWorkItem(item.id, 'READY');
    requeuedWorkItems.push(item.id);
    // attemptCount is incremented when entering RUNNING. The next execution
    // therefore receives the next ordinal rather than silently restarting at 1.
    contexts.set(item.id, { attempt: Math.max(2, item.attemptCount + 1), failureKind: 'RUNNER_ERROR' });
  }
  return { attempts, requeuedWorkItems, contexts };
}
