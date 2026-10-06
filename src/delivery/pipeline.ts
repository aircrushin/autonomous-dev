import type { Store } from '../storage/database.js';
import { assertExplicitlyAuthorized, type AuthorizationPolicy } from '../policy/authorization.js';
import { commitCandidate, pushCandidate, reconcileMerge, reconcilePullRequest, assertTargetRevision, currentBranch, waitForCi, snapshotCandidate, type CiProvider, type MergeProvider, type MergeReceipt, type PullRequestProvider, type PushProvider, type PushReceipt, type ProviderLeaseOptions } from './git.js';

export interface DeliveryInput { repository: string; target: string; expectedTargetRevision: string; commitMessage: string; paths?: string[]; goalId?: string; operation: { actionId: string; idempotencyKey: string; intendedTarget: string }; title: string; body: string; merge?: { idempotencyKey?: string }; providerLeases?: { push?: ProviderLeaseOptions; pr?: ProviderLeaseOptions; merge?: ProviderLeaseOptions }; }
export async function deliverCandidate(store: Store, providers: { ci: CiProvider; push: PushProvider; pr: PullRequestProvider; merge?: MergeProvider }, input: DeliveryInput) {
  const existingOperation = store.getOperation(input.operation.actionId) ?? store.getOperationByIdempotencyKey(input.operation.idempotencyKey);
  const mergeRequested = input.merge !== undefined || existingOperation?.mergeIdempotencyKey !== undefined || existingOperation?.mergeReceipt !== undefined;
  if (mergeRequested) {
    if (!providers.merge) throw new Error('merge provider is required for merge delivery');
    if (!input.goalId) throw new Error('goalId is required for authorized merge delivery');
    const goal = store.getGoal(input.goalId);
    if (!goal) throw new Error(`Goal 不存在: ${input.goalId}`);
    assertExplicitlyAuthorized(goal.authorizationPolicy as AuthorizationPolicy, 'merge');
  }
  const requestedMergeKey = input.merge?.idempotencyKey ?? `${input.operation.idempotencyKey}:merge`;
  const reconcileCompleted = async (operation: ReturnType<Store['getOperation']>, ci: Awaited<ReturnType<typeof waitForCi>>, before: Awaited<ReturnType<typeof snapshotCandidate>>, pr: unknown, push?: PushReceipt) => {
    if (!operation) throw new Error(`Operation 不存在: ${input.operation.actionId}`);
    if (!mergeRequested) {
      store.updateOperationReceipt(operation.actionId, pr, 'SUCCEEDED');
      return { before, revision: operation.exactRevision, push, ci, pr };
    }
    store.updateOperationReceipt(operation.actionId, pr, 'PENDING');
    const mergeKey = operation.mergeIdempotencyKey ?? requestedMergeKey;
    if (operation.mergeIdempotencyKey && input.merge?.idempotencyKey && operation.mergeIdempotencyKey !== input.merge.idempotencyKey) throw new Error('merge idempotency key mismatch');
    if (!operation.mergeIdempotencyKey) store.setOperationMergeIdempotencyKey(operation.actionId, mergeKey);
    const merge = await reconcileMerge(providers.merge!, { idempotencyKey: mergeKey, revision: operation.exactRevision }, input.providerLeases?.merge);
    store.updateOperationMergeReceipt(operation.actionId, merge);
    return { before, revision: operation.exactRevision, push, ci, pr, merge };
  };
  if (input.target !== 'HEAD') {
    const checkout = await currentBranch(input.repository);
    if (checkout !== input.target) throw new Error(`delivery checkout is on ${checkout || 'detached HEAD'}, expected ${input.target}`);
  }
  const existing = existingOperation;
  let existingRevision: string | undefined;
  if (existing) {
    if (existing.targetRef === undefined || existing.idempotencyKey !== input.operation.idempotencyKey || existing.intendedTarget !== input.operation.intendedTarget || existing.targetRef !== input.target || (input.goalId !== undefined && (existing.goalId === undefined || existing.goalId !== input.goalId))) throw new Error('delivery operation identity mismatch');
    if (mergeRequested && existing.mergeIdempotencyKey && input.merge?.idempotencyKey && existing.mergeIdempotencyKey !== input.merge.idempotencyKey) throw new Error('merge idempotency key mismatch');
    if (mergeRequested && existing.mergeReceipt !== undefined) {
      const storedMerge = existing.mergeReceipt as Partial<MergeReceipt>;
      if (storedMerge.revision !== existing.exactRevision || storedMerge.status !== 'merged') throw new Error('stored merge receipt is invalid');
    }
    if (existing.reconciliationStatus === 'SUCCEEDED' && existing.externalReceipt !== undefined && (!mergeRequested || existing.mergeReceipt !== undefined)) {
      const ci = await waitForCi(providers.ci, existing.exactRevision);
      if (ci.state !== 'PASS') throw new Error(`CI is not passing: ${ci.state}`);
      const storedPush = existing.pushReceipt as Partial<PushReceipt> | undefined;
      if (storedPush && storedPush.revision !== existing.exactRevision) throw new Error('stored push receipt revision mismatch');
      const storedPr = existing.externalReceipt as { headRevision?: string; status?: string };
      if (storedPr.headRevision !== existing.exactRevision) throw new Error('stored PR receipt revision mismatch');
      if (!storedPr.status || ['failed', 'error', 'unknown', 'closed'].includes(storedPr.status)) throw new Error(`stored PR receipt is not successful: ${storedPr.status ?? 'missing status'}`);
      return { before: await snapshotCandidate(input.repository), revision: existing.exactRevision, push: existing.pushReceipt as PushReceipt | undefined, ci, pr: existing.externalReceipt, merge: existing.mergeReceipt as MergeReceipt | undefined };
    }
    if (existing.reconciliationStatus === 'SUCCEEDED' && existing.externalReceipt !== undefined && mergeRequested && existing.mergeReceipt === undefined) {
      const ci = await waitForCi(providers.ci, existing.exactRevision);
      if (ci.state !== 'PASS') throw new Error(`CI is not passing: ${ci.state}`);
      return reconcileCompleted(existing, ci, await snapshotCandidate(input.repository), existing.externalReceipt, existing.pushReceipt as PushReceipt | undefined);
    }
    if (existing.reconciliationStatus === 'PENDING') {
      await assertTargetRevision(input.repository, input.target, existing.exactRevision);
      let push = existing.pushReceipt as PushReceipt | undefined;
      if (push && push.revision !== existing.exactRevision) throw new Error('reconciled push revision mismatch');
      if (!push) {
        push = await pushCandidate(providers.push, { idempotencyKey: `${existing.idempotencyKey}:push`, revision: existing.exactRevision }, input.providerLeases?.push);
        store.updateOperationPushReceipt(existing.actionId, push);
      }
      const receipt = await providers.pr.findByIdempotency(existing.idempotencyKey);
      if (receipt) {
        if (receipt.headRevision !== existing.exactRevision) throw new Error('reconciled PR revision mismatch');
        const ci = await waitForCi(providers.ci, existing.exactRevision);
        if (ci.state !== 'PASS') throw new Error(`CI is not passing: ${ci.state}`);
        return reconcileCompleted(existing, ci, await snapshotCandidate(input.repository), receipt, push);
      }
      existingRevision = existing.exactRevision;
    }
  }
  if (existingRevision) {
    const ci = await waitForCi(providers.ci, existingRevision);
    if (ci.state !== 'PASS') throw new Error(`CI is not passing: ${ci.state}`);
    const pr = await reconcilePullRequest(providers.pr, { idempotencyKey: input.operation.idempotencyKey, headRevision: existingRevision, title: input.title, body: input.body }, input.providerLeases?.pr);
    const operation = store.getOperation(input.operation.actionId) ?? store.getOperationByIdempotencyKey(input.operation.idempotencyKey);
    return reconcileCompleted(operation, ci, await snapshotCandidate(input.repository), pr, operation?.pushReceipt as PushReceipt | undefined);
  }
  await assertTargetRevision(input.repository, input.target, input.expectedTargetRevision);
  const before = await snapshotCandidate(input.repository);
  const revision = await commitCandidate(input.repository, input.commitMessage, input.paths);
  const operation = store.createOperation({ ...input.operation, goalId: input.goalId, targetRef: input.target, mergeIdempotencyKey: mergeRequested ? requestedMergeKey : undefined, exactRevision: revision, reconciliationStatus: 'PENDING' });
  const push = await pushCandidate(providers.push, { idempotencyKey: `${operation.idempotencyKey}:push`, revision }, input.providerLeases?.push);
  store.updateOperationPushReceipt(operation.actionId, push);
  const ci = await waitForCi(providers.ci, revision);
  if (ci.state !== 'PASS') throw new Error(`CI is not passing: ${ci.state}`);
  const pr = await reconcilePullRequest(providers.pr, { idempotencyKey: operation.idempotencyKey, headRevision: revision, title: input.title, body: input.body }, input.providerLeases?.pr);
  return reconcileCompleted(operation, ci, before, pr, push);
}
