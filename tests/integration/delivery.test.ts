import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTargetRevision, commitCandidate, pushCandidate, readCiStatus, snapshotCandidate, reconcilePullRequest, reconcileMerge, waitForCi, ExternalWaitError, withProviderLease } from '../../src/delivery/git.js';
import { Store } from '../../src/storage/database.js';

test('候选快照绑定 HEAD 与变更路径，PR 对账避免重复创建', async () => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'a.txt'), 'a');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'init']);
  writeFileSync(join(root, 'b.txt'), 'b');
  const candidate = await snapshotCandidate(root);
  assert.deepEqual(candidate.changedPaths, ['b.txt']);
  await assertTargetRevision(root, 'HEAD', candidate.revision);
  await assert.rejects(() => assertTargetRevision(root, 'HEAD', 'wrong'), /target branch moved/);
  writeFileSync(join(root, 'b.txt'), 'changed');
  const changedCandidate = await snapshotCandidate(root);
  assert.notEqual(changedCandidate.artifactDigest, candidate.artifactDigest);
  const committedRevision = await commitCandidate(root, 'candidate change', ['b.txt']);
  assert.notEqual(committedRevision, candidate.revision);
  assert.equal((await readCiStatus({ async getStatus(revision) { return { revision, state: 'PASS' as const }; } }, committedRevision)).state, 'PASS');
  await assert.rejects(() => readCiStatus({ async getStatus() { return { revision: 'other', state: 'PASS' as const }; } }, committedRevision), /different revision/);
  let created = 0;
  const provider = { async findByIdempotency() { return created ? { id: '1', url: 'u', headRevision: candidate.revision, status: 'open' } : undefined; }, async create(input: { idempotencyKey: string; headRevision: string; title: string; body: string }) { created++; return { id: '1', url: 'u', headRevision: input.headRevision, status: 'open' }; } };
  await reconcilePullRequest(provider, { idempotencyKey: 'pr-1', headRevision: candidate.revision, title: 'x', body: 'y' });
  await reconcilePullRequest(provider, { idempotencyKey: 'pr-1', headRevision: candidate.revision, title: 'x', body: 'y' });
  await assert.rejects(() => reconcilePullRequest(provider, { idempotencyKey: 'pr-1', headRevision: 'other', title: 'x', body: 'y' }), /different revision/);
  assert.equal(created, 1);
  const mismatchedCreate = { async findByIdempotency() { return undefined; }, async create(input: { idempotencyKey: string; headRevision: string; title: string; body: string }) { return { id: 'bad', url: 'u', headRevision: `${input.headRevision}-other`, status: 'open' }; } };
  await assert.rejects(() => reconcilePullRequest(mismatchedCreate, { idempotencyKey: 'pr-created-mismatch', headRevision: candidate.revision, title: 'x', body: 'y' }), /returned a different revision/);
  let concurrentCreates = 0;
  const concurrentProvider = { async findByIdempotency() { await new Promise(resolve => setTimeout(resolve, 5)); return undefined; }, async create(input: { idempotencyKey: string; headRevision: string; title: string; body: string }) { concurrentCreates++; await new Promise(resolve => setTimeout(resolve, 5)); return { id: '2', url: 'u2', headRevision: input.headRevision, status: 'open' }; } };
  await Promise.all([reconcilePullRequest(concurrentProvider, { idempotencyKey: 'pr-concurrent', headRevision: candidate.revision, title: 'x', body: 'y' }), reconcilePullRequest(concurrentProvider, { idempotencyKey: 'pr-concurrent', headRevision: candidate.revision, title: 'x', body: 'y' })]);
  assert.equal(concurrentCreates, 1);
  let merges = 0;
  const mergeProvider = { async findByIdempotency() { return merges ? { id: 'merge1', revision: candidate.revision, status: 'merged' } : undefined; }, async merge(input: { idempotencyKey: string; revision: string }) { merges++; return { id: 'merge1', revision: input.revision, status: 'merged' }; } };
  await reconcileMerge(mergeProvider, { idempotencyKey: 'merge-1', revision: candidate.revision });
  await reconcileMerge(mergeProvider, { idempotencyKey: 'merge-1', revision: candidate.revision });
  assert.equal(merges, 1);
  await assert.rejects(() => reconcileMerge(mergeProvider, { idempotencyKey: 'merge-1', revision: 'other' }), /different revision/);
  let providerAMerges = 0; let providerBMerges = 0;
  const mergeA = { async findByIdempotency() { await new Promise(resolve => setTimeout(resolve, 5)); return undefined; }, async merge(input: { idempotencyKey: string; revision: string }) { providerAMerges++; return { id: 'a', revision: input.revision, status: 'merged' }; } };
  const mergeB = { async findByIdempotency() { await new Promise(resolve => setTimeout(resolve, 5)); return undefined; }, async merge(input: { idempotencyKey: string; revision: string }) { providerBMerges++; return { id: 'b', revision: input.revision, status: 'merged' }; } };
  const [mergedA, mergedB] = await Promise.all([reconcileMerge(mergeA, { idempotencyKey: 'same-key', revision: candidate.revision }), reconcileMerge(mergeB, { idempotencyKey: 'same-key', revision: candidate.revision })]);
  assert.equal(mergedA.id, 'a'); assert.equal(mergedB.id, 'b'); assert.equal(providerAMerges, 1); assert.equal(providerBMerges, 1);
  let mismatchRejected = false;
  const slowProvider = { async findByIdempotency() { await new Promise(resolve => setTimeout(resolve, 10)); return undefined; }, async create(input: { idempotencyKey: string; headRevision: string; title: string; body: string }) { await new Promise(resolve => setTimeout(resolve, 10)); return { id: '3', url: 'u3', headRevision: input.headRevision, status: 'open' }; } };
  const firstRequest = reconcilePullRequest(slowProvider, { idempotencyKey: 'pr-mismatch', headRevision: 'rev-a', title: 'x', body: 'y' });
  await assert.rejects(() => reconcilePullRequest(slowProvider, { idempotencyKey: 'pr-mismatch', headRevision: 'rev-b', title: 'x', body: 'y' }), /in-flight/);
  await firstRequest;
  let polls = 0;
  assert.equal((await waitForCi({ async getStatus(revision) { polls++; return { revision, state: polls < 2 ? 'PENDING' as const : 'PASS' as const }; } }, 'rev-ci', { maxPolls: 3, intervalMs: 1 })).state, 'PASS');
  await assert.rejects(() => waitForCi({ async getStatus(revision) { return { revision, state: 'UNKNOWN' as const }; } }, 'rev-wait', { maxPolls: 1, intervalMs: 1 }), (error) => error instanceof ExternalWaitError);
  let pushes = 0;
  const pushProvider = { async findByIdempotency() { return pushes ? { id: 'push1', revision: 'rev-push' } : undefined; }, async push(input: { idempotencyKey: string; revision: string }) { pushes++; return { id: 'push1', revision: input.revision }; } };
  await pushCandidate(pushProvider, { idempotencyKey: 'push-key', revision: 'rev-push' });
  await pushCandidate(pushProvider, { idempotencyKey: 'push-key', revision: 'rev-push' });
  assert.equal(pushes, 1);
  let boundaryPoll = 0;
  assert.equal((await waitForCi({ async getStatus(revision) { boundaryPoll++; return { revision, state: boundaryPoll === 1 ? 'PENDING' as const : 'PASS' as const }; } }, 'rev-boundary', { maxPolls: 2, intervalMs: 1 })).state, 'PASS');
  let zeroIntervalPolls = 0;
  assert.equal((await waitForCi({ async getStatus(revision) { zeroIntervalPolls++; return { revision, state: zeroIntervalPolls === 1 ? 'PENDING' as const : 'PASS' as const }; } }, 'rev-zero-interval', { maxPolls: 2, intervalMs: 0 })).state, 'PASS');
  assert.equal(zeroIntervalPolls, 2);
  for (const intervalMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    await assert.rejects(() => waitForCi({ async getStatus(revision) { return { revision, state: 'PASS' as const }; } }, 'rev-invalid-interval', { intervalMs }), /intervalMs must be a finite non-negative number/);
  }
  await assert.rejects(() => waitForCi({ async getStatus(revision) { return { revision, state: 'PENDING' as const }; } }, 'rev-invalid', { maxPolls: 0 }), /positive integer/);
  rmSync(root, { recursive: true, force: true });
});

