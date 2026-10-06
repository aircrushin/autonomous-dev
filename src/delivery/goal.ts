import type { Store } from '../storage/database.js';
import { deliverCandidate, type DeliveryInput } from './pipeline.js';

function assertWorkItemsTerminal(store: Store, goalId: string): void {
  const unfinished = store.listWorkItems(goalId).filter(item => item.status !== 'SUCCEEDED' && item.status !== 'BLOCKED');
  if (unfinished.length > 0) throw new Error(`Goal has unfinished WorkItems: ${unfinished.map(item => `${item.id}:${item.status}`).join(',')}`);
}

/** Persist Goal lifecycle around the existing idempotent delivery pipeline. */
export async function deliverGoalCandidate(store: Store, providers: Parameters<typeof deliverCandidate>[1], input: DeliveryInput & { goalId: string }) {
  if (!input.goalId.trim()) throw new Error('goalId is required');
  const goal = store.getGoal(input.goalId);
  if (!goal) throw new Error(`Goal 不存在: ${input.goalId}`);
  if (goal.status === 'SUCCEEDED') {
    const operation = store.getOperation(input.operation.actionId) ?? store.getOperationByIdempotencyKey(input.operation.idempotencyKey);
    const pr = operation?.externalReceipt as { headRevision?: string; status?: string } | undefined;
    const mergeRequested = input.merge !== undefined || operation?.mergeIdempotencyKey !== undefined;
    const merge = operation?.mergeReceipt as { revision?: string; status?: string } | undefined;
    if (!operation || operation.goalId !== input.goalId || operation.reconciliationStatus !== 'SUCCEEDED' || !pr || pr.headRevision !== operation.exactRevision || !['open', 'merged'].includes(pr.status ?? '') || (mergeRequested && (!merge || merge.status !== 'merged' || merge.revision !== operation.exactRevision))) {
      throw new Error('succeeded Goal requires a completed delivery Operation');
    }
  } else if (goal.status === 'VERIFYING') {
    assertWorkItemsTerminal(store, input.goalId);
    store.transitionGoal(input.goalId, 'DELIVERING');
  } else if (goal.status !== 'DELIVERING') {
    throw new Error(`Goal cannot deliver from ${goal.status}`);
  }
  if (goal.status === 'DELIVERING') assertWorkItemsTerminal(store, input.goalId);
  // Failures leave DELIVERING intact; the next process reconciles the same intent.
  const delivery = await deliverCandidate(store, providers, input);
  const operation = store.getOperation(input.operation.actionId) ?? store.getOperationByIdempotencyKey(input.operation.idempotencyKey);
  if (!operation || operation.goalId !== input.goalId || operation.reconciliationStatus !== 'SUCCEEDED') throw new Error('delivery did not reconcile successfully');
  if (store.getGoal(input.goalId)?.status === 'DELIVERING') store.transitionGoal(input.goalId, 'SUCCEEDED');
  return delivery;
}
