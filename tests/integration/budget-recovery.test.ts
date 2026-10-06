import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../src/storage/database.js';

test('预算预留原子限制并恢复中断 Attempt', () => {
  const store = new Store();
  store.createGoal({ id: 'g', userIntent: 'x', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
  assert.equal(store.reserveBudget('g', 2, 3), 2);
  assert.throws(() => store.reserveBudget('g', 2, 3), /exhausted/);
  store.createWorkItem({ id: 'w', goalId: 'g', description: 'x', dependencies: [] });
  store.recordAttempt({ id: 'a', workItemId: 'w', baseRevision: 'r', workspaceId: 'ws', agent: 'x', startedAt: '2026-01-01' });
  assert.equal(store.listRecoverableAttempts().length, 1);
  assert.equal(store.recoverInterruptedAttempts('2026-01-02')[0].id, 'a');
  assert.equal(store.listRecoverableAttempts().length, 0);
  assert.match(JSON.stringify(store.getAttempt('a')?.result), /recovered/);
});
