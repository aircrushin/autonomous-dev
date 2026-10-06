import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/database.js';
import { runControllerRound } from '../../src/controller/controller.js';

const agent = { async run() { return { runId: 'r1', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'claimed done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
const failedAgent = { async run() { return { runId: 'r2', changedPaths: [], result: 'FAILED' as const, summary: 'crashed' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
const crashingAgent = { async run() { throw new Error('agent crashed'); }, async cancel() {}, async resume() { throw new Error('unused'); } };
const slowAgent = { async run() { await new Promise(resolve => setTimeout(resolve, 80)); return { runId: 'slow', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };

test('Agent 修改验收脚本依赖时，控制器拒绝旧检查结果', async () => {
  const root = mkdtempSync(join(tmpdir(), 'controller-check-dependency-'));
  try {
    const check = join(root, 'check.js');
    writeFileSync(check, 'process.exit(1);\n');
    const store = new Store();
    store.createGoal({ id: 'check-dep-goal', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    store.createWorkItem({ id: 'check-dep-item', goalId: 'check-dep-goal', description: 'x', dependencies: [] });
    await assert.rejects(() => runControllerRound(store, { async run() { writeFileSync(check, 'process.exit(0);\n'); return { runId: 'r', changedPaths: [check], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } }, { goalId: 'check-dep-goal', workItemId: 'check-dep-item', workspace: root, contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'local', inputDigest: 'i', checks: [{ id: 'script', command: [process.execPath, check], required: true }], budget: {} }), /check dependency changed/);
    assert.equal(store.getWorkItem('check-dep-item')?.status, 'FAILED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pnpm test runner 绑定 package.json 与 tests 文件基线', async () => {
  const root = mkdtempSync(join(tmpdir(), 'controller-test-runner-dependency-'));
  try {
    const testsDir = join(root, 'tests', 'unit');
    const packagePath = join(root, 'package.json');
    const testPath = join(testsDir, 'check.test.ts');
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(packagePath, '{"scripts":{"test":"node tests/check.test.ts"}}\n');
    writeFileSync(testPath, 'process.exit(1);\n');
    const store = new Store();
    store.createGoal({ id: 'runner-dep-goal', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    store.createWorkItem({ id: 'runner-dep-item', goalId: 'runner-dep-goal', description: 'x', dependencies: [] });
    await assert.rejects(() => runControllerRound(store, { async run() { writeFileSync(testPath, 'process.exit(0);\n'); return { runId: 'r', changedPaths: [testPath], result: 'SUCCEEDED' as const, summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } }, { goalId: 'runner-dep-goal', workItemId: 'runner-dep-item', workspace: root, contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'local', inputDigest: 'i', checks: [{ id: 'runner', command: ['pnpm', 'test'], required: true }], budget: {} }), /check dependency changed/);
    assert.equal(store.getWorkItem('runner-dep-item')?.status, 'FAILED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Agent 自报完成但验证失败时，控制器拒绝完成', async () => {
  const store = new Store();
  store.createGoal({ id: 'cg', userIntent: '实现功能', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'cw', goalId: 'cg', description: '修改代码', dependencies: [] });
  const result = await runControllerRound(store, agent, { goalId: 'cg', workItemId: 'cw', workspace: process.cwd(), contractVersion: 'c1', candidateDigest: 'candidate', environmentFingerprint: 'env', inputDigest: 'input', budget: { maxRuns: 1 }, checks: [{ id: 'must-fail', command: ['node', '-e', 'process.exit(2)'], required: true }] });
  assert.equal(result.agentResult.result, 'SUCCEEDED');
  assert.equal(result.gate.result, 'REPAIR');
  assert.equal(store.getWorkItem('cw')?.status, 'FAILED');
  assert.notEqual(store.getGoal('cg')?.status, 'SUCCEEDED');
});

test('Agent 失败时即使检查通过也不能放行', async () => {
  const store = new Store();
  store.createGoal({ id: 'cg2', userIntent: '实现功能', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'cw2', goalId: 'cg2', description: '修改代码', dependencies: [] });
  const result = await runControllerRound(store, failedAgent, { goalId: 'cg2', workItemId: 'cw2', workspace: process.cwd(), contractVersion: 'c1', candidateDigest: 'candidate', environmentFingerprint: 'env', inputDigest: 'input', budget: { maxRuns: 1 }, checks: [{ id: 'pass', command: ['true'], required: true }] });
  assert.equal(result.gate.result, 'REPAIR');
  assert.equal(store.getWorkItem('cw2')?.status, 'FAILED');
});

test('多个 WorkItem 未全部完成时 Goal 保持 RUNNING，全部完成后才进入 VERIFYING', async () => {
  const store = new Store();
  store.createGoal({ id: 'cg-multi', userIntent: '实现功能', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'cg-multi-a', goalId: 'cg-multi', description: 'a', dependencies: [] });
  store.createWorkItem({ id: 'cg-multi-b', goalId: 'cg-multi', description: 'b', dependencies: [] });
  const input = (workItemId: string) => ({ goalId: 'cg-multi', workItemId, workspace: process.cwd(), contractVersion: 'c1', candidateDigest: 'candidate', environmentFingerprint: 'env', inputDigest: 'input', budget: {}, checks: [{ id: 'pass', command: ['true'], required: true }] });
  await runControllerRound(store, agent, input('cg-multi-a'));
  assert.equal(store.getGoal('cg-multi')?.status, 'RUNNING');
  await runControllerRound(store, agent, input('cg-multi-b'));
  assert.equal(store.getGoal('cg-multi')?.status, 'VERIFYING');
});

test('Agent 后解析最新 candidate digest，并将其绑定到 Evidence', async () => {
  const store = new Store();
  store.createGoal({ id: 'cg-fresh-digest', userIntent: '实现功能', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'cw-fresh-digest', goalId: 'cg-fresh-digest', description: '修改代码', dependencies: [] });
  const result = await runControllerRound(store, agent, { goalId: 'cg-fresh-digest', workItemId: 'cw-fresh-digest', workspace: process.cwd(), contractVersion: 'c1', candidateDigest: 'stale', resolveCandidateDigest: async () => 'fresh-after-agent', environmentFingerprint: 'env', inputDigest: 'input', budget: {}, checks: [{ id: 'pass', command: ['true'], required: true }] });
  assert.equal(result.resolvedCandidateDigest, 'fresh-after-agent');
  assert.equal(result.verification[0]?.candidateDigest, 'fresh-after-agent');
  assert.equal(store.listEvidence()[0]?.candidateDigest, 'fresh-after-agent');
});

test('candidate digest resolver 失败或返回空值时拒绝并不写 Evidence', async () => {
  for (const [id, resolver, message] of [
    ['cg-digest-error', async () => { throw new Error('digest unavailable'); }, /digest unavailable/],
    ['cg-digest-empty', async () => '   ', /resolved candidate digest is required/]
  ] as const) {
    const store = new Store();
    const workItemId = `${id}-item`;
    store.createGoal({ id, userIntent: '实现功能', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    store.createWorkItem({ id: workItemId, goalId: id, description: '修改代码', dependencies: [] });
    await assert.rejects(() => runControllerRound(store, agent, { goalId: id, workItemId, workspace: process.cwd(), contractVersion: 'c1', candidateDigest: 'stale', resolveCandidateDigest: resolver, environmentFingerprint: 'env', inputDigest: 'input', budget: {}, checks: [{ id: 'pass', command: ['true'], required: true }] }), message);
    assert.equal(store.listEvidence().length, 0);
    assert.equal(store.getWorkItem(workItemId)?.status, 'FAILED');
  }
});

test('越权动作在 Agent 启动前被拒绝', async () => {
  const store = new Store();
  store.createGoal({ id: 'cg3', userIntent: '实现功能', constraints: [], acceptanceContract: {}, authorizationPolicy: { allowedActions: ['review'] }, budget: {} });
  store.createWorkItem({ id: 'cw3', goalId: 'cg3', description: '修改代码', dependencies: [] });
  await assert.rejects(() => runControllerRound(store, agent, { goalId: 'cg3', workItemId: 'cw3', workspace: process.cwd(), contractVersion: 'c1', candidateDigest: 'candidate', environmentFingerprint: 'env', inputDigest: 'input', budget: {}, action: 'deploy', checks: [] }), /not authorized/);
  assert.equal(store.getWorkItem('cw3')?.status, 'PENDING');
});

test('授权策略版本变化时拒绝继续执行', async () => {
  const store = new Store();
  store.createGoal({ id: 'cg-version', userIntent: '实现功能', constraints: [], acceptanceContract: {}, authorizationPolicy: { version: 'v2' }, budget: {} });
  store.createWorkItem({ id: 'cw-version', goalId: 'cg-version', description: '修改代码', dependencies: [] });
  await assert.rejects(() => runControllerRound(store, agent, { goalId: 'cg-version', workItemId: 'cw-version', workspace: process.cwd(), contractVersion: 'c1', candidateDigest: 'candidate', environmentFingerprint: 'env', inputDigest: 'input', budget: {}, authorizationPolicyVersion: 'v1', checks: [] }), /policy version changed/);
  assert.equal(store.getWorkItem('cw-version')?.status, 'PENDING');
});

test('验收契约版本不匹配时拒绝使用旧证据', async () => {
  const store = new Store();
  store.createGoal({ id: 'cg-contract', userIntent: '实现功能', constraints: [], acceptanceContract: { version: 2 }, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'cw-contract', goalId: 'cg-contract', description: '修改代码', dependencies: [] });
  await assert.rejects(() => runControllerRound(store, agent, { goalId: 'cg-contract', workItemId: 'cw-contract', workspace: process.cwd(), contractVersion: '1', candidateDigest: 'candidate', environmentFingerprint: 'env', inputDigest: 'input', budget: {}, checks: [] }), /contract version changed/);
  assert.equal(store.getWorkItem('cw-contract')?.status, 'PENDING');
});

test('执行期间方向或授权改变时，控制器拒绝旧轮次', async () => {
  const store = new Store();
  store.createGoal({ id: 'cg-mutation', userIntent: '实现功能', constraints: [], acceptanceContract: { version: 1 }, authorizationPolicy: { allowedActions: ['edit'] }, budget: {} });
  store.createWorkItem({ id: 'cw-mutation', goalId: 'cg-mutation', description: '修改代码', dependencies: [] });
  const mutatingAgent = { ...agent, async run() {
    store.updateAuthorizationPolicy('cg-mutation', { allowedActions: [] });
    store.updateGoalDirection('cg-mutation', { userIntent: '新方向' });
    return { runId: 'mutating', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' };
  } };
  await assert.rejects(() => runControllerRound(store, mutatingAgent, { goalId: 'cg-mutation', workItemId: 'cw-mutation', workspace: process.cwd(), contractVersion: '1', candidateDigest: 'candidate', environmentFingerprint: 'env', inputDigest: 'input', budget: {}, action: 'edit', checks: [{ id: 'pass', command: ['true'], required: true }] }), /changed during execution/);
  assert.equal(store.getWorkItem('cw-mutation')?.status, 'FAILED');
});

test('验证期间方向变更也不能提交旧证据', async () => {
  const store = new Store();
  store.createGoal({ id: 'cg-verify-race', userIntent: '实现功能', constraints: [], acceptanceContract: { version: 1 }, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'cw-verify-race', goalId: 'cg-verify-race', description: '修改代码', dependencies: [] });
  const racingAgent = { ...agent, async run() {
    setTimeout(() => store.updateGoalDirection('cg-verify-race', { userIntent: '新方向' }), 10).unref?.();
    return { runId: 'race', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'done' };
  } };
  await assert.rejects(() => runControllerRound(store, racingAgent, { goalId: 'cg-verify-race', workItemId: 'cw-verify-race', workspace: process.cwd(), contractVersion: '1', candidateDigest: 'candidate', environmentFingerprint: 'env', inputDigest: 'input', budget: {}, checks: [{ id: 'slow-pass', command: [process.execPath, '-e', 'setTimeout(() => {}, 100)'], required: true }] }), /changed/);
  assert.notEqual(store.getWorkItem('cw-verify-race')?.status, 'SUCCEEDED');
});

test('Agent 崩溃会留下可恢复 Attempt 并释放租约', async () => {
  const store = new Store();
  store.createGoal({ id: 'cg4', userIntent: '实现功能', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'cw4', goalId: 'cg4', description: '修改代码', dependencies: [] });
  await assert.rejects(() => runControllerRound(store, crashingAgent, { goalId: 'cg4', workItemId: 'cw4', workspace: process.cwd(), contractVersion: 'c1', candidateDigest: 'candidate', environmentFingerprint: 'env', inputDigest: 'input', budget: {}, checks: [] }), /agent crashed/);
  assert.equal(store.listRecoverableAttempts().length, 1);
  const leaseOwner = store.listEvents('cw4').find(row => row.event_type === 'LEASE_ACQUIRED')?.payload_json;
  assert.ok(leaseOwner);
});

test('长 Agent 运行期间 heartbeat 会续租', async () => {
  const store = new Store();
  store.createGoal({ id: 'cg5', userIntent: '实现功能', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'cw5', goalId: 'cg5', description: '修改代码', dependencies: [] });
  const result = await runControllerRound(store, slowAgent, { goalId: 'cg5', workItemId: 'cw5', workspace: process.cwd(), contractVersion: 'c1', candidateDigest: 'candidate', environmentFingerprint: 'env', inputDigest: 'input', budget: {}, leaseTtlMs: 200, checks: [{ id: 'pass', command: ['true'], required: true }] });
  assert.equal(result.gate.result, 'ALLOW');
});

test('控制器将独立检查交给指定执行器并依据环境回执拒绝完成', async () => {
  const store = new Store();
  store.createGoal({ id: 'cg-environment', userIntent: '实现功能', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'cw-environment', goalId: 'cg-environment', description: '修改代码', dependencies: [] });
  let calls = 0;
  const result = await runControllerRound(store, agent, { goalId: 'cg-environment', workItemId: 'cw-environment', workspace: '/remote/workspace', contractVersion: 'v1', candidateDigest: 'candidate', environmentFingerprint: 'remote', inputDigest: 'input', budget: {}, checks: [{ id: 'remote-check', command: ['true'], required: true }], verificationExecutor: { async exec(command) {
    calls++;
    assert.equal(command.cwd, '/remote/workspace');
    return { argv: command.argv, stdout: '', stderr: 'remote failure', exitCode: 2, timedOut: false };
  } } });
  assert.equal(calls, 3);
  assert.equal(result.verification[0].status, 'FAIL');
  assert.equal(result.gate.result, 'REPAIR');
  assert.equal(store.getWorkItem('cw-environment')?.status, 'FAILED');
});

test('控制器将验证产物引用写入 Evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'controller-artifacts-'));
  try {
    const store = new Store();
    store.createGoal({ id: 'cg-artifacts', userIntent: '实现功能', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    store.createWorkItem({ id: 'cw-artifacts', goalId: 'cg-artifacts', description: '修改代码', dependencies: [] });
    const result = await runControllerRound(store, agent, { goalId: 'cg-artifacts', workItemId: 'cw-artifacts', workspace: root, contractVersion: 'c1', candidateDigest: 'candidate', environmentFingerprint: 'env', inputDigest: 'input', artifactDir: join(root, 'artifacts'), budget: { maxRuns: 1 }, checks: [{ id: 'artifact-check', command: [process.execPath, '-e', "process.stdout.write('controller-out')"], required: true }] });
    assert.equal(result.gate.result, 'ALLOW');
    const evidence = store.listEvidence()[0]!;
    assert.equal(evidence.rawArtifactRefs.length, 2);
    assert.equal(readFileSync(evidence.rawArtifactRefs.find(ref => ref.endsWith('-stdout.log'))!, 'utf8'), 'controller-out');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
