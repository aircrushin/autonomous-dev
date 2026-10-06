import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/storage/database.js';
import { runControllerLoop, runControllerPool } from '../../src/controller/loop.js';
import { runControllerRound } from '../../src/controller/controller.js';
import { mandatoryQualityChecks } from '../../src/verification/runner.js';
import { recoverGoalAttempts } from '../../src/recovery/orchestrator.js';
import { runControllerPoolWorker } from '../../src/controller/pool-worker.js';
import { LeaderLeaseLostError } from '../../src/controller/loop.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkItem } from '../../src/contracts/index.js';

test('controller loop 透传 mandatory quality profile 并扫描候选 workspace', async () => {
  let missingAgentCalls = 0;
  const missing = new Store();
  missing.createGoal({ id: 'quality-loop-missing', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  missing.createWorkItem({ id: 'quality-loop-missing-item', goalId: 'quality-loop-missing', description: 'x', dependencies: [] });
  const unsafeWorkspace = mkdtempSync(join(tmpdir(), 'quality-loop-unsafe-'));
  writeFileSync(join(unsafeWorkspace, 'bad.ts'), 'eval("x");\n');
  writeFileSync(join(unsafeWorkspace, '.env'), 'TOKEN="credential-value"\n');
  const missingResult = await runControllerLoop(missing, { goalId: 'quality-loop-missing', configure: () => ({ workspace: unsafeWorkspace, contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'local', inputDigest: 'i', checks: [{ id: 'custom', command: ['true'], required: true }], budget: {} }), agentFor: () => ({ async run() { missingAgentCalls += 1; return { runId: 'missing', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } }) });
  assert.equal(missingAgentCalls, 1);
  assert.deepEqual(missingResult.failed, ['quality-loop-missing-item']);
  assert.equal(missing.getWorkItem('quality-loop-missing-item')?.status, 'FAILED');
  rmSync(unsafeWorkspace, { recursive: true, force: true });
  const passing = new Store();
  const workspace = mkdtempSync(join(tmpdir(), 'quality-loop-workspace-'));
  writeFileSync(join(workspace, 'safe.ts'), 'export const value = 1;\n');
  passing.createGoal({ id: 'quality-loop-pass', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  passing.createWorkItem({ id: 'quality-loop-pass-item', goalId: 'quality-loop-pass', description: 'x', dependencies: [] });
  try {
    const result = await runControllerLoop(passing, { goalId: 'quality-loop-pass', configure: () => ({ workspace, contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'local', inputDigest: 'i', checks: mandatoryQualityChecks(workspace), qualityProfile: 'mandatory', budget: {} }), agentFor: () => ({ async run() { return { runId: 'pass', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } }) });
    assert.equal(result.results['quality-loop-pass-item']?.gate.result, 'ALLOW');
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('controller loop 按依赖滚动执行并保留每轮 verifier 结果', async () => {
  const store = new Store();
  store.createGoal({ id: 'loop-goal', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'loop-a', goalId: 'loop-goal', description: 'a', dependencies: [] });
  store.createWorkItem({ id: 'loop-b', goalId: 'loop-goal', description: 'b', dependencies: ['loop-a'] });
  store.createWorkItem({ id: 'loop-done', goalId: 'loop-goal', description: 'already done', dependencies: [] });
  store.transitionWorkItem('loop-done', 'READY');
  store.transitionWorkItem('loop-done', 'RUNNING');
  store.transitionWorkItem('loop-done', 'SUCCEEDED');
  store.createWorkItem({ id: 'loop-c', goalId: 'loop-goal', description: 'c', dependencies: ['loop-done'] });
  const agent = { async run() { return { runId: 'r', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  const result = await runControllerLoop(store, { goalId: 'loop-goal', maxConcurrency: 1, configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [{ id: 'check', command: [process.execPath, '-e', 'process.exit(0)'], required: true }], budget: {} }), agentFor: () => agent });
  assert.deepEqual(result.completed.sort(), ['loop-a', 'loop-b', 'loop-c']);
  assert.equal(result.rounds, 3);
  assert.equal(Object.keys(result.results).length, 3);
  assert.equal(store.getWorkItem('loop-b')?.status, 'SUCCEEDED');
});

test('controller loop 将未满足依赖持久化为 BLOCKED，并可恢复中断 Attempt', async () => {
  const store = new Store();
  store.createGoal({ id: 'recover-goal', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.db.prepare('INSERT INTO work_items VALUES (?, ?, ?, ?, ?, ?)').run('recover-a', 'recover-goal', 'a', JSON.stringify(['missing']), 'PENDING', 0);
  store.createWorkItem({ id: 'recover-b', goalId: 'recover-goal', description: 'b', dependencies: [] });
  store.transitionWorkItem('recover-b', 'READY');
  store.transitionWorkItem('recover-b', 'RUNNING');
  store.startAttempt({ id: 'interrupted', workItemId: 'recover-b', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: new Date().toISOString() });
  const agent = { async run() { return { runId: 'r', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  const result = await runControllerLoop(store, { goalId: 'recover-goal', configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [{ id: 'check', command: [process.execPath, '-e', 'process.exit(0)'], required: true }], budget: {} }), agentFor: () => agent });
  assert.deepEqual(result.skipped, ['recover-a']);
  assert.equal(store.getWorkItem('recover-a')?.status, 'BLOCKED');
  assert.equal(store.getWorkItem('recover-b')?.status, 'SUCCEEDED');
  assert.equal(store.listRecoverableAttempts().length, 0);
});

test('controller loop 只恢复当前 Goal 的中断 Attempt', async () => {
  const store = new Store();
  for (const goalId of ['g1', 'g2']) {
    store.createGoal({ id: goalId, userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    store.createWorkItem({ id: `${goalId}-w`, goalId, description: 'x', dependencies: [] });
    store.transitionWorkItem(`${goalId}-w`, 'READY');
    store.transitionWorkItem(`${goalId}-w`, 'RUNNING');
    store.startAttempt({ id: `${goalId}-a`, workItemId: `${goalId}-w`, baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: new Date().toISOString() });
  }
  const agent = { async run() { return { runId: 'r', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  await runControllerLoop(store, { goalId: 'g1', configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [{ id: 'check', command: [process.execPath, '-e', 'process.exit(0)'], required: true }], budget: {} }), agentFor: () => agent });
  assert.equal(store.getAttempt('g2-a')?.endedAt, undefined);
  assert.deepEqual(store.listRecoverableAttempts().map(attempt => attempt.id), ['g2-a']);
});

test('controller loop 不会恢复仍持有有效 lease 的 Attempt', async () => {
  const store = new Store();
  store.createGoal({ id: 'lease-goal', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'lease-w', goalId: 'lease-goal', description: 'x', dependencies: [] });
  store.transitionWorkItem('lease-w', 'READY');
  store.transitionWorkItem('lease-w', 'RUNNING');
  store.startAttempt({ id: 'lease-a', workItemId: 'lease-w', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: new Date().toISOString() });
  store.acquireLease('lease-w', 'live-owner', 60_000);
  const agent = { async run() { throw new Error('must not run'); }, async cancel() {}, async resume() { throw new Error('unused'); } };
  await runControllerLoop(store, { goalId: 'lease-goal', configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [], budget: {} }), agentFor: () => agent });
  assert.equal(store.getWorkItem('lease-w')?.status, 'RUNNING');
  assert.deepEqual(store.listRecoverableAttempts().map(attempt => attempt.id), ['lease-a']);
});

test('controller 不调度 WAITING_HUMAN/WAITING_EXTERNAL Goal，并保留 PENDING WorkItem', async () => {
  for (const mode of ['WAITING_HUMAN', 'WAITING_EXTERNAL'] as const) {
    const store = new Store();
    const goalId = `controller-${mode.toLowerCase()}`;
    const itemId = `${goalId}-item`;
    store.createGoal({ id: goalId, userIntent: 'waiting', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    store.createWorkItem({ id: itemId, goalId, description: 'waiting', dependencies: [] });
    store.transitionGoal(goalId, 'PLANNING'); store.transitionGoal(goalId, 'RUNNING');
    if (mode === 'WAITING_HUMAN') {
      store.createHumanRequest({ id: `${goalId}-request`, goalId, question: 'review', context: {}, requiredAuthority: 'review', status: 'OPEN' });
      store.transitionGoal(goalId, mode);
    } else {
      store.createOperation({ actionId: `${goalId}-operation`, idempotencyKey: `${goalId}-key`, goalId, exactRevision: 'r', intendedTarget: 'external', reconciliationStatus: 'PENDING' });
      store.transitionGoal(goalId, mode);
    }
    let calls = 0;
    const input = { goalId, configure: () => { throw new Error('must not configure waiting Goal'); }, agentFor: () => ({ async run() { calls += 1; throw new Error('must not run'); }, async cancel() {}, async resume() { throw new Error('unused'); } }) };
    const result = await runControllerLoop(store, input);
    assert.deepEqual(result.completed, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.skipped, [itemId]);
    assert.equal(calls, 0);
    assert.equal(store.getGoal(goalId)?.status, mode);
    assert.equal(store.getWorkItem(itemId)?.status, 'PENDING');
    await assert.rejects(() => runControllerRound(store, input.agentFor(), { goalId, workItemId: itemId, workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [], budget: {} }), /Goal is not runnable/);
  }
});

test('controller 不调度 FAILED Goal，且不破坏 RUNNING Goal 的 WorkItem retry', async () => {
  for (const mode of ['FAILED'] as const) {
    const store = new Store();
    const goalId = `controller-${mode.toLowerCase()}`;
    const itemId = `${goalId}-item`;
    store.createGoal({ id: goalId, userIntent: 'blocked', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    store.createWorkItem({ id: itemId, goalId, description: 'blocked', dependencies: [] });
    store.transitionGoal(goalId, 'PLANNING'); store.transitionGoal(goalId, 'RUNNING');
    if (mode === 'FAILED') {
      store.transitionGoal(goalId, 'FAILED');
    }
    let calls = 0;
    const input = { goalId, configure: () => { throw new Error('must not configure blocked Goal'); }, agentFor: () => ({ async run() { calls += 1; throw new Error('must not run'); }, async cancel() {}, async resume() { throw new Error('unused'); } }) };
    const result = await runControllerLoop(store, input);
    assert.deepEqual(result.completed, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.skipped, [itemId]);
    assert.equal(calls, 0);
    assert.equal(store.getGoal(goalId)?.status, mode);
    assert.equal(store.getWorkItem(itemId)?.status, 'PENDING');
    await assert.rejects(() => runControllerRound(store, input.agentFor(), { goalId, workItemId: itemId, workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [], budget: {} }), /Goal is not runnable/);
  }
});

test('RECOVERING Goal 无可恢复 Attempt 时保持阻断，有 Attempt 时迁移 RUNNING 并继续', async () => {
  const blocked = new Store();
  blocked.createGoal({ id: 'recovering-blocked', userIntent: 'blocked', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  blocked.createWorkItem({ id: 'recovering-blocked-item', goalId: 'recovering-blocked', description: 'blocked', dependencies: [] });
  blocked.db.prepare("UPDATE goals SET status = 'RECOVERING' WHERE id = ?").run('recovering-blocked');
  let blockedCalls = 0;
  const blockedResult = await runControllerLoop(blocked, { goalId: 'recovering-blocked', configure: () => { throw new Error('must not configure'); }, agentFor: () => ({ async run() { blockedCalls += 1; throw new Error('must not run'); }, async cancel() {}, async resume() { throw new Error('unused'); } }) });
  assert.deepEqual(blockedResult.skipped, ['recovering-blocked-item']);
  assert.equal(blockedCalls, 0);
  assert.equal(blocked.getGoal('recovering-blocked')?.status, 'RECOVERING');

  const store = new Store();
  const goalId = 'recovering-resume'; const itemId = 'recovering-resume-item';
  store.createGoal({ id: goalId, userIntent: 'resume', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: itemId, goalId, description: 'resume', dependencies: [] });
  store.transitionGoal(goalId, 'PLANNING'); store.transitionGoal(goalId, 'RUNNING');
  store.transitionWorkItem(itemId, 'READY'); store.transitionWorkItem(itemId, 'RUNNING');
  store.startAttempt({ id: 'recovering-resume-attempt', workItemId: itemId, baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: new Date().toISOString() });
  store.transitionGoal(goalId, 'RECOVERING');
  let calls = 0;
  const resumed = await runControllerLoop(store, { goalId, configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [{ id: 'pass', command: ['true'], required: true }], budget: {} }), agentFor: () => ({ async run() { calls += 1; return { runId: `resume-${calls}`, changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } }) });
  assert.deepEqual(resumed.completed, [itemId]);
  assert.equal(calls, 1);
  assert.equal(store.getGoal(goalId)?.status, 'VERIFYING');
  assert.equal(store.getWorkItem(itemId)?.status, 'SUCCEEDED');
});

test('验证阶段 lease fencing 保留未结束 Attempt，随后可恢复 RUNNING 工作项', async () => {
  const store = new Store();
  const goalId = 'verification-lease-loss-goal';
  const itemId = 'verification-lease-loss-item';
  store.createGoal({ id: goalId, userIntent: 'lease loss', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: itemId, goalId, description: 'verify', dependencies: [] });
  let leaseOwner: string | undefined;
  const renewLease = store.renewLease.bind(store);
  store.renewLease = (resourceId, owner, ttlMs, now) => { leaseOwner = owner; return renewLease(resourceId, owner, ttlMs, now); };
  let revoked = false;
  const executor = { async exec(command: { argv: string[]; cwd?: string }) {
    await new Promise(resolve => setTimeout(resolve, 5));
    if (!revoked) { revoked = true; store.revokeLease(itemId, leaseOwner!); }
    await new Promise(resolve => setTimeout(resolve, 35));
    return { argv: command.argv, stdout: '', stderr: '', exitCode: 0, timedOut: false };
  } };
  const agent = { async run() { return { runId: 'lease-loss-run', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  await assert.rejects(() => runControllerRound(store, agent, {
    goalId, workItemId: itemId, workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'local', inputDigest: 'i', budget: {},
    checks: [{ id: 'delayed-check', command: ['true'], required: true }], verificationExecutor: executor
  }), /lease is not writable|lease|writable/i);
  assert.equal(store.getWorkItem(itemId)?.status, 'RUNNING');
  assert.equal(store.listRecoverableAttempts().length, 1);
  const recovered = recoverGoalAttempts(store, goalId);
  assert.deepEqual(recovered.requeuedWorkItems, [itemId]);
  assert.equal(store.getWorkItem(itemId)?.status, 'READY');
  const resumed = await runControllerLoop(store, {
    goalId, configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'local', inputDigest: 'i', checks: [{ id: 'pass', command: ['true'], required: true }], budget: {} }), agentFor: () => agent
  });
  assert.deepEqual(resumed.completed, [itemId]);
  assert.equal(store.getWorkItem(itemId)?.status, 'SUCCEEDED');
});

test('controller loop 使用持久化 retry_state 在首轮失败后重试并通过', async () => {
  const root = mkdtempSync(join(tmpdir(), 'controller-retry-'));
  const marker = join(root, 'attempt');
  try {
    const store = new Store();
    store.createGoal({ id: 'retry-goal', userIntent: 'retry', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    store.createWorkItem({ id: 'retry-item', goalId: 'retry-goal', description: 'retry', dependencies: [] });
    let runs = 0;
    const agent = { async run() { runs += 1; writeFileSync(marker, String(runs)); return { runId: `run-${runs}`, changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
    const result = await runControllerLoop(store, {
      goalId: 'retry-goal',
      configure: () => ({ workspace: root, contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [{ id: 'second-run', command: [process.execPath, '-e', `if (require('node:fs').readFileSync(${JSON.stringify(marker)}, 'utf8') !== '2') process.exit(1)`], required: true }], budget: {}, recovery: { maxAttempts: 2, strategy: 'retry-agent' } }),
      agentFor: () => agent
    });
    assert.deepEqual(result.completed, ['retry-item']);
    assert.equal(result.rounds, 2);
    assert.ok(store.listEvents('retry-item').some(event => event.event_type === 'RETRY_RECORDED'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('controller loop stops repeated identical Gate failures as NO_PROGRESS', async () => {
  const store = new Store();
  store.createGoal({ id: 'no-progress-goal', userIntent: 'retry', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'no-progress-item', goalId: 'no-progress-goal', description: 'retry', dependencies: [] });
  const agent = { async run() { return { runId: 'same', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'same' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  const result = await runControllerLoop(store, {
    goalId: 'no-progress-goal',
    configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [{ id: 'always-fail', command: [process.execPath, '-e', 'process.exit(1)'], required: true }], budget: {}, recovery: { maxAttempts: 3, strategy: 'same-strategy' } }),
    agentFor: () => agent
  });
  assert.deepEqual(result.failed, ['no-progress-item']);
  assert.equal(result.rounds, 2);
  assert.equal(store.getWorkItem('no-progress-item')?.status, 'FAILED');
});

test('controller loop requeues a persisted RETRY decision after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'controller-retry-restart-'));
  const path = join(root, 'state.sqlite');
  const first = new Store(path);
  first.createGoal({ id: 'restart-retry-goal', userIntent: 'retry', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  first.createWorkItem({ id: 'restart-retry-item', goalId: 'restart-retry-goal', description: 'retry', dependencies: [] });
  first.transitionWorkItem('restart-retry-item', 'READY');
  first.transitionWorkItem('restart-retry-item', 'RUNNING');
  first.transitionWorkItem('restart-retry-item', 'FAILED');
  assert.deepEqual(first.nextRetry('restart-retry-item', 'crashed-after-retry-decision', 2), { retry: true, reason: 'RETRY' });
  first.close();

  const second = new Store(path);
  const agent = { async run() { return { runId: 'restart-run', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'recovered' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  const result = await runControllerLoop(second, {
    goalId: 'restart-retry-goal',
    configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [{ id: 'pass', command: ['true'], required: true }], budget: {}, recovery: { maxAttempts: 2, strategy: 'restart-retry' } }),
    agentFor: () => agent
  });
  assert.deepEqual(result.completed, ['restart-retry-item']);
  assert.equal(result.rounds, 1);
  second.close();
  rmSync(root, { recursive: true, force: true });
});

test('controller loop 根据失败分类切换下一轮策略', async () => {
  const store = new Store();
  store.createGoal({ id: 'strategy-goal', userIntent: 'strategy', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'strategy-item', goalId: 'strategy-goal', description: 'strategy', dependencies: [] });
  const strategies: Array<string | undefined> = [];
  const agent = { async run() { return { runId: 'strategy-run', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  const result = await runControllerLoop(store, {
    goalId: 'strategy-goal',
    configure: (_item, context) => ({
      workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i',
      checks: [{ id: 'strategy-check', command: [process.execPath, '-e', context?.strategy === 'repair-tests' ? 'process.exit(0)' : 'process.exit(1)'], required: true }],
      budget: {}, recovery: { maxAttempts: 2, strategy: 'baseline' }
    }),
    agentFor: (_item, context) => { strategies.push(context?.strategy); return agent; },
    strategyFor: (_item, failureKind, attempt) => {
      assert.equal(failureKind, 'TEST_FAILURE');
      assert.equal(attempt, 2);
      return 'repair-tests';
    }
  });
  assert.deepEqual(result.completed, ['strategy-item']);
  assert.equal(result.rounds, 2);
  assert.deepEqual(strategies, ['baseline', 'repair-tests']);
});

test('controller loop defers a work item whose lease belongs to another controller', async () => {
  const store = new Store();
  store.createGoal({ id: 'contended-goal', userIntent: 'contended', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'contended-item', goalId: 'contended-goal', description: 'contended', dependencies: [] });
  store.acquireLease('contended-item', 'other-controller', 60_000);
  const agent = { async run() { throw new Error('must not run'); }, async cancel() {}, async resume() { throw new Error('unused'); } };
  const result = await runControllerLoop(store, {
    goalId: 'contended-goal',
    configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [], budget: {} }),
    agentFor: () => agent
  });
  assert.deepEqual(result.completed, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped, ['contended-item']);
  assert.equal(store.getWorkItem('contended-item')?.status, 'PENDING');
});

test('两个 controller 对同一批独立工作项并发调度时不重复执行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'controller-batch-contention-'));
  const path = join(root, 'state.sqlite');
  const first = new Store(path);
  const second = new Store(path);
  const goalId = 'batch-contention-goal';
  const itemIds = ['batch-a', 'batch-b', 'batch-c', 'batch-d'];
  first.createGoal({ id: goalId, userIntent: 'batch contention', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  for (const id of itemIds) first.createWorkItem({ id, goalId, description: id, dependencies: [] });
  let agentRuns = 0;
  const agent = { async run() { agentRuns += 1; await new Promise(resolve => setTimeout(resolve, 20)); return { runId: `batch-${agentRuns}`, changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  const configure = () => ({ workspace: root, contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [{ id: 'pass', command: [process.execPath, '-e', 'process.exit(0)'], required: true }], budget: {} });
  try {
    const [firstResult, secondResult] = await Promise.all([
      runControllerLoop(first, { goalId, maxConcurrency: 2, configure, agentFor: () => agent }),
      runControllerLoop(second, { goalId, maxConcurrency: 2, configure, agentFor: () => agent })
    ]);
    assert.equal(agentRuns, itemIds.length);
    assert.deepEqual(itemIds.filter(id => firstResult.completed.includes(id) || secondResult.completed.includes(id)).sort(), itemIds);
    assert.deepEqual(first.listWorkItems(goalId).map(item => item.status), itemIds.map(() => 'SUCCEEDED'));
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('goal-level leader lease 只允许一个 controller 调度，并可在退出后接管', async () => {
  const root = mkdtempSync(join(tmpdir(), 'controller-leader-'));
  const path = join(root, 'state.sqlite');
  const first = new Store(path);
  const second = new Store(path);
  const goalId = 'leader-goal';
  first.createGoal({ id: goalId, userIntent: 'leader', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  first.createWorkItem({ id: 'leader-item', goalId, description: 'leader', dependencies: [] });
  let runs = 0;
  const agent = { async run() { runs += 1; await new Promise(resolve => setTimeout(resolve, 30)); return { runId: `leader-${runs}`, changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  const configure = () => ({ workspace: root, contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [{ id: 'pass', command: [process.execPath, '-e', 'process.exit(0)'], required: true }], budget: {} });
  try {
    const firstRun = runControllerLoop(first, { goalId, leaderElection: { controllerId: 'one', leaseTtlMs: 1_000 }, configure, agentFor: () => agent });
    await new Promise(resolve => setTimeout(resolve, 5));
    const follower = await runControllerLoop(second, { goalId, leaderElection: { controllerId: 'two', leaseTtlMs: 1_000 }, configure, agentFor: () => agent });
    const leader = await firstRun;
    assert.deepEqual(follower.completed, []);
    assert.deepEqual(follower.skipped, ['leader-item']);
    assert.deepEqual(leader.completed, ['leader-item']);
    assert.equal(runs, 1);

    const takeover = await runControllerLoop(second, { goalId, leaderElection: { controllerId: 'two', leaseTtlMs: 1_000 }, configure, agentFor: () => agent });
    assert.deepEqual(takeover.completed, []);
    assert.deepEqual(takeover.skipped, []);
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('leader lease 丢失后旧 controller 停止调度后续工作项', async () => {
  const root = mkdtempSync(join(tmpdir(), 'controller-leader-loss-'));
  const path = join(root, 'state.sqlite');
  const first = new Store(path);
  const second = new Store(path);
  const goalId = 'leader-loss-goal';
  first.createGoal({ id: goalId, userIntent: 'leader loss', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  first.createWorkItem({ id: 'leader-loss-a', goalId, description: 'a', dependencies: [] });
  first.createWorkItem({ id: 'leader-loss-b', goalId, description: 'b', dependencies: [] });
  let runs = 0;
  const agent = { async run() { runs += 1; if (runs === 1) second.revokeLease(`goal-leader:${goalId}`, 'controller-leader:one'); return { runId: `loss-${runs}`, changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  const configure = () => ({ workspace: root, contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [{ id: 'pass', command: [process.execPath, '-e', 'process.exit(0)'], required: true }], budget: {} });
  try {
    await assert.rejects(
      runControllerLoop(first, { goalId, maxConcurrency: 1, leaderElection: { controllerId: 'one', leaseTtlMs: 1_000 }, configure, agentFor: () => agent }),
      (error: unknown) => error instanceof LeaderLeaseLostError
    );
    assert.equal(runs, 1);
    assert.equal(first.getWorkItem('leader-loss-a')?.status, 'SUCCEEDED');
    assert.equal(first.getWorkItem('leader-loss-b')?.status, 'PENDING');
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('单工作项在 leader lease 丢失后也不会伪装成功', async () => {
  const root = mkdtempSync(join(tmpdir(), 'controller-leader-single-loss-'));
  const path = join(root, 'state.sqlite');
  const first = new Store(path);
  const second = new Store(path);
  const goalId = 'leader-single-loss-goal';
  first.createGoal({ id: goalId, userIntent: 'leader single loss', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  first.createWorkItem({ id: 'leader-single-loss-item', goalId, description: 'single', dependencies: [] });
  const agent = { async run() { second.revokeLease(`goal-leader:${goalId}`, 'controller-leader:one'); return { runId: 'single-loss', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  const configure = () => ({ workspace: root, contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [{ id: 'pass', command: [process.execPath, '-e', 'process.exit(0)'], required: true }], budget: {} });
  try {
    await assert.rejects(
      runControllerLoop(first, { goalId, leaderElection: { controllerId: 'one', leaseTtlMs: 1_000 }, configure, agentFor: () => agent }),
      (error: unknown) => error instanceof LeaderLeaseLostError
    );
    assert.equal(first.getWorkItem('leader-single-loss-item')?.status, 'SUCCEEDED');
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('controller pool 按 Goal round-robin 推进持久化工作项', async () => {
  const store = new Store();
  const order: string[] = [];
  for (const goalId of ['pool-a', 'pool-b']) {
    store.createGoal({ id: goalId, userIntent: 'pool', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    for (const suffix of ['one', 'two']) store.createWorkItem({ id: `${goalId}-${suffix}`, goalId, description: suffix, dependencies: [] });
  }
  const inputs = ['pool-a', 'pool-b'].map(goalId => ({
    goalId,
    configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: goalId, environmentFingerprint: 'local', inputDigest: goalId, checks: [{ id: 'pass', command: ['true'], required: true }], budget: {} }),
    agentFor: (item: WorkItem) => ({ async run() { order.push(`${goalId}:${item.id}`); return { runId: `${goalId}-${item.id}`, changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } })
  }));
  const result = await runControllerPool(store, inputs, { maxConcurrency: 1 });
  assert.deepEqual(order, ['pool-a:pool-a-one', 'pool-b:pool-b-one', 'pool-a:pool-a-two', 'pool-b:pool-b-two']);
  assert.deepEqual(result.completed, ['pool-a', 'pool-b']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.turns, 4);
  assert.equal(store.getWorkItem('pool-a-two')?.status, 'SUCCEEDED');
  assert.equal(store.getWorkItem('pool-b-two')?.status, 'SUCCEEDED');
});

test('controller pool bounded soak 多 Goal 多轮后收敛且不重复 Attempt', async () => {
  const store = new Store();
  const goalIds = Array.from({ length: 8 }, (_, index) => `soak-${index}`);
  for (const goalId of goalIds) {
    store.createGoal({ id: goalId, userIntent: 'soak', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    for (const suffix of ['a', 'b', 'c']) store.createWorkItem({ id: `${goalId}-${suffix}`, goalId, description: suffix, dependencies: [] });
  }
  const runs = new Set<string>();
  const inputs = goalIds.map(goalId => ({
    goalId,
    configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: goalId, environmentFingerprint: 'local', inputDigest: goalId, checks: [{ id: 'pass', command: ['true'], required: true }], budget: {} }),
    agentFor: (item: WorkItem) => ({ async run() { const key = `${goalId}:${item.id}`; assert.equal(runs.has(key), false); runs.add(key); await new Promise(resolve => setTimeout(resolve, 1)); return { runId: key, changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } })
  }));
  const result = await runControllerPool(store, inputs, { maxConcurrency: 2, maxTurns: 40 });
  assert.deepEqual(result.completed.sort(), goalIds.slice().sort());
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.turns, goalIds.length * 3);
  assert.equal(runs.size, goalIds.length * 3);
  assert.equal(store.listAttempts().length, goalIds.length * 3);
  assert.equal(store.listAttempts().filter(attempt => attempt.endedAt === undefined).length, 0);
});

test('controller pool worker 可中止且不篡改尚未执行的工作项', async () => {
  const store = new Store();
  const abort = new AbortController();
  for (const goalId of ['worker-abort-a', 'worker-abort-b']) {
    store.createGoal({ id: goalId, userIntent: 'worker', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    store.createWorkItem({ id: `${goalId}-item`, goalId, description: goalId, dependencies: [] });
  }
  const input = (goalId: string) => ({
    goalId,
    configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: goalId, environmentFingerprint: 'local', inputDigest: goalId, checks: [{ id: 'pass', command: ['true'], required: true }], budget: {} }),
    agentFor: () => ({ async run() { await new Promise(resolve => setTimeout(resolve, 5)); abort.abort(); return { runId: goalId, changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } })
  });
  const result = await runControllerPoolWorker(store, [input('worker-abort-a'), input('worker-abort-b')], { signal: abort.signal, pollIntervalMs: 0, maxIdlePolls: 2 });
  assert.equal(result.stopReason, 'ABORTED');
  assert.equal(store.getWorkItem('worker-abort-a-item')?.status, 'SUCCEEDED');
  assert.equal(store.getWorkItem('worker-abort-b-item')?.status, 'PENDING');
});

test('controller pool worker 以 idle poll 上限停止 lease contention 且可持续轮询', async () => {
  const store = new Store();
  const goalId = 'worker-idle-goal';
  store.createGoal({ id: goalId, userIntent: 'worker', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'worker-idle-item', goalId, description: 'idle', dependencies: [] });
  store.acquireLease('worker-idle-item', 'another-controller', 60_000);
  const result = await runControllerPoolWorker(store, [{
    goalId,
    configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'local', inputDigest: 'i', checks: [], budget: {} }),
    agentFor: () => { throw new Error('must not run'); }
  }], { pollIntervalMs: 0, maxIdlePolls: 2 });
  assert.equal(result.stopReason, 'IDLE_LIMIT');
  assert.equal(result.polls, 2);
  assert.equal(store.getWorkItem('worker-idle-item')?.status, 'PENDING');
});

test('controller pool worker 聚合 Agent throw 为终态 FAILED，而不是 idle skipped', async () => {
  const store = new Store();
  const goalId = 'worker-agent-failed';
  store.createGoal({ id: goalId, userIntent: 'worker', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: `${goalId}-item`, goalId, description: 'throw', dependencies: [] });
  const result = await runControllerPoolWorker(store, [{
    goalId,
    configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'local', inputDigest: 'i', checks: [], budget: {} }),
    agentFor: () => ({ async run() { throw new Error('agent failed'); }, async cancel() {}, async resume() { throw new Error('unused'); } })
  }], { pollIntervalMs: 0, maxIdlePolls: 2 });
  assert.equal(result.stopReason, 'FAILED');
  assert.deepEqual(result.failed, [goalId]);
  assert.deepEqual(result.skipped, []);
  assert.equal(store.getWorkItem(`${goalId}-item`)?.status, 'FAILED');
});

test('controller pool worker 将无 recovery 的 gate failure 聚合为终态 FAILED', async () => {
  const store = new Store();
  const goalId = 'worker-gate-failed';
  store.createGoal({ id: goalId, userIntent: 'worker', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: `${goalId}-item`, goalId, description: 'gate', dependencies: [] });
  const result = await runControllerPoolWorker(store, [{
    goalId,
    configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'local', inputDigest: 'i', checks: [{ id: 'fail', command: ['false'], required: true }], budget: {} }),
    agentFor: () => ({ async run() { return { runId: 'gate-run', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } })
  }], { pollIntervalMs: 0, maxIdlePolls: 2 });
  assert.equal(result.stopReason, 'FAILED');
  assert.deepEqual(result.failed, [goalId]);
  assert.deepEqual(result.skipped, []);
  assert.equal(store.getWorkItem(`${goalId}-item`)?.status, 'FAILED');
});

test('controller pool worker 保留 FAILED+RETRY 并继续轮询至成功', async () => {
  const root = mkdtempSync(join(tmpdir(), 'controller-worker-retry-'));
  const marker = join(root, 'attempt');
  try {
    const store = new Store();
    const goalId = 'worker-retry';
    const itemId = `${goalId}-item`;
    store.createGoal({ id: goalId, userIntent: 'worker', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    store.createWorkItem({ id: itemId, goalId, description: 'retry', dependencies: [] });
    let runs = 0;
    const result = await runControllerPoolWorker(store, [{
      goalId,
      configure: () => ({ workspace: root, contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'local', inputDigest: 'i', checks: [{ id: 'second-run', command: [process.execPath, '-e', `if (require('node:fs').readFileSync(${JSON.stringify(marker)}, 'utf8') !== '2') process.exit(1)`], required: true }], budget: {}, recovery: { maxAttempts: 2, strategy: 'retry' } }),
      agentFor: () => ({ async run() { runs += 1; writeFileSync(marker, String(runs)); return { runId: `run-${runs}`, changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } })
    }], { pollIntervalMs: 0, maxIdlePolls: 2 });
    assert.equal(result.stopReason, 'COMPLETED');
    assert.deepEqual(result.completed, [goalId]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.skipped, []);
    assert.equal(runs, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
