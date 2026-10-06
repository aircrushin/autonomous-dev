import { execFile } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { AgentAdapter, AgentRunInput, AgentRunResult, Handoff } from './types.js';

const run = promisify(execFile);

export class ShellAgentAdapter implements AgentAdapter {
  private readonly runs = new Map<string, number>();
  constructor(private readonly logPath: string) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const runId = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const count = (this.runs.get(input.workItem) ?? 0) + 1;
    this.runs.set(input.workItem, count);
    if (input.budget.maxRuns !== undefined && count > input.budget.maxRuns) return { runId, changedPaths: [], result: 'FAILED', summary: 'budget exhausted' };
    if (!input.command?.length) return { runId, changedPaths: [], result: 'FAILED', summary: 'missing agent command' };
    let result: AgentRunResult;
    try {
      const output = await run(input.command[0], input.command.slice(1), { cwd: input.workspace, maxBuffer: 16 * 1024 * 1024 });
      result = { runId, changedPaths: [], result: 'SUCCEEDED', summary: output.stdout + output.stderr };
    } catch (error) { result = { runId, changedPaths: [], result: 'FAILED', summary: String(error) }; }
    await mkdir(dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, JSON.stringify({ runId, input, result, observedAt: new Date().toISOString() }) + '\n');
    return result;
  }

  async cancel(_runId: string): Promise<void> { return; }
  async resume(runId: string, handoff: Handoff): Promise<AgentRunResult> { return { runId, changedPaths: [], result: 'FAILED', summary: `resume requires a new command: ${handoff.nextStep ?? ''}` }; }
}
