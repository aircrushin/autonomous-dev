#!/usr/bin/env node
import { Store } from '../../../src/storage/database.js';
import { summarizeTimeline } from '../../../src/observability/timeline.js';
import { buildGoalDashboard } from '../../../src/observability/dashboard.js';
import { exportDashboardJson, exportDashboardPrometheus, exportTimelineJson, exportTimelinePrometheus } from '../../../src/observability/export.js';
import { readFileSync } from 'node:fs';
import { validateGoalPlan } from '../../../src/planner/index.js';

const [command, id, target, planPath] = process.argv.slice(2);
const store = new Store(process.env.DEVCTL_DB ?? '.devctl/state.sqlite');
const exportId = command === 'timeline:export' && (id === 'json' || id === 'prometheus') ? undefined : id;
const exportFormat = command === 'timeline:export' && (id === 'json' || id === 'prometheus') ? id : target;
function outputExport(format: string | undefined, json: () => string, prometheus: () => string): void {
  if (format === undefined || format === 'json') console.log(json());
  else if (format === 'prometheus') process.stdout.write(prometheus());
  else { console.error(`不支持的导出格式: ${format}`); process.exitCode = 2; }
}
function dashboardFor(goalId: string) {
  const snapshot = store.getGoalSnapshot(goalId);
  if (!snapshot) return undefined;
  const workItemIds = new Set(snapshot.workItems.map(item => item.id));
  return buildGoalDashboard({ goal: snapshot.goal, timeline: summarizeTimeline(snapshot.events), workItems: snapshot.workItems, recoverableAttempts: snapshot.attempts.filter(attempt => workItemIds.has(attempt.workItemId) && attempt.endedAt === undefined), operations: snapshot.operations, humanRequests: snapshot.humanRequests, evidence: snapshot.evidence, reservedBudget: snapshot.reservedBudget });
}
if (command === 'goal:create' && id) {
  store.createGoal({ id, userIntent: target ?? '', constraints: [], acceptanceContract: { version: 1 }, authorizationPolicy: {}, budget: {} });
  console.log(JSON.stringify(store.getGoal(id), null, 2));
} else if (command === 'goal:create-plan' && id && target && planPath) {
  try {
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    validateGoalPlan(plan);
    const created = store.createGoalWithPlan({ id, userIntent: target, constraints: [], authorizationPolicy: {}, budget: {}, plan });
    console.log(JSON.stringify(created, null, 2));
  } catch (error) {
    console.error(`无法创建计划 Goal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command === 'goal:transition' && id && target) {
  console.log(JSON.stringify(store.transitionGoal(id, target as never), null, 2));
} else if (command === 'goal:show' && id) {
  const goal = store.getGoal(id);
  if (!goal) { console.error(`Goal 不存在: ${id}`); process.exitCode = 1; }
  else console.log(JSON.stringify(goal, null, 2));
} else if (command === 'goals') {
  console.log(JSON.stringify(store.listGoals(), null, 2));
} else if (command === 'goal:work-items' && id) {
  if (!store.getGoal(id)) { console.error(`Goal 不存在: ${id}`); process.exitCode = 1; }
  else console.log(JSON.stringify(store.listWorkItems(id), null, 2));
} else if (command === 'attempts') {
  console.log(JSON.stringify(store.listAttempts(id), null, 2));
} else if (command === 'events') {
  console.log(JSON.stringify(store.listEvents(id), null, 2));
} else if (command === 'timeline') {
  const rows = id && store.getGoal(id) ? store.listGoalEvents(id) : store.listEvents(id);
  console.log(JSON.stringify(summarizeTimeline(rows), null, 2));
} else if (command === 'timeline:export') {
  const rows = exportId && store.getGoal(exportId) ? store.listGoalEvents(exportId) : store.listEvents(exportId);
  const summary = summarizeTimeline(rows);
  outputExport(exportFormat, () => exportTimelineJson(summary), () => exportTimelinePrometheus(summary, exportId && store.getGoal(exportId) ? { goal_id: exportId } : {}));
} else if (command === 'dashboard' && id) {
  const dashboard = dashboardFor(id);
  if (!dashboard) { console.error(`Goal 不存在: ${id}`); process.exitCode = 1; }
  else console.log(JSON.stringify(dashboard, null, 2));
} else if (command === 'dashboard:export' && id) {
  const dashboard = dashboardFor(id);
  if (!dashboard) { console.error(`Goal 不存在: ${id}`); process.exitCode = 1; }
  else outputExport(target, () => exportDashboardJson(dashboard), () => exportDashboardPrometheus(dashboard));
} else if (command === 'human:show' && id) {
  const request = store.getHumanRequest(id);
  if (!request) { console.error(`HumanRequest 不存在: ${id}`); process.exitCode = 1; }
  else console.log(JSON.stringify(request, null, 2));
} else if (command === 'human:answer' && id && target) {
  console.log(JSON.stringify(store.answerHumanRequest(id, target), null, 2));
} else if (command === 'operation:cancel' && id && target) {
  console.log(JSON.stringify(store.cancelOperation(id, target), null, 2));
} else {
  console.error('用法: devctl goal:create <goal-id> <intent> | goal:create-plan <goal-id> <intent> <plan.json> | goal:show <goal-id> | goals | goal:work-items <goal-id> | attempts [work-item-id] | goal:transition <goal-id> <status> | events [entity-id] | timeline [entity-id] | timeline:export [entity-id] [json|prometheus] | dashboard <goal-id> | dashboard:export <goal-id> [json|prometheus] | human:show <id> | human:answer <id> <answer> | operation:cancel <action-id> <reason>');
  process.exitCode = 2;
}
