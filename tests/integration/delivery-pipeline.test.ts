import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/database.js';
import { deliverCandidate } from '../../src/delivery/pipeline.js';

test('本地交付流水线在最新目标上 commit、CI 通过后写回 PR 回执', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'a.txt'), 'a');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'init']);
  const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'b.txt'), 'b');
  const store = new Store();
  const result = await deliverCandidate(store, { ci: { async getStatus(revision) { return { revision, state: 'PASS' as const }; } }, push: { async findByIdempotency() { return undefined; }, async push(input) { return { id: 'push1', revision: input.revision }; } }, pr: { async findByIdempotency() { return undefined; }, async create(input) { return { id: 'pr1', url: 'https://example/pr1', headRevision: input.headRevision, status: 'open' }; } } }, { repository: root, target: 'HEAD', expectedTargetRevision: base, commitMessage: 'candidate', operation: { actionId: 'op-pipeline', idempotencyKey: 'pipeline-1', intendedTarget: 'pr' }, title: 'Candidate', body: 'Automated candidate' });
  assert.equal(result.ci.state, 'PASS');
  assert.equal(store.getOperation('op-pipeline')?.reconciliationStatus, 'SUCCEEDED');
  assert.equal((store.getOperation('op-pipeline')?.pushReceipt as { id: string }).id, 'push1');
  assert.equal((store.getOperation('op-pipeline')?.externalReceipt as { id: string }).id, 'pr1');
  const retry = await deliverCandidate(store, { ci: { async getStatus(revision) { return { revision, state: 'PASS' as const }; } }, push: { async findByIdempotency() { throw new Error('should not query completed push'); }, async push() { throw new Error('duplicate push'); } }, pr: { async findByIdempotency() { throw new Error('should not query completed operation'); }, async create() { throw new Error('duplicate create'); } } }, { repository: root, target: 'HEAD', expectedTargetRevision: result.revision, commitMessage: 'candidate', operation: { actionId: 'op-pipeline', idempotencyKey: 'pipeline-1', intendedTarget: 'pr' }, title: 'Candidate', body: 'Automated candidate' });
  assert.equal(retry.revision, result.revision);
  const retryByKey = await deliverCandidate(store, { ci: { async getStatus(revision) { return { revision, state: 'PASS' as const }; } }, push: { async findByIdempotency() { throw new Error('should not query completed push'); }, async push() { throw new Error('duplicate push'); } }, pr: { async findByIdempotency() { throw new Error('should not query completed operation'); }, async create() { throw new Error('duplicate create'); } } }, { repository: root, target: 'HEAD', expectedTargetRevision: result.revision, commitMessage: 'must not commit again', operation: { actionId: 'op-pipeline-new-action', idempotencyKey: 'pipeline-1', intendedTarget: 'pr' }, title: 'Candidate', body: 'Automated candidate' });
  assert.equal(retryByKey.revision, result.revision);
  rmSync(root, { recursive: true, force: true });
});

test('非 HEAD 目标要求 checkout 已在目标分支，并允许目标分支自身产生提交', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-branch-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'a.txt'), 'a');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'init']);
  const branch = execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'b.txt'), 'b');
  const store = new Store();
  const providers = { ci: { async getStatus(revision: string) { return { revision, state: 'PASS' as const }; } }, pr: { async findByIdempotency() { return undefined; }, async create(input: { headRevision: string }) { return { id: 'pr1', url: 'u', headRevision: input.headRevision, status: 'open' }; } } };
  const result = await deliverCandidate(store, { ...providers, push: { async findByIdempotency() { return undefined; }, async push(input) { return { id: 'push1', revision: input.revision }; } } }, { repository: root, target: branch, expectedTargetRevision: base, commitMessage: 'candidate', operation: { actionId: 'op-branch', idempotencyKey: 'branch-1', intendedTarget: 'pr' }, title: 'Candidate', body: 'Automated candidate' });
  assert.notEqual(result.revision, base);
  writeFileSync(join(root, 'c.txt'), 'c');
  await assert.rejects(() => deliverCandidate(store, { ...providers, push: { async findByIdempotency() { return undefined; }, async push(input) { return { id: 'push1', revision: input.revision }; } } }, { repository: root, target: 'other-branch', expectedTargetRevision: base, commitMessage: 'wrong branch', operation: { actionId: 'op-wrong-branch', idempotencyKey: 'branch-2', intendedTarget: 'pr' }, title: 'Candidate', body: 'Automated candidate' }), /checkout is on/);
  assert.equal(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '?? c.txt');
  rmSync(root, { recursive: true, force: true });
});

