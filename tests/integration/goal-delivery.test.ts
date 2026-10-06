import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/database.js';
import { deliverGoalCandidate } from '../../src/delivery/goal.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'goal-delivery-'));
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'a.txt'), 'base');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'init']);
  const revision = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  writeFileSync(join(repo, 'b.txt'), 'feature');
  const db = join(root, 'state.sqlite');
  const store = new Store(db);
  store.createGoal({ id: 'goal', userIntent: 'deliver', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  for (const status of ['PLANNING', 'RUNNING', 'VERIFYING'] as const) store.transitionGoal('goal', status);
  store.createWorkItem({ id: 'goal-work', goalId: 'goal', description: 'done', dependencies: [] });
  store.transitionWorkItem('goal-work', 'READY'); store.transitionWorkItem('goal-work', 'RUNNING'); store.transitionWorkItem('goal-work', 'SUCCEEDED');
  const input = { goalId: 'goal', repository: repo, target: 'HEAD', expectedTargetRevision: revision, commitMessage: 'feature', operation: { actionId: 'op', idempotencyKey: 'key', intendedTarget: 'pr' }, title: 'Feature', body: 'Feature' };
  return { root, db, store, input };
}
const ci = { async getStatus(revision: string) { return { revision, state: 'PASS' as const }; } };

test('Goal delivery succeeds and completed retries avoid provider mutations', async () => {
  const { root, store, input } = setup();
  try {
    let pushes = 0; let creates = 0;
    const result = await deliverGoalCandidate(store, { ci, push: { async findByIdempotency() { return undefined; }, async push(value) { pushes++; return { id: 'push', revision: value.revision }; } }, pr: { async findByIdempotency() { return undefined; }, async create(value) { creates++; return { id: 'pr', url: 'u', headRevision: value.headRevision, status: 'open' }; } } }, input);
    assert.equal(store.getGoal('goal')?.status, 'SUCCEEDED');
    const retry = await deliverGoalCandidate(store, { ci, push: { async findByIdempotency() { throw new Error('duplicate query'); }, async push() { throw new Error('duplicate push'); } }, pr: { async findByIdempotency() { throw new Error('duplicate query'); }, async create() { throw new Error('duplicate PR'); } } }, input);
    assert.equal(retry.revision, result.revision);
    assert.equal(pushes, 1); assert.equal(creates, 1);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Goal delivery rejects VERIFYING with unfinished WorkItems before provider calls', async () => {
  const { root, store, input } = setup();
  try {
    store.createWorkItem({ id: 'goal-pending', goalId: 'goal', description: 'pending', dependencies: [] });
    await assert.rejects(() => deliverGoalCandidate(store, { ci, push: { async findByIdempotency() { throw new Error('must not call push'); }, async push() { throw new Error('must not push'); } }, pr: { async findByIdempotency() { throw new Error('must not call PR'); }, async create() { throw new Error('must not create PR'); } } }, input), /unfinished WorkItems/);
    assert.equal(store.getGoal('goal')?.status, 'VERIFYING');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Goal delivery preserves DELIVERING on lost PR receipt and reconciles after restart', async () => {
  const { root, db, store, input } = setup();
  let second: Store | undefined;
  try {
    let creates = 0;
    let receipt: { id: string; url: string; headRevision: string; status: string } | undefined;
    await assert.rejects(() => deliverGoalCandidate(store, { ci, push: { async findByIdempotency() { return undefined; }, async push(value) { return { id: 'push', revision: value.revision }; } }, pr: { async findByIdempotency() { return undefined; }, async create(value) { creates++; receipt = { id: 'pr', url: 'u', headRevision: value.headRevision, status: 'open' }; throw new Error('lost receipt'); } } }, input), /lost receipt/);
    assert.equal(store.getGoal('goal')?.status, 'DELIVERING');
    assert.equal(store.getOperation('op')?.reconciliationStatus, 'PENDING');
    const revision = store.getOperation('op')?.exactRevision;
    store.close();
    second = new Store(db);
    const result = await deliverGoalCandidate(second, { ci, push: { async findByIdempotency() { throw new Error('already pushed'); }, async push() { throw new Error('duplicate push'); } }, pr: { async findByIdempotency() { return receipt; }, async create() { throw new Error('duplicate PR'); } } }, input);
    assert.equal(result.revision, revision);
    assert.equal(second.getGoal('goal')?.status, 'SUCCEEDED');
    assert.equal(creates, 1);
  } finally { second?.close(); if (!second) store.close(); rmSync(root, { recursive: true, force: true }); }
});
