import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CommandExecutor, ExecResult } from '../environments/types.js';
import type { AgentAdapter, AgentRunInput, AgentRunResult, Handoff } from './types.js';

/**
 * Runs one bounded coding-agent command through an injected environment
 * executor. The executor may be local, SSH, or container backed; this adapter
 * never falls back to a controller-local process.
 */
export class CommandAgentAdapter implements AgentAdapter {
  private readonly runs = new Map<string, number>();
  private readonly cancelled = new Set<string>();
  private readonly activeRuns = new Set<string>();

  constructor(private readonly executor: CommandExecutor, private readonly logPath: string) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const runId = input.runId ?? `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const count = (this.runs.get(input.workItem) ?? 0) + 1;
    this.runs.set(input.workItem, count);
    if (input.budget.maxRuns !== undefined && count > input.budget.maxRuns) {
      return this.record(input, { runId, changedPaths: [], result: 'FAILED', summary: 'budget exhausted' });
    }
    if (!input.command?.length) {
      return this.record(input, { runId, changedPaths: [], result: 'FAILED', summary: 'missing agent command' });
    }

    this.activeRuns.add(runId);
    let result: AgentRunResult;
    try {
      const execution = await this.executor.exec({
        argv: [...input.command],
        cwd: input.workspace,
        timeoutMs: input.timeoutMs ?? 120_000,
        maxOutputBytes: input.maxOutputBytes ?? 16 * 1024 * 1024,
        env: input.env
      });
      result = this.cancelled.has(runId)
        ? { runId, changedPaths: [], result: 'CANCELLED', summary: 'cancel requested; executor completed without a cancellation handle' }
        : this.mapExecution(runId, execution);
    } catch (error) {
      result = this.cancelled.has(runId)
        ? { runId, changedPaths: [], result: 'CANCELLED', summary: `cancel requested; executor failed: ${String(error)}` }
        : { runId, changedPaths: [], result: 'FAILED', summary: String(error) };
    }
    this.activeRuns.delete(runId);
    this.cancelled.delete(runId);
    return this.record(input, result);
  }

  async cancel(runId: string): Promise<void> {
    // CommandExecutor deliberately exposes no process handle. The request is
    // fenced into the eventual result; timeout enforcement remains the
    // executor's termination boundary.
    if (this.activeRuns.has(runId)) this.cancelled.add(runId);
  }

  async resume(runId: string, handoff: Handoff): Promise<AgentRunResult> {
    return { runId, changedPaths: [], result: 'FAILED', summary: `resume requires a new command: ${handoff.nextStep ?? ''}` };
  }

  private mapExecution(runId: string, execution: ExecResult): AgentRunResult {
    const diagnostics = [execution.stderr, execution.error, execution.timedOut ? 'agent execution timed out' : undefined, execution.outputLimitExceeded ? 'agent output limit exceeded' : undefined].filter(Boolean).join('\n');
    if (execution.timedOut || execution.outputLimitExceeded || execution.error !== undefined || execution.exitCode !== 0) {
      return { runId, changedPaths: [], result: 'FAILED', summary: diagnostics || `agent exited with code ${execution.exitCode}` };
    }
    return { runId, changedPaths: [], result: 'SUCCEEDED', summary: [execution.stdout, execution.stderr].filter(Boolean).join('') };
  }

  private async record(input: AgentRunInput, result: AgentRunResult): Promise<AgentRunResult> {
    await mkdir(dirname(this.logPath), { recursive: true });
    // Do not persist command argv or agent output: either may contain tokens,
    // prompts, or repository data. The durable log is an execution receipt,
    // not a transcript.
    await appendFile(this.logPath, JSON.stringify({
      runId: result.runId,
      goal: input.goal,
      workItem: input.workItem,
      workspace: input.workspace,
      completionCriteria: input.completionCriteria,
      status: result.result,
      changedPaths: result.changedPaths,
      observedAt: new Date().toISOString()
    }) + '\n');
    return result;
  }
}
