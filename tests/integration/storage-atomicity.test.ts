import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/storage/database.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const goal = { id: 'g', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} };

test('event insertion faults roll back every entity creation and status change', () => {
  const store = new Store();
  store.createGoal(goal);
  store.createWorkItem({ id: 'w', goalId: 'g', description: 'x', dependencies: [] });
  store.createHumanRequest({ id: 'h', goalId: 'g', question: 'x', context: {}, requiredAuthority: 'x', status: 'OPEN' });
  const before = store.listEvents();
  store.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;");
  const creations: Array<[string, () => unknown]> = [
    ['goals', () => store.createGoal({ ...goal, id: 'new' })],
    ['work_items', () => store.createWorkItem({ id: 'new', goalId: 'g', description: 'x', dependencies: [] })],
    ['attempts', () => store.recordAttempt({ id: 'new', workItemId: 'w', baseRevision: 'r', workspaceId: 'w', agent: 'test', startedAt: '2026-01-01' })],
    ['evidence', () => store.recordEvidence({ id: 'new', requirementId: 'x', contractVersion: '1', candidateDigest: 'x', checkDefinitionDigest: 'x', environmentFingerprint: 'x', inputDigest: 'x', status: 'FAIL', rawArtifactRefs: [], observedAt: '2026-01-01' })],
    ['operations', () => store.createOperation({ actionId: 'new', idempotencyKey: 'new', exactRevision: 'r', intendedTarget: 'x', reconciliationStatus: 'PENDING' })],
    ['human_requests', () => store.createHumanRequest({ id: 'new', goalId: 'g', question: 'x', context: {}, requiredAuthority: 'x', status: 'OPEN' })],
  ];
  for (const [table, action] of creations) {
    const count = store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n;
    assert.throws(action, /injected event failure/);
    assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, count);
  }
  assert.throws(() => store.transitionGoal('g', 'PLANNING'), /injected/);
  assert.equal(store.getGoal('g')!.status, 'DRAFT');
  assert.throws(() => store.transitionWorkItem('w', 'READY'), /injected/);
  assert.equal(store.getWorkItem('w')!.status, 'PENDING');
  assert.throws(() => store.answerHumanRequest('h', 'yes'), /injected/);
  assert.equal(store.getHumanRequest('h')!.status, 'OPEN');
  assert.deepEqual(store.listEvents(), before);
  assert.throws(() => store.db.exec('DELETE FROM events'), /append-only/);
  assert.throws(() => store.db.exec("UPDATE events SET event_type = 'changed'"), /append-only/);
  store.close();
});

test('attempt timestamps survive reopening the database', () => {
  const root = mkdtempSync(join(tmpdir(), 'attempt-'));
  const path = join(root, 'state.sqlite');
  const store = new Store(path);
  store.createGoal(goal);
  store.createWorkItem({ id: 'w', goalId: 'g', description: 'x', dependencies: [] });
  const attempt = { id: 'a', workItemId: 'w', baseRevision: 'r', workspaceId: 'w', agent: 'test', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z', result: { status: 'FAILED' } };
  store.recordAttempt(attempt);
  store.close();
  const reopened = new Store(path);
  assert.deepEqual(reopened.getAttempt('a'), attempt);
  reopened.close();
  rmSync(root, { recursive: true });
});

test('旧数据库没有 Attempt 时间字段时仍可恢复历史记录', () => {
  const root = mkdtempSync(join(tmpdir(), 'legacy-'));
  const path = join(root, 'state.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE goals (id TEXT PRIMARY KEY, user_intent TEXT NOT NULL, constraints_json TEXT NOT NULL, acceptance_json TEXT NOT NULL, authorization_json TEXT NOT NULL, budget_json TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE work_items (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, description TEXT NOT NULL, dependencies_json TEXT NOT NULL, status TEXT NOT NULL, attempt_count INTEGER NOT NULL);
    CREATE TABLE attempts (id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, base_revision TEXT NOT NULL, workspace_id TEXT NOT NULL, agent TEXT NOT NULL, result_json TEXT);
    INSERT INTO goals VALUES ('g','x','[]','{}','{}','{}','DRAFT',1,'2026-01-01');
    INSERT INTO work_items VALUES ('w','g','x','[]','PENDING',0);
    INSERT INTO attempts VALUES ('a','w','r','ws','old',NULL);`);
  db.close();
  const store = new Store(path);
  assert.equal(store.getAttempt('a')?.startedAt, '');
  store.close();
  rmSync(root, { recursive: true });
});