test('PENDING 交付恢复也拒绝跨到其他 checkout 分支', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-recovery-branch-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'a.txt'), 'a');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'init']);
  const branch = execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const store = new Store();
  store.createOperation({ actionId: 'op-pending-branch', idempotencyKey: 'pending-branch-1', intendedTarget: 'pr', exactRevision: revision, reconciliationStatus: 'PENDING' });
  execFileSync('git', ['-C', root, 'branch', 'other']);
  execFileSync('git', ['-C', root, 'checkout', '-q', 'other']);
  await assert.rejects(() => deliverCandidate(store, { ci: { async getStatus(revision: string) { return { revision, state: 'PASS' as const }; } }, push: { async findByIdempotency() { throw new Error('must not query push'); }, async push() { throw new Error('must not push'); } }, pr: { async findByIdempotency() { throw new Error('must not query PR'); }, async create() { throw new Error('must not create PR'); } } }, { repository: root, target: branch, expectedTargetRevision: revision, commitMessage: 'unused', operation: { actionId: 'op-pending-branch', idempotencyKey: 'pending-branch-1', intendedTarget: 'pr' }, title: 'Candidate', body: 'Automated candidate' }), /checkout is on/);
  rmSync(root, { recursive: true, force: true });
});

test('PENDING 交付恢复会对账 push 并继续创建 PR', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-recovery-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'a.txt'), 'a');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'init']);
  const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const store = new Store();
  store.createOperation({ actionId: 'op-recover', idempotencyKey: 'recover-1', targetRef: 'HEAD', intendedTarget: 'pr', exactRevision: revision, reconciliationStatus: 'PENDING' });
  let pushed = 0;
  const result = await deliverCandidate(store, { ci: { async getStatus(rev) { return { revision: rev, state: 'PASS' as const }; } }, push: { async findByIdempotency() { return undefined; }, async push(input) { pushed++; return { id: 'push-recover', revision: input.revision }; } }, pr: { async findByIdempotency() { return undefined; }, async create(input) { return { id: 'pr-recover', url: 'u', headRevision: input.headRevision, status: 'open' }; } } }, { repository: root, target: 'HEAD', expectedTargetRevision: revision, commitMessage: 'unused', operation: { actionId: 'op-recover', idempotencyKey: 'recover-1', intendedTarget: 'pr' }, title: 'Candidate', body: 'Automated candidate' });
  assert.equal(pushed, 1);
  assert.equal(result.push?.id, 'push-recover');
  assert.equal(store.getOperation('op-recover')?.reconciliationStatus, 'SUCCEEDED');
  rmSync(root, { recursive: true, force: true });
});

test('恢复缺少目标分支绑定的旧 Operation 时显式拒绝', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-unbound-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'a.txt'), 'a');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'init']);
  const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const store = new Store();
  store.createOperation({ actionId: 'op-unbound', idempotencyKey: 'unbound-1', intendedTarget: 'pr', exactRevision: revision, reconciliationStatus: 'PENDING' });
  await assert.rejects(() => deliverCandidate(store, { ci: { async getStatus(rev) { return { revision: rev, state: 'PASS' as const }; } }, push: { async findByIdempotency() { throw new Error('must not query push'); }, async push() { throw new Error('must not push'); } }, pr: { async findByIdempotency() { throw new Error('must not query PR'); }, async create() { throw new Error('must not create PR'); } } }, { repository: root, target: 'HEAD', expectedTargetRevision: revision, commitMessage: 'unused', operation: { actionId: 'op-unbound', idempotencyKey: 'unbound-1', intendedTarget: 'pr' }, title: 'Candidate', body: 'Automated candidate' }), /identity mismatch/);
  rmSync(root, { recursive: true, force: true });
});

