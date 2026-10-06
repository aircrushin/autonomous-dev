export interface AgentRunInput {
  /** Optional caller-provided id so cancellation can fence an in-flight run. */
  runId?: string;
  goal: string;
  workItem: string;
  workspace: string;
  budget: { maxRuns?: number };
  completionCriteria: string[];
  command?: string[];
  /** 本轮 Agent 命令的有界执行参数，由环境执行器解释。 */
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}
export interface AgentRunResult { runId: string; revision?: string; changedPaths: string[]; result: 'SUCCEEDED' | 'FAILED' | 'CANCELLED'; summary: string; }
export interface Handoff { completed: string[]; currentRevision?: string; verification: string[]; failures: string[]; ruledOut: string[]; remaining: string[]; nextStep?: string; }

export interface AgentAdapter {
  run(input: AgentRunInput): Promise<AgentRunResult>;
  cancel(runId: string): Promise<void>;
  resume(runId: string, handoff: Handoff): Promise<AgentRunResult>;
}
