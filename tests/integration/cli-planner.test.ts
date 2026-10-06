import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/database.js';

function runCli(db: string, ...args: string[]) {
  return spawnSync('pnpm', ['exec', 'tsx', 'apps/cli/src/index.ts', ...args], { cwd: process.cwd(), env: { ...process.env, DEVCTL_DB: db }, encoding: 'utf8' });
}

test('CLI 显式 plan JSON 原子创建 Goal、验收和 WorkItems', () => {
  const root = mkdtempSync(join(tmpdir(), 'devctl-cli-plan-')); const db = join(root, 'state.sqlite'); const file = join(root, 'plan.json');
  try {
    writeFileSync(file, JSON.stringify({ contractVersion: 1, requirements: [{ id: 'req', description: 'works', checks: [{ id: 'check', command: ['true'], required: true }] }], workItems: [{ id: 'implement', description: 'implement', dependencies: [] }] }));
    const result = runCli(db, 'goal:create-plan', 'cli-planned', 'add feature', file);
    assert.equal(result.status, 0, result.stderr);
    const store = new Store(db);
    assert.equal(store.getGoal('cli-planned')?.userIntent, 'add feature');
    assert.equal(store.listWorkItems('cli-planned')[0]?.id, 'implement');
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI 拒绝缺失/非法 plan、重复 Goal，且不隐式调用 planner', () => {
  const root = mkdtempSync(join(tmpdir(), 'devctl-cli-plan-invalid-')); const db = join(root, 'state.sqlite'); const invalid = join(root, 'invalid.json'); const missing = join(root, 'missing.json');
  try {
    writeFileSync(invalid, JSON.stringify({ contractVersion: 1, requirements: [], workItems: [] }));
    assert.notEqual(runCli(db, 'goal:create-plan', 'bad', 'intent', invalid).status, 0);
    const invalidStore = new Store(db); assert.equal(invalidStore.getGoal('bad'), undefined); invalidStore.close();
    assert.notEqual(runCli(db, 'goal:create-plan', 'missing', 'intent', missing).status, 0);
    const valid = join(root, 'valid.json'); writeFileSync(valid, JSON.stringify({ contractVersion: 1, requirements: [{ id: 'req', description: 'works', checks: [{ id: 'check', command: ['true'], required: true }] }], workItems: [{ id: 'work', description: 'work', dependencies: [] }] }));
    assert.equal(runCli(db, 'goal:create-plan', 'dup', 'intent', valid).status, 0);
    assert.notEqual(runCli(db, 'goal:create-plan', 'dup', 'intent', valid).status, 0);
    const store = new Store(db); assert.equal(store.listWorkItems('dup').length, 1); store.close();
    assert.notEqual(runCli(db, 'goal:create-plan', 'no-plan', 'intent').status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
