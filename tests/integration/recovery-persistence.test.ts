import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/database.js';
import { runControllerLoop } from '../../src/controller/loop.js';
import { spawn } from 'node:child_process';

test('租约和重试指纹在重启后仍然生效', () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-'));
  const path = join(root, 'state.sqlite');
  const first = new Store(path);
  first.acquireLease('w', 'owner', 10_000, 100);
  assert.throws(() => first.acquireLease('w', 'old', 10_000, 101), /held/);
  first.createGoal({ id: 'g', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  first.createWorkItem({ id: 'wi', goalId: 'g', description: 'x', dependencies: [] });
  assert.deepEqual(first.nextRetry('wi', 'f1', 2), { retry: true, reason: 'RETRY' });
  first.close();
  const second = new Store(path);
  assert.throws(() => second.assertLease('w', 'old', 102), /not writable/);
  assert.deepEqual(second.nextRetry('wi', 'f1', 2), { retry: false, reason: 'NO_PROGRESS' });
  assert.deepEqual(second.nextRetry('wi', 'f2', 2), { retry: true, reason: 'RETRY' });
  second.close();
  rmSync(root, { recursive: true, force: true });
});

test('租约校验与 WorkItem 写入处于同一事务，Operation 回执可恢复', () => {
  const store = new Store();
  store.createGoal({ id: 'g2', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'wi2', goalId: 'g2', description: 'x', dependencies: [] });
  store.acquireLease('wi2', 'owner', 1000);
  assert.equal(store.transitionWorkItemWithLease('wi2', 'READY', 'wi2', 'owner').status, 'READY');
  assert.throws(() => store.transitionWorkItemWithLease('wi2', 'RUNNING', 'wi2', 'old'), /not writable/);
  store.createOperation({ actionId: 'op2', idempotencyKey: 'idem2', exactRevision: 'r2', intendedTarget: 'pr', reconciliationStatus: 'PENDING' });
  assert.equal(store.updateOperationReceipt('op2', { externalId: 'pr2' }, 'SUCCEEDED').reconciliationStatus, 'SUCCEEDED');
  assert.deepEqual(store.getOperation('op2')?.externalReceipt, { externalId: 'pr2' });
  store.renewLease('wi2', 'owner', 2000, 500);
  assert.doesNotThrow(() => store.assertLease('wi2', 'owner', 2001));
  store.close();
});

test('第二个 Store 进程可恢复前一个控制器留下的 Attempt 并继续工作项', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-cross-store-'));
  const path = join(root, 'state.sqlite');
  const first = new Store(path);
  first.createGoal({ id: 'cross-goal', userIntent: 'recover', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  first.createWorkItem({ id: 'cross-item', goalId: 'cross-goal', description: 'recover item', dependencies: [] });
  first.transitionWorkItem('cross-item', 'READY');
  first.transitionWorkItem('cross-item', 'RUNNING');
  first.startAttempt({ id: 'cross-attempt', workItemId: 'cross-item', baseRevision: 'base', workspaceId: 'workspace', agent: 'agent', startedAt: new Date().toISOString() });
  first.close();

  const second = new Store(path);
  const agent = { async run() { return { runId: 'recovered-run', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'recovered' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  const result = await runControllerLoop(second, {
    goalId: 'cross-goal',
    configure: () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'base', environmentFingerprint: 'local', inputDigest: 'cross-input', checks: [{ id: 'pass', command: ['true'], required: true }], budget: {} }),
    agentFor: () => agent
  });
  assert.deepEqual(result.completed, ['cross-item']);
  assert.equal(second.getAttempt('cross-attempt')?.result && typeof second.getAttempt('cross-attempt')?.result === 'object' ? (second.getAttempt('cross-attempt')?.result as { recovered?: boolean }).recovered : false, true);
  assert.ok(second.listEvents('cross-attempt').some(event => event.event_type === 'ATTEMPT_RECOVERED'));
  assert.equal(second.getWorkItem('cross-item')?.status, 'SUCCEEDED');
  second.close();
  rmSync(root, { recursive: true, force: true });
});

test('恢复编排把历史执行次数和恢复原因传给下一轮，而不重放已结束 Attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-seed-'));
  const path = join(root, 'state.sqlite');
  const first = new Store(path);
  first.createGoal({ id: 'seed-goal', userIntent: 'recover with context', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  first.createWorkItem({ id: 'seed-item', goalId: 'seed-goal', description: 'recover item', dependencies: [] });
  first.transitionWorkItem('seed-item', 'READY');
  first.transitionWorkItem('seed-item', 'RUNNING');
  first.recordAttempt({ id: 'finished-attempt', workItemId: 'seed-item', baseRevision: 'r1', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z', result: { ok: true } });
  first.transitionWorkItem('seed-item', 'FAILED');
  first.transitionWorkItem('seed-item', 'READY');
  first.transitionWorkItem('seed-item', 'RUNNING');
  first.startAttempt({ id: 'interrupted-attempt', workItemId: 'seed-item', baseRevision: 'r2', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-02T00:00:00Z' });
  first.close();

  const second = new Store(path);
  let seenContext: { attempt?: number; failureKind?: string } | undefined;
  const agent = { async run() { return { runId: 'seed-recovered', changedPaths: [], result: 'SUCCEEDED' as const, summary: 'recovered' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
  const result = await runControllerLoop(second, {
    goalId: 'seed-goal',
    configure: (_item, context) => {
      seenContext = context;
      return { workspace: process.cwd(), contractVersion: '1', candidateDigest: 'r2', environmentFingerprint: 'local', inputDigest: 'seed-input', checks: [{ id: 'pass', command: ['true'], required: true }], budget: {} };
    },
    agentFor: () => agent
  });
  assert.deepEqual(result.completed, ['seed-item']);
  assert.deepEqual(seenContext, { attempt: 3, failureKind: 'RUNNER_ERROR' });
  assert.equal(second.getAttempt('finished-attempt')?.result && typeof second.getAttempt('finished-attempt')?.result === 'object' ? (second.getAttempt('finished-attempt')?.result as { recovered?: boolean }).recovered : false, undefined);
  assert.equal(second.getAttempt('interrupted-attempt')?.result && typeof second.getAttempt('interrupted-attempt')?.result === 'object' ? (second.getAttempt('interrupted-attempt')?.result as { recovered?: boolean }).recovered : false, true);
  second.close();
  rmSync(root, { recursive: true, force: true });
});

test('两个 Store 竞争同一工作项时只有一个 lease owner 成功', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-lease-race-'));
  const path = join(root, 'state.sqlite');
  const first = new Store(path);
  const second = new Store(path);
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => first.acquireLease('race-item', 'owner-a', 10_000)),
    Promise.resolve().then(() => second.acquireLease('race-item', 'owner-b', 10_000))
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
  const winner = first.assertLease.bind(first);
  const loser = second.assertLease.bind(second);
  const winnerOwner = outcomes[0]?.status === 'fulfilled' ? 'owner-a' : 'owner-b';
  assert.doesNotThrow(() => (winnerOwner === 'owner-a' ? winner('race-item', 'owner-a') : loser('race-item', 'owner-b')));
  assert.throws(() => (winnerOwner === 'owner-a' ? loser('race-item', 'owner-b') : winner('race-item', 'owner-a')), /not writable/);
  first.close();
  second.close();
  rmSync(root, { recursive: true, force: true });
});

test('两个独立 Node 子进程竞争同一 SQLite lease 时只有一个成功', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-process-race-'));
  const db = join(root, 'state.sqlite');
  const go = join(root, 'go');
  const script = `import { existsSync, writeFileSync } from 'node:fs'; import { Store } from './src/storage/database.ts';
const store = new Store(process.env.MUREX_DB); writeFileSync(process.env.MUREX_READY, 'ready');
while (!existsSync(process.env.MUREX_GO)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
try { store.acquireLease('process-race', process.env.MUREX_OWNER, 10000); writeFileSync(process.env.MUREX_RESULT, 'ok'); }
catch (error) { writeFileSync(process.env.MUREX_RESULT, 'error:' + String(error)); } finally { store.close(); }`;
  const children = ['owner-a', 'owner-b'].map(owner => {
    const ready = join(root, `${owner}.ready`);
    const result = join(root, `${owner}.result`);
    return { owner, ready, result, child: spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, MUREX_DB: db, MUREX_GO: go, MUREX_OWNER: owner, MUREX_READY: ready, MUREX_RESULT: result }, stdio: 'ignore' }) };
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!children.every(child => existsSync(child.ready))) {
      if (Date.now() > deadline) throw new Error('child processes did not reach lease barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    writeFileSync(go, 'go');
    await Promise.all(children.map(({ child }) => new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`child exited with ${code}`)));
    })));
    const results = children.map(child => readFileSync(child.result, 'utf8'));
    assert.equal(results.filter(result => result === 'ok').length, 1);
    assert.equal(results.filter(result => result.startsWith('error:')).length, 1);
    assert.match(results.find(result => result.startsWith('error:')) ?? '', /lease held by another owner/);
  } finally {
    for (const { child } of children) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('两个独立 Node controller 竞争同一 Goal leader 时只有一个进入调度', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-process-leader-'));
  const db = join(root, 'state.sqlite');
  const go = join(root, 'go');
  const parent = new Store(db);
  parent.createGoal({ id: 'process-leader-goal', userIntent: 'leader', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  parent.createWorkItem({ id: 'process-leader-item', goalId: 'process-leader-goal', description: 'leader', dependencies: [] });
  parent.close();
  const script = `import { existsSync, writeFileSync } from 'node:fs'; import { Store } from './src/storage/database.ts'; import { runControllerLoop } from './src/controller/loop.ts';
const store = new Store(process.env.MUREX_DB); writeFileSync(process.env.MUREX_READY, 'ready');
while (!existsSync(process.env.MUREX_GO)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
const agent = { async run() { await new Promise(resolve => setTimeout(resolve, 50)); return { runId: process.env.MUREX_OWNER, changedPaths: [], result: 'SUCCEEDED', summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
const configure = () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', checks: [{ id: 'pass', command: [process.execPath, '-e', 'process.exit(0)'], required: true }], budget: {} });
runControllerLoop(store, { goalId: 'process-leader-goal', leaderElection: { controllerId: process.env.MUREX_OWNER, leaseTtlMs: 1000 }, configure, agentFor: () => agent }).then(result => writeFileSync(process.env.MUREX_RESULT, JSON.stringify(result))).catch(error => writeFileSync(process.env.MUREX_RESULT, JSON.stringify({ error: String(error) }))).finally(() => store.close());`;
  const children = ['owner-a', 'owner-b'].map(owner => {
    const ready = join(root, `${owner}.ready`);
    const result = join(root, `${owner}.result`);
    return { owner, ready, result, child: spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, MUREX_DB: db, MUREX_GO: go, MUREX_OWNER: owner, MUREX_READY: ready, MUREX_RESULT: result }, stdio: 'ignore' }) };
  });
  try {
    const deadline = Date.now() + 10_000;
    while (!children.every(child => existsSync(child.ready))) {
      if (Date.now() > deadline) throw new Error('leader child processes did not reach barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    writeFileSync(go, 'go');
    await new Promise<void>((resolve, reject) => {
      let remaining = children.length;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error('leader child processes did not exit')); }
      }, 10_000);
      timeout.unref();
      const finish = (error?: Error) => {
        if (settled) return;
        if (error) { settled = true; clearTimeout(timeout); reject(error); return; }
        remaining -= 1;
        if (remaining === 0) { settled = true; clearTimeout(timeout); resolve(); }
      };
      for (const { child } of children) {
        child.once('error', error => finish(error));
        child.once('exit', code => code === 0 ? finish() : finish(new Error(`leader child exited with ${code}`)));
      }
    });
    const results = children.map(child => JSON.parse(readFileSync(child.result, 'utf8')) as { completed?: string[]; skipped?: string[]; error?: string });
    assert.equal(results.filter(result => result.completed?.includes('process-leader-item')).length, 1);
    assert.equal(results.filter(result => result.skipped?.includes('process-leader-item')).length, 1);
    assert.equal(results.filter(result => result.error).length, 0);
    const verify = new Store(db);
    assert.equal(verify.getWorkItem('process-leader-item')?.status, 'SUCCEEDED');
    verify.close();
  } finally {
    for (const { child } of children) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

test('独立 controller 硬崩溃后，第二个进程等待 lease 过期并接管', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-process-leader-crash-'));
  const db = join(root, 'state.sqlite');
  const go = join(root, 'go');
  const parent = new Store(db);
  parent.createGoal({ id: 'crash-leader-goal', userIntent: 'crash recovery', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  parent.createWorkItem({ id: 'crash-leader-item', goalId: 'crash-leader-goal', description: 'crash', dependencies: [] });
  parent.close();
  const script = `import { existsSync, writeFileSync } from 'node:fs'; import { Store } from './src/storage/database.ts'; import { runControllerLoop } from './src/controller/loop.ts';
const store = new Store(process.env.MUREX_DB); writeFileSync(process.env.MUREX_READY, 'ready');
while (!existsSync(process.env.MUREX_GO)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
const agent = { async run() { writeFileSync(process.env.MUREX_RUNNING, 'running'); await new Promise(resolve => setTimeout(resolve, 5000)); return { runId: process.env.MUREX_OWNER, changedPaths: [], result: 'SUCCEEDED', summary: 'done' }; }, async cancel() {}, async resume() { throw new Error('unused'); } };
const configure = () => ({ workspace: process.cwd(), contractVersion: '1', candidateDigest: 'c', environmentFingerprint: 'e', inputDigest: 'i', leaseTtlMs: 100, checks: [{ id: 'pass', command: [process.execPath, '-e', 'process.exit(0)'], required: true }], budget: {} });
const run = async () => { const attempts = process.env.MUREX_ROLE === 'takeover' ? 3 : 1; let result; for (let attempt = 0; attempt < attempts; attempt += 1) { result = await runControllerLoop(store, { goalId: 'crash-leader-goal', leaderElection: { controllerId: process.env.MUREX_OWNER, leaseTtlMs: 100 }, configure, agentFor: () => agent }); if (result.completed.includes('crash-leader-item')) break; await new Promise(resolve => setTimeout(resolve, 150)); } writeFileSync(process.env.MUREX_RESULT, JSON.stringify(result)); };
run().catch(error => writeFileSync(process.env.MUREX_RESULT, JSON.stringify({ error: String(error) }))).finally(() => store.close());`;
  const children: Array<{ child: ReturnType<typeof spawn>; ready: string; result: string }> = [];
  try {
    const leaderReady = join(root, 'leader.ready');
    const leaderResult = join(root, 'leader.result');
    const running = join(root, 'running');
    const leader = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, MUREX_DB: db, MUREX_GO: go, MUREX_OWNER: 'crashed-leader', MUREX_ROLE: 'leader', MUREX_READY: leaderReady, MUREX_RESULT: leaderResult, MUREX_RUNNING: running }, stdio: 'ignore' });
    children.push({ child: leader, ready: leaderReady, result: leaderResult });
    const deadline = Date.now() + 10_000;
    while (!existsSync(leaderReady)) {
      if (Date.now() > deadline) throw new Error('crashed leader did not reach ready barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    writeFileSync(go, 'go');
    while (!existsSync(running)) {
      if (Date.now() > deadline) throw new Error('crashed leader did not reach running barrier');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    leader.kill('SIGKILL');
    await new Promise<void>(resolve => leader.once('exit', () => resolve()));

    const takeoverReady = join(root, 'takeover.ready');
    const takeoverResult = join(root, 'takeover.result');
    const takeover = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, MUREX_DB: db, MUREX_GO: go, MUREX_OWNER: 'takeover', MUREX_ROLE: 'takeover', MUREX_READY: takeoverReady, MUREX_RESULT: takeoverResult, MUREX_RUNNING: join(root, 'takeover.running') }, stdio: 'ignore' });
    children.push({ child: takeover, ready: takeoverReady, result: takeoverResult });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => { if (!settled) { settled = true; reject(new Error('takeover controller did not exit')); } }, 10_000);
      timeout.unref();
      takeover.once('error', error => { if (!settled) { settled = true; clearTimeout(timeout); reject(error); } });
      takeover.once('exit', code => { if (settled) return; settled = true; clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`takeover controller exited with ${code}`)); });
    });
    const result = JSON.parse(readFileSync(takeoverResult, 'utf8')) as { completed?: string[]; error?: string };
    assert.equal(result.error, undefined);
    assert.deepEqual(result.completed, ['crash-leader-item']);
    const verify = new Store(db);
    assert.equal(verify.getWorkItem('crash-leader-item')?.status, 'SUCCEEDED');
    assert.ok(verify.listEvents().some(event => event.event_type === 'ATTEMPT_RECOVERED'));
    verify.close();
  } finally {
    for (const { child } of children) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});
