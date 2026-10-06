import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../../src/storage/database.js';
import { structureGoal, type GoalPlan } from '../../src/planner/index.js';

const plan: GoalPlan = { contractVersion: 1, requirements: [{ id: 'feature', description: 'feature exists', checks: [{ id: 'feature-check', command: ['true'], required: true }] }], workItems: [{ id: 'implement', description: 'implement feature', dependencies: [] }, { id: 'verify', description: 'verify feature', dependencies: ['implement'] }] };

test('fake planner 结构化 Goal，并在 SQLite 重启后保留验收与 WorkItem DAG', async () => {
  const root = mkdtempSync(join(tmpdir(), 'planner-')); const path = join(root, 'state.sqlite');
  try {
    const planner = { async structure() { return plan; } };
    const structured = await structureGoal(planner, { userIntent: 'add feature', constraints: [] });
    const first = new Store(path);
    const created = first.createGoalWithPlan({ id: 'planned-goal', userIntent: 'add feature', constraints: [], authorizationPolicy: {}, budget: {}, plan: structured });
    assert.deepEqual(created.workItems.map(item => [item.id, item.dependencies]), [['implement', []], ['verify', ['implement']]]);
    first.close();
    const second = new Store(path);
    assert.deepEqual(second.getGoal('planned-goal')?.acceptanceContract, { version: 1, requirements: plan.requirements });
    assert.equal(second.listWorkItems('planned-goal').length, 2);
    second.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('planner 输出拒绝空 requirement/check、重复 ID、缺失依赖和依赖环', async () => {
  const invalidPlans: GoalPlan[] = [
    { ...plan, requirements: [] },
    { ...plan, requirements: [{ ...plan.requirements[0]!, checks: [] }] },
    { ...plan, requirements: [{ ...plan.requirements[0]!, id: 'feature' }, { ...plan.requirements[0]!, id: 'feature' }] },
    { ...plan, workItems: [{ id: 'implement', description: 'x', dependencies: ['missing'] }] },
    { ...plan, workItems: [{ id: 'implement', description: 'x', dependencies: ['verify'] }, { id: 'verify', description: 'y', dependencies: ['implement'] }] }
  ];
  for (const invalid of invalidPlans) await assert.rejects(() => structureGoal({ async structure() { return invalid; } }, { userIntent: 'x', constraints: [] }));
});

test('规划失败或持久化校验失败不会留下半成品 Goal', async () => {
  const store = new Store();
  await assert.rejects(() => structureGoal({ async structure() { throw new Error('planner unavailable'); } }, { userIntent: 'x', constraints: [] }), /planner unavailable/);
  assert.equal(store.listGoals().length, 0);
  assert.throws(() => store.createGoalWithPlan({ id: 'invalid-plan', userIntent: 'x', constraints: [], authorizationPolicy: {}, budget: {}, plan: { ...plan, workItems: [{ id: 'a', description: 'a', dependencies: ['missing'] }] } }), /invalid work item dependency/);
  assert.equal(store.getGoal('invalid-plan'), undefined);
});
