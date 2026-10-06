export interface SchedulableWorkItem { id: string; dependencies: string[]; status: 'READY' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED'; }
export interface ScheduleResult { completed: string[]; failed: string[]; skipped: string[]; }
export interface ScheduleControl { defer?: boolean; stop?: boolean; }

export interface FairGoalTask {
  goalId: string;
  step(): Promise<{ done: boolean }>;
}

export interface FairGoalScheduleResult {
  completed: string[];
  failed: string[];
  skipped: string[];
  turns: number;
}

/** 只并行调度依赖已满足的工作项；单项失败不会伪装成整体成功。 */
export async function runIndependentWorkItems<T extends SchedulableWorkItem>(items: T[], run: (item: T) => Promise<void | ScheduleControl>, maxConcurrency = 2): Promise<ScheduleResult> {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('maxConcurrency must be a positive integer');
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`duplicate work item id: ${item.id}`);
    ids.add(item.id);
  }
  const completed = new Set(items.filter(item => item.status === 'SUCCEEDED').map(item => item.id));
  const pending = new Set(items.filter(item => item.status === 'READY').map(item => item.id));
  const failed: string[] = [];
  const done: string[] = [];
  const deferred: string[] = [];
  let stopScheduling = false;
  const byId = new Map(items.map(item => [item.id, item]));
  while (pending.size) {
    const batch = [...pending].map(id => byId.get(id)!).filter(item => item.dependencies.every(dep => completed.has(dep)));
    if (!batch.length) return { completed: done, failed, skipped: [...pending] };
    for (const item of batch) pending.delete(item.id);
    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < batch.length && !stopScheduling) {
        const item = batch[cursor++];
        try {
          const control = await run(item);
          if (control?.defer) deferred.push(item.id);
          else { done.push(item.id); completed.add(item.id); }
          if (control?.stop) stopScheduling = true;
        } catch { failed.push(item.id); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(maxConcurrency, batch.length) }, () => worker()));
    if (stopScheduling) return { completed: done, failed, skipped: [...deferred, ...pending, ...batch.slice(cursor).map(item => item.id)] };
    for (const id of deferred) pending.add(id);
    deferred.length = 0;
  }
  return { completed: done, failed, skipped: [] };
}

/**
 * Give each active Goal one bounded turn before any Goal receives another.
 * A turn is intentionally supplied by the caller so persistence, leases and
 * controller state remain outside this scheduling primitive.
 */
export async function runFairGoalScheduler(tasks: FairGoalTask[], options: { maxConcurrency?: number; maxTurns?: number } = {}): Promise<FairGoalScheduleResult> {
  const maxConcurrency = options.maxConcurrency ?? 1;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('maxConcurrency must be a positive integer');
  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)) throw new Error('maxTurns must be a positive integer');
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.goalId.trim()) throw new Error('goalId is required');
    if (ids.has(task.goalId)) throw new Error(`duplicate goal id: ${task.goalId}`);
    ids.add(task.goalId);
  }
  const queue = [...tasks];
  const completed: string[] = [];
  const failed: string[] = [];
  let turns = 0;
  while (queue.length && (options.maxTurns === undefined || turns < options.maxTurns)) {
    const remainingTurns = options.maxTurns === undefined ? maxConcurrency : options.maxTurns - turns;
    const wave = queue.splice(0, Math.min(maxConcurrency, queue.length, remainingTurns));
    const outcomes = await Promise.allSettled(wave.map(task => Promise.resolve().then(() => task.step()).then(result => result)));
    turns += wave.length;
    for (let index = 0; index < wave.length; index += 1) {
      const task = wave[index];
      const outcome = outcomes[index];
      if (outcome.status === 'rejected') failed.push(task.goalId);
      else if (outcome.value.done) completed.push(task.goalId);
      else queue.push(task);
    }
  }
  return { completed, failed, skipped: queue.map(task => task.goalId), turns };
}
