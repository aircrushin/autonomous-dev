import type { Attempt, Evidence, Goal, HumanRequest, Operation, WorkItem } from '../contracts/index.js';
import type { TimelineEvent, TimelineSummary } from './timeline.js';

export interface GoalDashboard {
  goalId: string;
  goalStatus: Goal['status'];
  timeline: TimelineSummary;
  workItems: WorkItem[];
  currentWorkItems: WorkItem[];
  recoverableAttempts: Attempt[];
  attempts?: Attempt[];
  operations: Operation[];
  openHumanRequests: HumanRequest[];
  evidence: Evidence[];
  failureEvents: TimelineEvent[];
  budget: { reserved: number; limit?: number };
}

export function buildGoalDashboard(input: {
  goal: Goal;
  timeline: TimelineSummary;
  workItems: WorkItem[];
  recoverableAttempts: Attempt[];
  attempts?: Attempt[];
  operations: Operation[];
  humanRequests: HumanRequest[];
  evidence: Evidence[];
  reservedBudget: number;
}): GoalDashboard {
  const workItemIds = new Set(input.workItems.map(item => item.id));
  const evidence = input.evidence.filter(item => item.workItemId !== undefined ? workItemIds.has(item.workItemId) : [...workItemIds].some(workItemId => item.id.startsWith(`${workItemId}:`)));
  const limit = typeof input.goal.budget === 'object' && input.goal.budget !== null && 'limit' in input.goal.budget
    ? Number((input.goal.budget as Record<string, unknown>).limit)
    : undefined;
  return {
    goalId: input.goal.id,
    goalStatus: input.goal.status,
    timeline: input.timeline,
    workItems: input.workItems,
    currentWorkItems: input.workItems.filter(item => ['READY', 'RUNNING', 'BLOCKED'].includes(item.status)),
    recoverableAttempts: input.recoverableAttempts,
    attempts: input.attempts ?? input.recoverableAttempts,
    operations: input.operations,
    openHumanRequests: input.humanRequests.filter(request => request.status === 'OPEN'),
    evidence,
    failureEvents: input.timeline.events.filter(event => {
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : undefined;
      return /FAIL|ERROR|FAILED/.test(event.eventType) || ['FAIL', 'ERROR'].includes(String(payload?.status)) || ['FAILED', 'CLOSED_UNACHIEVABLE'].includes(String(payload?.to));
    }),
    budget: { reserved: input.reservedBudget, ...(Number.isFinite(limit) ? { limit } : {}) }
  };
}
