import test from 'node:test';
import assert from 'node:assert/strict';
import { runFairGoalScheduler, runIndependentWorkItems } from '../../src/controller/scheduler.js';

test('调度器并行运行无依赖工作项并跳过未满足依赖', async () => {
  const items = [
    { id: 'a', dependencies: [], status: 'READY' as const },
    { id: 'b', dependencies: [], status: 'READY' as const },
    { id: 'c', dependencies: ['missing'], status: 'READY' as const }
  ];
  let active = 0;
  let peak = 0;
  const result = await runIndependentWorkItems(items, async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; }, 2);
  assert.deepEqual(result.completed.sort(), ['a', 'b']);
  assert.deepEqual(result.skipped, ['c']);
  assert.deepEqual(result.failed, []);
  assert.equal(peak, 2);
});

test('单项失败被记录，不影响其他独立项', async () => {
  const result = await runIndependentWorkItems([{ id: 'ok', dependencies: [], status: 'READY' as const }, { id: 'bad', dependencies: [], status: 'READY' as const }], async item => { if (item.id === 'bad') throw new Error('failed'); }, 2);
  assert.deepEqual(result.completed, ['ok']);
  assert.deepEqual(result.failed, ['bad']);
});

test('依赖项在前一批成功后动态解锁', async () => {
  const order: string[] = [];
  const result = await runIndependentWorkItems([{ id: 'a', dependencies: [], status: 'READY' as const }, { id: 'b', dependencies: ['a'], status: 'READY' as const }], async item => { order.push(item.id); }, 1);
  assert.deepEqual(order, ['a', 'b']);
  assert.deepEqual(result.completed, ['a', 'b']);
  assert.deepEqual(result.skipped, []);
});

test('调度器拒绝重复工作项 ID 和非法并发上限', async () => {
  await assert.rejects(() => runIndependentWorkItems([{ id: 'same', dependencies: [], status: 'READY' as const }, { id: 'same', dependencies: [], status: 'READY' as const }], async () => {}), /duplicate work item id/);
  await assert.rejects(() => runIndependentWorkItems([], async () => {}, 0), /maxConcurrency must be a positive integer/);
});

test('Goal scheduler round-robin 轮转并支持有界退出', async () => {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const tasks = ['goal-a', 'goal-b', 'goal-c'].map(goalId => ({
    goalId,
    async step() {
      order.push(goalId);
      const count = (counts.get(goalId) ?? 0) + 1;
      counts.set(goalId, count);
      return { done: count === 2 };
    }
  }));
  const result = await runFairGoalScheduler(tasks);
  assert.deepEqual(order, ['goal-a', 'goal-b', 'goal-c', 'goal-a', 'goal-b', 'goal-c']);
  assert.deepEqual(result.completed, ['goal-a', 'goal-b', 'goal-c']);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.turns, 6);

  const bounded = await runFairGoalScheduler(['long-a', 'long-b'].map(goalId => ({ goalId, async step() { return { done: false }; } })), { maxTurns: 3 });
  assert.equal(bounded.turns, 3);
  assert.deepEqual(bounded.skipped, ['long-b', 'long-a']);

  const isolated = await runFairGoalScheduler([
    { goalId: 'sync-failure', step() { throw new Error('sync failure'); } },
    { goalId: 'survivor', async step() { return { done: true }; } }
  ]);
  assert.deepEqual(isolated.failed, ['sync-failure']);
  assert.deepEqual(isolated.completed, ['survivor']);

  const concurrentBounded = await runFairGoalScheduler(['bound-a', 'bound-b', 'bound-c'].map(goalId => ({ goalId, async step() { return { done: false }; } })), { maxConcurrency: 2, maxTurns: 5 });
  assert.equal(concurrentBounded.turns, 5);
  assert.deepEqual(concurrentBounded.skipped, ['bound-c', 'bound-a', 'bound-b']);
});
