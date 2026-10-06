import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/storage/database.js';

test('状态迁移和重启恢复保留 Goal', () => {
  const store = new Store();
  store.createGoal({ id: 'g1', userIntent: '实现小功能', constraints: [], acceptanceContract: { version: 1 }, authorizationPolicy: {}, budget: {} });
  assert.equal(store.transitionGoal('g1', 'PLANNING').status, 'PLANNING');
  assert.equal(store.transitionGoal('g1', 'RUNNING').status, 'RUNNING');
  assert.throws(() => store.transitionGoal('g1', 'SUCCEEDED'), /非法/);
  assert.equal(store.getGoal('g1')?.version, 3);
});

test('非法工作项 Goal 被拒绝', () => {
  const store = new Store();
  assert.throws(() => store.createWorkItem({ id: 'w1', goalId: 'missing', description: 'x', dependencies: [] }), /不存在/);
});

test('查询 API 返回 Goals 和按工作项过滤的 Attempts，终态写入被拒绝', () => {
  const store = new Store();
  store.createGoal({ id: 'query-a', userIntent: 'a', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createGoal({ id: 'query-b', userIntent: 'b', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'query-item', goalId: 'query-a', description: 'x', dependencies: [] });
  store.recordAttempt({ id: 'query-attempt', workItemId: 'query-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' });
  assert.deepEqual(store.listGoals().map(goal => goal.id), ['query-a', 'query-b']);
  assert.deepEqual(store.listAttempts('query-item').map(attempt => attempt.id), ['query-attempt']);
  store.transitionWorkItem('query-item', 'READY');
  store.transitionWorkItem('query-item', 'RUNNING');
  store.transitionWorkItem('query-item', 'SUCCEEDED');
  assert.throws(() => store.startAttempt({ id: 'query-late-attempt', workItemId: 'query-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' }), /SUCCEEDED/);
  assert.throws(() => store.recordAttempt({ id: 'query-late-record', workItemId: 'query-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' }), /SUCCEEDED/);
  store.transitionGoal('query-b', 'PLANNING');
  store.transitionGoal('query-b', 'RUNNING');
  store.transitionGoal('query-b', 'VERIFYING');
  store.transitionGoal('query-b', 'DELIVERING');
  store.transitionGoal('query-b', 'SUCCEEDED');
  assert.throws(() => store.createWorkItem({ id: 'query-late-item', goalId: 'query-b', description: 'x', dependencies: [] }), /SUCCEEDED/);
  assert.throws(() => store.createHumanRequest({ id: 'query-late-human', goalId: 'query-b', question: 'q', context: {}, requiredAuthority: 'review', status: 'OPEN' }), /SUCCEEDED/);
});

test('终态 WorkItem 拒绝迟到 Attempt 完成，并保留 lease fencing', () => {
  const store = new Store();
  store.createGoal({ id: 'finish-terminal-goal', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'finish-terminal-item', goalId: 'finish-terminal-goal', description: 'x', dependencies: [] });
  store.transitionWorkItem('finish-terminal-item', 'READY');
  store.transitionWorkItem('finish-terminal-item', 'RUNNING');
  store.startAttempt({ id: 'finish-terminal-attempt', workItemId: 'finish-terminal-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' });
  store.transitionWorkItem('finish-terminal-item', 'SUCCEEDED');
  assert.throws(() => store.finishAttempt('finish-terminal-attempt', { late: true }), /cannot finish after WorkItem SUCCEEDED/);
  assert.equal(store.getAttempt('finish-terminal-attempt')?.endedAt, undefined);

  store.createWorkItem({ id: 'finish-lease-item', goalId: 'finish-terminal-goal', description: 'lease', dependencies: [] });
  store.transitionWorkItem('finish-lease-item', 'READY');
  store.transitionWorkItem('finish-lease-item', 'RUNNING');
  store.acquireLease('finish-lease-item', 'current-owner', 1, 100);
  store.startAttempt({ id: 'finish-lease-attempt', workItemId: 'finish-lease-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' });
  assert.throws(() => store.finishAttempt('finish-lease-attempt', { stale: true }, '2026-01-01', { resourceId: 'finish-lease-item', owner: 'current-owner', now: 102 }), /not writable/);
  assert.equal(store.getAttempt('finish-lease-attempt')?.endedAt, undefined);
});

test('同一 WorkItem 只允许一个 active Attempt，结束后可重试且跨 Store 竞争受事务保护', () => {
  const root = mkdtempSync(join(tmpdir(), 'attempt-unique-'));
  const path = join(root, 'state.sqlite');
  try {
    const first = new Store(path);
    first.createGoal({ id: 'attempt-unique-goal', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    first.createWorkItem({ id: 'attempt-unique-item', goalId: 'attempt-unique-goal', description: 'x', dependencies: [] });
    first.startAttempt({ id: 'active-start', workItemId: 'attempt-unique-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' });
    assert.throws(() => first.startAttempt({ id: 'duplicate-start', workItemId: 'attempt-unique-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' }), /already has an active Attempt/);
    assert.throws(() => first.recordAttempt({ id: 'duplicate-record', workItemId: 'attempt-unique-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' }), /already has an active Attempt/);
    const second = new Store(path);
    assert.throws(() => second.startAttempt({ id: 'cross-store-start', workItemId: 'attempt-unique-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' }), /already has an active Attempt/);
    first.finishAttempt('active-start', { ok: true });
    assert.doesNotThrow(() => second.startAttempt({ id: 'after-finish', workItemId: 'attempt-unique-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' }));
    assert.doesNotThrow(() => second.recordAttempt({ id: 'ended-record', workItemId: 'attempt-unique-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01', endedAt: '2026-01-02', result: { historical: true } }));
    second.close();
    first.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('三种 WorkItem RUNNING 入口都要求依赖已 SUCCEEDED 且失败不产生脏写', () => {
  const store = new Store();
  store.createGoal({ id: 'dependency-guard-goal', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.db.prepare('INSERT INTO work_items VALUES (?, ?, ?, ?, ?, ?)').run('dependency-guard-missing', 'dependency-guard-goal', 'missing', JSON.stringify(['no-such-item']), 'PENDING', 0);
  store.transitionWorkItem('dependency-guard-missing', 'READY');
  const beforeMissing = store.listEvents('dependency-guard-missing').length;
  assert.throws(() => store.transitionWorkItem('dependency-guard-missing', 'RUNNING'), /does not exist/);
  assert.equal(store.getWorkItem('dependency-guard-missing')?.attemptCount, 0);
  assert.equal(store.listEvents('dependency-guard-missing').length, beforeMissing);

  store.createWorkItem({ id: 'dependency-guard-dep', goalId: 'dependency-guard-goal', description: 'dep', dependencies: [] });
  store.createWorkItem({ id: 'dependency-guard-lease', goalId: 'dependency-guard-goal', description: 'lease', dependencies: ['dependency-guard-dep'] });
  store.createWorkItem({ id: 'dependency-guard-versioned', goalId: 'dependency-guard-goal', description: 'versioned', dependencies: ['dependency-guard-dep'] });
  for (const id of ['dependency-guard-dep', 'dependency-guard-lease', 'dependency-guard-versioned']) store.transitionWorkItem(id, 'READY');
  store.acquireLease('dependency-guard-lease', 'lease-owner', 10_000);
  store.acquireLease('dependency-guard-versioned', 'version-owner', 10_000);
  assert.throws(() => store.transitionWorkItemWithLease('dependency-guard-lease', 'RUNNING', 'dependency-guard-lease', 'lease-owner'), /not complete/);
  assert.throws(() => store.transitionWorkItemWithLeaseAndGoalVersions('dependency-guard-versioned', 'RUNNING', 'dependency-guard-versioned', 'version-owner', 'dependency-guard-goal'), /not complete/);
  assert.equal(store.getWorkItem('dependency-guard-lease')?.attemptCount, 0);
  assert.equal(store.getWorkItem('dependency-guard-versioned')?.attemptCount, 0);

  store.transitionWorkItem('dependency-guard-dep', 'RUNNING');
  store.transitionWorkItem('dependency-guard-dep', 'SUCCEEDED');
  assert.equal(store.transitionWorkItemWithLease('dependency-guard-lease', 'RUNNING', 'dependency-guard-lease', 'lease-owner').status, 'RUNNING');
  assert.equal(store.transitionWorkItemWithLeaseAndGoalVersions('dependency-guard-versioned', 'RUNNING', 'dependency-guard-versioned', 'version-owner', 'dependency-guard-goal').status, 'RUNNING');
});

test('WorkItem dependency 不能跨 Goal，旧数据在三种 RUNNING 入口也会被拒绝', () => {
  const store = new Store();
  for (const goalId of ['dep-goal-a', 'dep-goal-b']) store.createGoal({ id: goalId, userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'dep-b', goalId: 'dep-goal-b', description: 'dep', dependencies: [] });
  assert.throws(() => store.createWorkItem({ id: 'dep-cross-new', goalId: 'dep-goal-a', description: 'cross', dependencies: ['dep-b'] }), /crosses Goal/);
  assert.equal(store.getWorkItem('dep-cross-new'), undefined);
  assert.equal(store.listEvents('dep-cross-new').length, 0);

  for (const id of ['dep-cross-plain', 'dep-cross-lease', 'dep-cross-versioned']) {
    store.db.prepare('INSERT INTO work_items VALUES (?, ?, ?, ?, ?, ?)').run(id, 'dep-goal-a', id, JSON.stringify(['dep-b']), 'READY', 0);
  }
  store.acquireLease('dep-cross-lease', 'owner', 10_000);
  store.acquireLease('dep-cross-versioned', 'version-owner', 10_000);
  for (const [id, action] of [
    ['dep-cross-plain', () => store.transitionWorkItem('dep-cross-plain', 'RUNNING')],
    ['dep-cross-lease', () => store.transitionWorkItemWithLease('dep-cross-lease', 'RUNNING', 'dep-cross-lease', 'owner')],
    ['dep-cross-versioned', () => store.transitionWorkItemWithLeaseAndGoalVersions('dep-cross-versioned', 'RUNNING', 'dep-cross-versioned', 'version-owner', 'dep-goal-a')]
  ] as const) {
    const before = store.listEvents(id).length;
    assert.throws(action, /crosses Goal/);
    assert.equal(store.getWorkItem(id)?.status, 'READY');
    assert.equal(store.getWorkItem(id)?.attemptCount, 0);
    assert.equal(store.listEvents(id).length, before);
  }

  store.createWorkItem({ id: 'dep-a-good', goalId: 'dep-goal-a', description: 'good', dependencies: [] });
  store.transitionWorkItem('dep-a-good', 'READY'); store.transitionWorkItem('dep-a-good', 'RUNNING'); store.transitionWorkItem('dep-a-good', 'SUCCEEDED');
  store.createWorkItem({ id: 'dep-a-child', goalId: 'dep-goal-a', description: 'child', dependencies: ['dep-a-good'] });
  store.transitionWorkItem('dep-a-child', 'READY');
  assert.equal(store.transitionWorkItem('dep-a-child', 'RUNNING').status, 'RUNNING');
});

test('Goal VERIFYING/DELIVERING 要求所有 WorkItem 已终态，空集合保持兼容', () => {
  const store = new Store();
  store.createGoal({ id: 'verify-items', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'verify-pending', goalId: 'verify-items', description: 'pending', dependencies: [] });
  store.transitionGoal('verify-items', 'PLANNING'); store.transitionGoal('verify-items', 'RUNNING');
  const before = store.listEvents('verify-items').length;
  assert.throws(() => store.transitionGoal('verify-items', 'VERIFYING'), /all WorkItems to be terminal/);
  assert.equal(store.getGoal('verify-items')?.status, 'RUNNING');
  assert.equal(store.listEvents('verify-items').length, before);
  store.transitionWorkItem('verify-pending', 'READY'); store.transitionWorkItem('verify-pending', 'RUNNING'); store.transitionWorkItem('verify-pending', 'SUCCEEDED');
  store.transitionGoal('verify-items', 'VERIFYING');
  store.transitionGoal('verify-items', 'DELIVERING');

  const blocked = new Store();
  blocked.createGoal({ id: 'verify-blocked', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  blocked.createWorkItem({ id: 'verify-blocked-item', goalId: 'verify-blocked', description: 'blocked', dependencies: [] });
  blocked.transitionWorkItem('verify-blocked-item', 'READY'); blocked.transitionWorkItem('verify-blocked-item', 'BLOCKED');
  blocked.transitionGoal('verify-blocked', 'PLANNING'); blocked.transitionGoal('verify-blocked', 'RUNNING'); blocked.transitionGoal('verify-blocked', 'VERIFYING');

  const empty = new Store();
  empty.createGoal({ id: 'verify-empty', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  empty.transitionGoal('verify-empty', 'PLANNING'); empty.transitionGoal('verify-empty', 'RUNNING');
  assert.equal(empty.transitionGoal('verify-empty', 'VERIFYING').status, 'VERIFYING');
});

test('Goal lease transition 也拒绝未完成 WorkItem 并允许终态 WorkItem', () => {
  const store = new Store();
  store.createGoal({ id: 'verify-lease', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'verify-lease-item', goalId: 'verify-lease', description: 'item', dependencies: [] });
  store.transitionWorkItem('verify-lease-item', 'READY'); store.acquireLease('verify-lease-item', 'owner', 10_000);
  store.transitionGoal('verify-lease', 'PLANNING'); store.transitionGoal('verify-lease', 'RUNNING');
  assert.throws(() => store.transitionGoalWithLease('verify-lease', 'VERIFYING', 'verify-lease-item', 'owner'), /all WorkItems to be terminal/);
  store.transitionWorkItemWithLease('verify-lease-item', 'RUNNING', 'verify-lease-item', 'owner');
  store.transitionWorkItemWithLease('verify-lease-item', 'SUCCEEDED', 'verify-lease-item', 'owner');
  assert.equal(store.transitionGoalWithLease('verify-lease', 'VERIFYING', 'verify-lease-item', 'owner').status, 'VERIFYING');
  assert.equal(store.transitionGoalWithLease('verify-lease', 'DELIVERING', 'verify-lease-item', 'owner').status, 'DELIVERING');
});

test('Goal waiting/recovery 迁移要求对应事实并记录 context', () => {
  const store = new Store();
  store.createGoal({ id: 'waiting-facts', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.transitionGoal('waiting-facts', 'PLANNING'); store.transitionGoal('waiting-facts', 'RUNNING');
  const before = store.listEvents('waiting-facts').length;
  assert.throws(() => store.transitionGoal('waiting-facts', 'WAITING_HUMAN'), /OPEN HumanRequest/);
  assert.equal(store.listEvents('waiting-facts').length, before);
  store.createHumanRequest({ id: 'waiting-request', goalId: 'waiting-facts', question: 'q', context: {}, requiredAuthority: 'review', status: 'OPEN' });
  store.transitionGoal('waiting-facts', 'WAITING_HUMAN', { reason: 'needs review', diagnostic: { code: 'REVIEW' } });
  assert.match(String(store.listEvents('waiting-facts').at(-1)?.payload_json), /needs review/);
  store.answerHumanRequest('waiting-request', 'yes');
  assert.equal(store.getGoal('waiting-facts')?.status, 'RUNNING');

  store.createGoal({ id: 'external-facts', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.transitionGoal('external-facts', 'PLANNING'); store.transitionGoal('external-facts', 'RUNNING');
  assert.throws(() => store.transitionGoal('external-facts', 'WAITING_EXTERNAL'), /PENDING or UNKNOWN/);
  store.createOperation({ actionId: 'external-op', idempotencyKey: 'external-key', goalId: 'external-facts', targetRef: 'HEAD', exactRevision: 'r', intendedTarget: 'pr', reconciliationStatus: 'PENDING' });
  store.transitionGoal('external-facts', 'WAITING_EXTERNAL', { reason: 'ci pending' });
  assert.throws(() => store.transitionGoal('external-facts', 'RUNNING'), /pending external/);
  store.updateOperationReceipt('external-op', { status: 'done' }, 'SUCCEEDED');
  store.transitionGoal('external-facts', 'RUNNING');

  store.createGoal({ id: 'recover-facts', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.transitionGoal('recover-facts', 'PLANNING'); store.transitionGoal('recover-facts', 'RUNNING');
  store.createWorkItem({ id: 'recover-facts-item', goalId: 'recover-facts', description: 'x', dependencies: [] });
  store.transitionWorkItem('recover-facts-item', 'READY'); store.transitionWorkItem('recover-facts-item', 'RUNNING');
  store.startAttempt({ id: 'recover-facts-attempt', workItemId: 'recover-facts-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' });
  store.acquireLease('recover-facts-item', 'live-owner', 10_000);
  assert.throws(() => store.transitionGoal('recover-facts', 'RECOVERING'), /recoverable Attempt/);
  store.revokeLease('recover-facts-item', 'live-owner');
  store.transitionGoal('recover-facts', 'RECOVERING', { reason: 'controller restart' });
});

test('Goal PAUSED_BUDGET 与 CLOSED_UNACHIEVABLE 要求可审计事实', () => {
  const store = new Store();
  store.createGoal({ id: 'terminal-facts', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: { limit: 2 } });
  store.transitionGoal('terminal-facts', 'PLANNING');
  store.transitionGoal('terminal-facts', 'RUNNING');
  const runningEvents = store.listEvents('terminal-facts').length;
  assert.throws(() => store.transitionGoal('terminal-facts', 'PAUSED_BUDGET'), /exhausted budget/);
  assert.equal(store.listEvents('terminal-facts').length, runningEvents);
  store.reserveBudget('terminal-facts', 2, 2);
  store.transitionGoal('terminal-facts', 'PAUSED_BUDGET', { reason: 'budget exhausted', diagnostic: { reserved: 2 } });
  assert.equal(store.getGoal('terminal-facts')?.status, 'PAUSED_BUDGET');

  const failed = new Store();
  failed.createGoal({ id: 'failed-facts', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  failed.transitionGoal('failed-facts', 'PLANNING'); failed.transitionGoal('failed-facts', 'RUNNING'); failed.transitionGoal('failed-facts', 'FAILED');
  assert.throws(() => failed.transitionGoal('failed-facts', 'CLOSED_UNACHIEVABLE'), /reason, and diagnostic/);
  assert.throws(() => failed.transitionGoal('failed-facts', 'CLOSED_UNACHIEVABLE', { reason: 'why' }), /reason, and diagnostic/);
  assert.throws(() => failed.transitionGoal('failed-facts', 'CLOSED_UNACHIEVABLE', { reason: 'why', diagnostic: {} }), /reason, and diagnostic/);
  failed.transitionGoal('failed-facts', 'CLOSED_UNACHIEVABLE', { reason: 'unachievable', diagnostic: { blocker: 'x' } });
  assert.equal(failed.getGoal('failed-facts')?.status, 'CLOSED_UNACHIEVABLE');
});

test('reserveBudget 使用持久化 Goal limit，不能由调用方上调绕过', () => {
  const store = new Store();
  store.createGoal({ id: 'budget-limit-guard', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: { limit: 2 } });
  const beforeEvents = store.listEvents('budget-limit-guard').length;
  assert.throws(() => store.reserveBudget('budget-limit-guard', 1, 3), /budget limit mismatch/);
  assert.equal(store.reservedBudget('budget-limit-guard'), 0);
  assert.equal(store.listEvents('budget-limit-guard').length, beforeEvents);
  assert.throws(() => store.reserveBudget('budget-limit-guard', 3, 2), /budget exhausted/);
  assert.equal(store.reservedBudget('budget-limit-guard'), 0);
  assert.equal(store.reserveBudget('budget-limit-guard', 2, 2), 2);

  const unconfigured = new Store();
  unconfigured.createGoal({ id: 'budget-explicit-limit', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  assert.equal(unconfigured.reserveBudget('budget-explicit-limit', 2, 3), 2);
});

test('Goal budget/closure facts guard 也应用 lease transition', () => {
  const store = new Store();
  store.createGoal({ id: 'lease-terminal-facts', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: { limit: 1 } });
  store.createWorkItem({ id: 'lease-terminal-item', goalId: 'lease-terminal-facts', description: 'x', dependencies: [] });
  store.transitionWorkItem('lease-terminal-item', 'READY');
  store.acquireLease('lease-terminal-item', 'owner', 10_000);
  store.transitionGoal('lease-terminal-facts', 'PLANNING'); store.transitionGoal('lease-terminal-facts', 'RUNNING');
  assert.throws(() => store.transitionGoalWithLease('lease-terminal-facts', 'PAUSED_BUDGET', 'lease-terminal-item', 'owner'), /exhausted budget/);
  store.reserveBudget('lease-terminal-facts', 1, 1);
  store.transitionGoalWithLease('lease-terminal-facts', 'PAUSED_BUDGET', 'lease-terminal-item', 'owner', Date.now(), { reason: 'budget', diagnostic: { reserved: 1 } });
  assert.equal(store.getGoal('lease-terminal-facts')?.status, 'PAUSED_BUDGET');
});

test('transitionGoalWithLease 也应用 waiting facts guard', () => {
  const store = new Store();
  store.createGoal({ id: 'lease-waiting-facts', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'lease-waiting-item', goalId: 'lease-waiting-facts', description: 'x', dependencies: [] });
  store.transitionWorkItem('lease-waiting-item', 'READY');
  store.acquireLease('lease-waiting-item', 'owner', 10_000);
  store.transitionGoal('lease-waiting-facts', 'PLANNING'); store.transitionGoal('lease-waiting-facts', 'RUNNING');
  assert.throws(() => store.transitionGoalWithLease('lease-waiting-facts', 'WAITING_EXTERNAL', 'lease-waiting-item', 'owner'), /PENDING or UNKNOWN/);
  store.createOperation({ actionId: 'lease-waiting-op', idempotencyKey: 'lease-waiting-key', goalId: 'lease-waiting-facts', targetRef: 'HEAD', exactRevision: 'r', intendedTarget: 'pr', reconciliationStatus: 'PENDING' });
  store.transitionGoalWithLease('lease-waiting-facts', 'WAITING_EXTERNAL', 'lease-waiting-item', 'owner', Date.now(), { reason: 'lease context' });
  assert.equal(store.getGoal('lease-waiting-facts')?.status, 'WAITING_EXTERNAL');
});

test('GoalSnapshot 统一返回关联状态且不存在 Goal 返回 undefined', () => {
  const store = new Store();
  assert.equal(store.getGoalSnapshot('missing'), undefined);
  store.createGoal({ id: 'snapshot-goal', userIntent: 'snapshot', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: { limit: 2 } });
  store.createWorkItem({ id: 'snapshot-item', goalId: 'snapshot-goal', description: 'item', dependencies: [] });
  store.startAttempt({ id: 'snapshot-attempt', workItemId: 'snapshot-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' });
  store.createHumanRequest({ id: 'snapshot-human', goalId: 'snapshot-goal', question: 'q', context: {}, requiredAuthority: 'review', status: 'OPEN' });
  store.createOperation({ actionId: 'snapshot-op', idempotencyKey: 'snapshot-key', goalId: 'snapshot-goal', exactRevision: 'r', intendedTarget: 'pr', reconciliationStatus: 'PENDING' });
  store.reserveBudget('snapshot-goal', 1, 2);
  const snapshot = store.getGoalSnapshot('snapshot-goal')!;
  assert.deepEqual(snapshot.workItems.map(item => item.id), ['snapshot-item']);
  assert.deepEqual(snapshot.attempts.map(attempt => attempt.id), ['snapshot-attempt']);
  assert.deepEqual(snapshot.humanRequests.map(request => request.id), ['snapshot-human']);
  assert.deepEqual(snapshot.operations.map(operation => operation.actionId), ['snapshot-op']);
  assert.equal(snapshot.reservedBudget, 1);
  assert.ok(snapshot.events.some(event => event.entity_id === 'snapshot-op'));
});

test('WorkItem 终态和幂等键冲突会被拒绝', () => {
  const store = new Store();
  store.createGoal({ id: 'g3', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'w3', goalId: 'g3', description: 'x', dependencies: [] });
  store.transitionWorkItem('w3', 'READY');
  store.transitionWorkItem('w3', 'RUNNING');
  store.transitionWorkItem('w3', 'SUCCEEDED');
  assert.throws(() => store.transitionWorkItem('w3', 'READY'), /非法/);
  store.createOperation({ actionId: 'a3', idempotencyKey: 'k3', exactRevision: 'r3', intendedTarget: 'branch', reconciliationStatus: 'PENDING' });
  assert.throws(() => store.createOperation({ actionId: 'a4', idempotencyKey: 'k3', exactRevision: 'r4', intendedTarget: 'branch', reconciliationStatus: 'PENDING' }), /不同操作/);
  assert.throws(() => store.createOperation({ actionId: 'a5', idempotencyKey: 'k3', exactRevision: 'r3', intendedTarget: 'branch', targetRef: 'main', reconciliationStatus: 'PENDING' }), /不同操作/);
});

test('终态 Goal 拒绝预算、Evidence 和新 Operation 写入', () => {
  const store = new Store();
  store.createGoal({ id: 'terminal-guard', userIntent: 'x', constraints: [], acceptanceContract: { version: 1 }, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'terminal-guard-item', goalId: 'terminal-guard', description: 'x', dependencies: [] });
  store.transitionWorkItem('terminal-guard-item', 'READY'); store.transitionWorkItem('terminal-guard-item', 'RUNNING'); store.transitionWorkItem('terminal-guard-item', 'SUCCEEDED');
  for (const status of ['PLANNING', 'RUNNING', 'VERIFYING', 'DELIVERING', 'SUCCEEDED'] as const) store.transitionGoal('terminal-guard', status);
  assert.throws(() => store.reserveBudget('terminal-guard', 1, 2), /cannot be updated/);
  assert.throws(() => store.createOperation({ actionId: 'terminal-op', idempotencyKey: 'terminal-key', goalId: 'terminal-guard', exactRevision: 'r', intendedTarget: 'pr', reconciliationStatus: 'PENDING' }), /cannot be updated/);
  assert.throws(() => store.recordEvidence({ id: 'terminal-evidence', workItemId: 'terminal-guard-item', requirementId: 'req', contractVersion: '1', candidateDigest: 'c', checkDefinitionDigest: 'd', environmentFingerprint: 'e', inputDigest: 'i', status: 'PASS', rawArtifactRefs: [], observedAt: new Date().toISOString() }), /cannot be updated/);
});

test('Operation merge idempotency key 遵守终态与幂等写入守卫', () => {
  const store = new Store();
  store.createOperation({ actionId: 'merge-key-pending', idempotencyKey: 'merge-key-pending-id', exactRevision: 'r', intendedTarget: 'pr', reconciliationStatus: 'PENDING' });
  const before = store.listEvents('merge-key-pending').length;
  assert.equal(store.setOperationMergeIdempotencyKey('merge-key-pending', 'merge-1').mergeIdempotencyKey, 'merge-1');
  assert.equal(store.listEvents('merge-key-pending').length, before + 1);
  const afterSet = store.listEvents('merge-key-pending').length;
  assert.equal(store.setOperationMergeIdempotencyKey('merge-key-pending', 'merge-1').mergeIdempotencyKey, 'merge-1');
  assert.equal(store.listEvents('merge-key-pending').length, afterSet);
  assert.throws(() => store.setOperationMergeIdempotencyKey('merge-key-pending', 'merge-2'), /mismatch/);
  assert.equal(store.getOperation('merge-key-pending')?.mergeIdempotencyKey, 'merge-1');

  for (const status of ['SUCCEEDED', 'FAILED'] as const) {
    const actionId = `merge-key-${status.toLowerCase()}`;
    store.createOperation({ actionId, idempotencyKey: `${actionId}-id`, exactRevision: 'r', intendedTarget: 'pr', reconciliationStatus: 'PENDING' });
    store.updateOperationReceipt(actionId, { status }, status);
    const eventCount = store.listEvents(actionId).length;
    assert.throws(() => store.setOperationMergeIdempotencyKey(actionId, 'late-key'), /cannot be updated/);
    assert.equal(store.listEvents(actionId).length, eventCount);
    assert.equal(store.getOperation(actionId)?.mergeIdempotencyKey, undefined);
  }
});

test('文件数据库重启恢复事件和幂等操作', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devctl-'));
  const path = join(dir, 'state.sqlite');
  const first = new Store(path);
  first.createGoal({ id: 'g2', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  const operation = first.createOperation({ actionId: 'a1', idempotencyKey: 'k1', exactRevision: 'r1', intendedTarget: 'branch', reconciliationStatus: 'PENDING' });
  first.close();
  const second = new Store(path);
  assert.equal(second.getGoal('g2')?.status, 'DRAFT');
  assert.equal(second.createOperation({ ...operation, actionId: 'a2' }).actionId, 'a1');
  assert.equal(second.listEvents('g2').length, 1);
  second.close();
  rmSync(dir, { recursive: true, force: true });
});

test('人工请求可回答且不能重复回答', async () => {
  const store = new Store();
  store.createGoal({ id: 'g4', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.createHumanRequest({ id: 'h1', goalId: 'g4', question: '允许吗？', context: { version: 1 }, requiredAuthority: 'deploy', status: 'OPEN' });
  assert.equal(store.answerHumanRequest('h1', 'yes').status, 'ANSWERED');
  assert.throws(() => store.answerHumanRequest('h1', 'again'), /已关闭/);
  store.createHumanRequest({ id: 'h2', goalId: 'g4', question: '并发？', context: {}, requiredAuthority: 'review', status: 'OPEN' });
  const answers = await Promise.allSettled([Promise.resolve().then(() => store.answerHumanRequest('h2', 'a')), Promise.resolve().then(() => store.answerHumanRequest('h2', 'b'))]);
  assert.equal(answers.filter(answer => answer.status === 'fulfilled').length, 1);
});

test('HumanRequest 只能以 OPEN 创建，回答流程和失败事务保持一致', () => {
  const store = new Store();
  store.createGoal({ id: 'human-status-guard', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  for (const status of ['ANSWERED', 'CLOSED'] as const) {
    const id = `human-${status.toLowerCase()}`;
    const before = store.listEvents(id).length;
    assert.throws(() => store.createHumanRequest({ id, goalId: 'human-status-guard', question: 'q', context: {}, requiredAuthority: 'review', status }), /must start OPEN/);
    assert.equal(store.getHumanRequest(id), undefined);
    assert.equal(store.listEvents(id).length, before);
  }
  const open = store.createHumanRequest({ id: 'human-open', goalId: 'human-status-guard', question: 'q', context: {}, requiredAuthority: 'review', status: 'OPEN' });
  assert.equal(open.status, 'OPEN');
  assert.equal(store.answerHumanRequest('human-open', { approved: true }).status, 'ANSWERED');
});

test('人工请求会暂停 Goal，最后一个回答后恢复运行', () => {
  const store = new Store();
  store.createGoal({ id: 'g-human-flow', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  store.transitionGoal('g-human-flow', 'PLANNING');
  store.transitionGoal('g-human-flow', 'RUNNING');
  store.createHumanRequestAndPause({ id: 'h-flow-1', goalId: 'g-human-flow', question: 'q1', context: {}, recommendedOptions: ['a', 'b'], blockingItems: ['direction'], requiredAuthority: 'review', status: 'OPEN' });
  store.createHumanRequestAndPause({ id: 'h-flow-2', goalId: 'g-human-flow', question: 'q2', context: {}, requiredAuthority: 'review', status: 'OPEN' });
  assert.equal(store.getGoal('g-human-flow')?.status, 'WAITING_HUMAN');
  assert.deepEqual(store.getHumanRequest('h-flow-1')?.recommendedOptions, ['a', 'b']);
  store.answerHumanRequest('h-flow-1', 'a1');
  assert.equal(store.getGoal('g-human-flow')?.status, 'WAITING_HUMAN');
  store.answerHumanRequest('h-flow-2', 'a2');
  assert.equal(store.getGoal('g-human-flow')?.status, 'RUNNING');
});

test('Goal 关联查询覆盖工作项事件、证据和 Operation 取消', () => {
  const store = new Store();
  store.createGoal({ id: 'g5', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: { limit: 5 } });
  store.createWorkItem({ id: 'w5', goalId: 'g5', description: 'x', dependencies: [] });
  store.createWorkItem({ id: 'w6', goalId: 'g5', description: 'y', dependencies: [] });
  store.transitionWorkItem('w5', 'READY');
  store.createHumanRequest({ id: 'h5', goalId: 'g5', question: 'q', context: {}, requiredAuthority: 'review', status: 'OPEN' });
  store.recordEvidence({ id: 'w5:req:1', requirementId: 'req', contractVersion: '1', candidateDigest: 'c', checkDefinitionDigest: 'd', environmentFingerprint: 'e', inputDigest: 'i', status: 'FAIL', rawArtifactRefs: [], observedAt: new Date().toISOString() });
  store.recordEvidence({ id: 'arbitrary-evidence-id', workItemId: 'w5', requirementId: 'req2', contractVersion: '1', candidateDigest: 'c', checkDefinitionDigest: 'd', environmentFingerprint: 'e', inputDigest: 'i', status: 'PASS', rawArtifactRefs: [], observedAt: new Date().toISOString() });
  store.acquireLease('w5', 'evidence-owner', 10_000);
  assert.throws(() => store.recordEvidenceWithLease({ id: 'w5:wrong', workItemId: 'w6', requirementId: 'req3', contractVersion: '1', candidateDigest: 'c', checkDefinitionDigest: 'd', environmentFingerprint: 'e', inputDigest: 'i', status: 'PASS', rawArtifactRefs: [], observedAt: new Date().toISOString() }, 'w5', 'evidence-owner'), /does not match/);
  assert.throws(() => store.recordEvidence({ id: 'missing', workItemId: 'missing', requirementId: 'req4', contractVersion: '1', candidateDigest: 'c', checkDefinitionDigest: 'd', environmentFingerprint: 'e', inputDigest: 'i', status: 'PASS', rawArtifactRefs: [], observedAt: new Date().toISOString() }), /不存在/);
  store.createOperation({ actionId: 'op5', idempotencyKey: 'k5', goalId: 'g5', targetRef: 'main', exactRevision: 'r', intendedTarget: 'pr', reconciliationStatus: 'PENDING' });
  assert.equal(store.listOperations()[0]?.goalId, 'g5');
  assert.deepEqual(new Set(store.listGoalEvents('g5').map(row => row.entity_id)), new Set(['g5', 'w5', 'w6', 'h5', 'w5:req:1', 'arbitrary-evidence-id', 'op5']));
  assert.equal(store.listEvidence().length, 2);
  assert.equal(store.cancelOperation('op5', 'manual stop').reconciliationStatus, 'FAILED');
  assert.throws(() => store.cancelOperation('op5', 'again'), /cannot be cancelled/);
  assert.throws(() => store.updateOperationReceipt('op5', { status: 'late' }, 'SUCCEEDED'), /FAILED/);
  assert.throws(() => store.updateOperationPushReceipt('op5', { id: 'late-push' }), /FAILED/);
});

test('Goal 事件查询保留过期和旧契约 Evidence，当前有效查询仍过滤', () => {
  const store = new Store();
  store.createGoal({ id: 'history-goal', userIntent: 'x', constraints: [], acceptanceContract: { version: 1 }, authorizationPolicy: {}, budget: {} });
  store.createWorkItem({ id: 'history-item', goalId: 'history-goal', description: 'x', dependencies: [] });
  store.recordEvidence({ id: 'history-old', workItemId: 'history-item', requirementId: 'old', contractVersion: '1', candidateDigest: 'c1', checkDefinitionDigest: 'd', environmentFingerprint: 'e', inputDigest: 'i', status: 'PASS', rawArtifactRefs: [], observedAt: '2026-01-01T00:00:00Z' });
  store.updateGoalDirection('history-goal', { acceptanceContract: { version: 2 }, reason: 'new contract' });
  store.recordEvidence({ id: 'history-expired', workItemId: 'history-item', requirementId: 'expired', contractVersion: '2', candidateDigest: 'c2', checkDefinitionDigest: 'd', environmentFingerprint: 'e', inputDigest: 'i', status: 'PASS', rawArtifactRefs: [], observedAt: '2026-01-02T00:00:00Z', expiresAt: '2026-01-03T00:00:00Z' });
  assert.deepEqual(store.listEvidenceForGoal('history-goal').map(evidence => evidence.id), []);
  const eventIds = new Set(store.listGoalEvents('history-goal').map(event => event.entity_id));
  assert.ok(eventIds.has('history-old'));
  assert.ok(eventIds.has('history-expired'));
});

test('跨 Store 的 provider lease 使用 token fencing，并可在过期后恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-lease-'));
  const path = join(dir, 'state.sqlite');
  const first = new Store(path);
  const second = new Store(path);
  const firstLease = first.acquireProviderLease('github:push:repo:key', 'worker-a', 100, 1_000);
  assert.equal(first.getProviderLease('github:push:repo:key')?.token, firstLease.token);
  assert.throws(() => second.acquireProviderLease('github:push:repo:key', 'worker-b', 100, 1_050), /held/);
  assert.throws(() => second.renewProviderLease('github:push:repo:key', 'wrong-token', 100, 1_060), /not writable/);
  const recovered = second.acquireProviderLease('github:push:repo:key', 'worker-b', 100, 1_101);
  assert.notEqual(recovered.token, firstLease.token);
  assert.throws(() => first.assertProviderLease('github:push:repo:key', firstLease.token, 1_101), /not writable/);
  assert.throws(() => first.releaseProviderLease('github:push:repo:key', firstLease.token), /not owned/);
  second.releaseProviderLease('github:push:repo:key', recovered.token);
  first.close();
  second.close();
  rmSync(dir, { recursive: true, force: true });
});
