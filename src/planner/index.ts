import type { CheckDefinition } from '../verification/types.js';

export interface RequirementPlan {
  id: string;
  description: string;
  checks: CheckDefinition[];
}

export interface WorkItemPlan {
  id: string;
  description: string;
  dependencies: string[];
}

export interface GoalPlan {
  contractVersion: string | number;
  requirements: RequirementPlan[];
  workItems: WorkItemPlan[];
}

export interface GoalPlanner {
  structure(input: { userIntent: string; constraints: unknown }): Promise<GoalPlan>;
}

export function validateGoalPlan(plan: GoalPlan): void {
  if (!plan || (typeof plan.contractVersion !== 'string' && typeof plan.contractVersion !== 'number') || String(plan.contractVersion).trim() === '') throw new Error('invalid plan contract version');
  if (!Array.isArray(plan.requirements) || plan.requirements.length === 0) throw new Error('plan requires at least one requirement');
  if (!Array.isArray(plan.workItems) || plan.workItems.length === 0) throw new Error('plan requires at least one work item');
  const requirementIds = new Set<string>();
  const checkIds = new Set<string>();
  for (const requirement of plan.requirements) {
    if (!requirement.id.trim() || requirementIds.has(requirement.id)) throw new Error(`duplicate or empty requirement id: ${requirement.id}`);
    if (!requirement.description.trim() || !Array.isArray(requirement.checks) || requirement.checks.length === 0) throw new Error(`requirement needs description and checks: ${requirement.id}`);
    requirementIds.add(requirement.id);
    for (const check of requirement.checks) {
      if (!check.id.trim() || checkIds.has(check.id) || !Array.isArray(check.command) || check.command.length === 0 || check.command.some(part => typeof part !== 'string')) throw new Error(`invalid or duplicate check: ${check.id}`);
      if (typeof check.required !== 'boolean') throw new Error(`check.required must be boolean: ${check.id}`);
      checkIds.add(check.id);
    }
  }
  const workItemIds = new Set<string>();
  for (const item of plan.workItems) {
    if (!item.id.trim() || workItemIds.has(item.id) || !item.description.trim() || !Array.isArray(item.dependencies)) throw new Error(`invalid or duplicate work item: ${item.id}`);
    workItemIds.add(item.id);
  }
  for (const item of plan.workItems) {
    for (const dependency of item.dependencies) {
      if (dependency === item.id || !workItemIds.has(dependency)) throw new Error(`invalid work item dependency: ${item.id} -> ${dependency}`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.workItems.map(item => [item.id, item]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`work item dependency cycle: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const item of plan.workItems) visit(item.id);
}

export async function structureGoal(planner: GoalPlanner, input: { userIntent: string; constraints: unknown }): Promise<GoalPlan> {
  const plan = await planner.structure(input);
  validateGoalPlan(plan);
  return plan;
}