test('交付流水线只在授权策略允许时执行 merge，并持久化 merge 回执', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-merge-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'a.txt'), 'a');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'init']);
  const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'b.txt'), 'b');
  const store = new Store();
  store.createGoal({ id: 'goal-merge', userIntent: 'deliver', constraints: [], acceptanceContract: {}, authorizationPolicy: { allowedActions: ['merge'] }, budget: {} });
  let merges = 0;
  const providers = {
    ci: { async getStatus(revision: string) { return { revision, state: 'PASS' as const }; } },
    push: { async findByIdempotency() { return undefined; }, async push(input: { revision: string }) { return { id: 'push-merge', revision: input.revision }; } },
    pr: { async findByIdempotency() { return undefined; }, async create(input: { headRevision: string }) { return { id: 'pr-merge', url: 'u', headRevision: input.headRevision, status: 'open' }; } },
    merge: { async findByIdempotency() { return merges ? { id: 'merge-1', revision: resultRevision, status: 'merged' } : undefined; }, async merge(input: { revision: string }) { merges += 1; resultRevision = input.revision; return { id: 'merge-1', revision: input.revision, status: 'merged' }; } }
  };
  let resultRevision = '';
  const result = await deliverCandidate(store, providers, { repository: root, target: 'HEAD', expectedTargetRevision: base, commitMessage: 'candidate', operation: { actionId: 'op-merge', idempotencyKey: 'merge-1', intendedTarget: 'pr' }, title: 'Candidate', body: 'Automated candidate', goalId: 'goal-merge', merge: {} });
  assert.equal(merges, 1);
  assert.equal(result.merge?.status, 'merged');
  assert.equal((store.getOperation('op-merge')?.externalReceipt as { id: string }).id, 'pr-merge');
  assert.equal((store.getOperation('op-merge')?.mergeReceipt as { id: string }).id, 'merge-1');
  const retry = await deliverCandidate(store, {
    ci: providers.ci,
    push: { async findByIdempotency() { throw new Error('must not query completed push'); }, async push() { throw new Error('must not push twice'); } },
    pr: { async findByIdempotency() { throw new Error('must not query completed PR'); }, async create() { throw new Error('must not create PR twice'); } },
    merge: { async findByIdempotency() { throw new Error('must not query completed merge'); }, async merge() { throw new Error('must not merge twice'); } }
  }, { repository: root, target: 'HEAD', expectedTargetRevision: result.revision, commitMessage: 'candidate', operation: { actionId: 'op-merge', idempotencyKey: 'merge-1', intendedTarget: 'pr' }, title: 'Candidate', body: 'Automated candidate', goalId: 'goal-merge', merge: {} });
  assert.equal(retry.merge?.id, 'merge-1');
  rmSync(root, { recursive: true, force: true });
});

test('merge 要求显式授权，不能由空策略默认放行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-merge-denied-'));
  execFileSync('git', ['init', '-q', root]);
  writeFileSync(join(root, 'a.txt'), 'a');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'init']);
  const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(root, 'b.txt'), 'b');
  const store = new Store();
  store.createGoal({ id: 'goal-merge-denied', userIntent: 'deliver', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  await assert.rejects(() => deliverCandidate(store, {
    ci: { async getStatus(revision: string) { return { revision, state: 'PASS' as const }; } },
    push: { async findByIdempotency() { return undefined; }, async push(input: { revision: string }) { return { id: 'push', revision: input.revision }; } },
    pr: { async findByIdempotency() { return undefined; }, async create(input: { headRevision: string }) { return { id: 'pr', url: 'u', headRevision: input.headRevision, status: 'open' }; } },
    merge: { async findByIdempotency() { return undefined; }, async merge(input: { revision: string }) { return { id: 'merge', revision: input.revision, status: 'merged' }; } }
  }, { repository: root, target: 'HEAD', expectedTargetRevision: base, commitMessage: 'candidate', operation: { actionId: 'op-denied', idempotencyKey: 'denied-1', intendedTarget: 'pr' }, title: 'Candidate', body: 'Automated candidate', goalId: 'goal-merge-denied', merge: {} }), /not explicitly authorized/);
  rmSync(root, { recursive: true, force: true });
});
