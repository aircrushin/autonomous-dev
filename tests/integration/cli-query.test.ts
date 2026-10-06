import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/database.js';

function cli(db: string, ...args: string[]): unknown {
  const output = execFileSync('pnpm', ['exec', 'tsx', 'apps/cli/src/index.ts', ...args], {
    cwd: process.cwd(), env: { ...process.env, DEVCTL_DB: db }, encoding: 'utf8'
  });
  return JSON.parse(output);
}

test('CLI 暴露 Goal、WorkItem 和 Attempt 的只读查询', () => {
  const root = mkdtempSync(join(tmpdir(), 'devctl-cli-query-'));
  const db = join(root, 'state.sqlite');
  try {
    const store = new Store(db);
    store.createGoal({ id: 'cli-goal', userIntent: 'query', constraints: [], acceptanceContract: {}, authorizationPolicy: {}, budget: {} });
    store.createWorkItem({ id: 'cli-item', goalId: 'cli-goal', description: 'item', dependencies: [] });
    store.recordAttempt({ id: 'cli-attempt', workItemId: 'cli-item', baseRevision: 'r', workspaceId: 'ws', agent: 'agent', startedAt: '2026-01-01' });
    store.close();
    assert.deepEqual((cli(db, 'goals') as Array<{ id: string }>).map(goal => goal.id), ['cli-goal']);
    assert.deepEqual((cli(db, 'goal:work-items', 'cli-goal') as Array<{ id: string }>).map(item => item.id), ['cli-item']);
    assert.deepEqual((cli(db, 'attempts', 'cli-item') as Array<{ id: string }>).map(attempt => attempt.id), ['cli-attempt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