test('merge 对账只接受 merged 回执', async () => {
  const candidate = { revision: 'rev-merge-status' };
  const pending = { async findByIdempotency() { return { id: 'm1', revision: candidate.revision, status: 'pending' }; }, async merge() { throw new Error('must not merge'); } };
  await assert.rejects(() => reconcileMerge(pending, { idempotencyKey: 'merge-status-1', revision: candidate.revision }), /not successful/);
  const failed = { async findByIdempotency() { return undefined; }, async merge(input: { revision: string }) { return { id: 'm2', revision: input.revision, status: 'failed' }; } };
  await assert.rejects(() => reconcileMerge(failed, { idempotencyKey: 'merge-status-2', revision: candidate.revision }), /did not succeed/);
});

test('delivery provider wrapper blocks a duplicate side effect across Store instances', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-delivery-'));
  const dbPath = join(dir, 'state.sqlite');
  const storeA = new Store(dbPath);
  const storeB = new Store(dbPath);
  let effects = 0;
  const first = withProviderLease({ store: storeA, resourceKey: 'provider:pr:repo:key', owner: 'a', ttlMs: 200 }, async () => {
    effects += 1;
    await new Promise(resolve => setTimeout(resolve, 20));
    return 'done';
  });
  await assert.rejects(() => withProviderLease({ store: storeB, resourceKey: 'provider:pr:repo:key', owner: 'b', ttlMs: 200 }, async () => {
    effects += 1;
    return 'unexpected';
  }), /held/);
  assert.equal(await first, 'done');
  assert.equal(effects, 1);
  storeA.close();
  storeB.close();
  rmSync(dir, { recursive: true, force: true });
});
