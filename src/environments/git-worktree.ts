import { mkdir } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Command, EnvironmentAdapter, ExecResult, WorkspaceHandle, WorkspaceInput } from './types.js';
import { LocalProcessExecutor } from './local-process.js';

const run = promisify(execFile);
async function git(repository: string, args: string[], cwd?: string): Promise<string> {
  const result = await run('git', args, { cwd: cwd ?? repository, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.trim();
}

export class GitWorktreeEnvironment implements EnvironmentAdapter {
  private readonly executor = new LocalProcessExecutor({ inheritEnv: false });

  async create(input: WorkspaceInput): Promise<WorkspaceHandle> {
    if (!/^[A-Za-z0-9._-]+$/.test(input.id)) throw new Error('invalid workspace id');
    await mkdir(input.root, { recursive: true });
    const path = join(input.root, input.id);
    const baseRevision = input.baseRevision ?? await git(input.repository, ['rev-parse', 'HEAD']);
    await git(input.repository, ['worktree', 'add', '--detach', path, baseRevision]);
    return { id: input.id, path, baseRevision };
  }

  async exec(handle: WorkspaceHandle, command: Command): Promise<ExecResult> {
    const timeoutMs = command.timeoutMs ?? 120_000;
    const cwd = command.cwd ?? handle.path;
    const rel = relative(handle.path, cwd);
    if (isAbsolute(rel) || rel.startsWith('..')) return { argv: command.argv, exitCode: 126, stdout: '', stderr: 'cwd outside workspace', timedOut: false };
    let workspaceReal: string;
    let cwdReal: string;
    try {
      workspaceReal = await realpath(handle.path);
      cwdReal = await realpath(cwd);
    } catch {
      return { argv: command.argv, exitCode: 126, stdout: '', stderr: 'cwd is unavailable', timedOut: false };
    }
    const realRel = relative(workspaceReal, cwdReal);
    if (isAbsolute(realRel) || realRel === '..' || realRel.startsWith('..')) return { argv: command.argv, exitCode: 126, stdout: '', stderr: 'cwd outside workspace', timedOut: false };
    return this.executor.exec({ ...command, cwd, timeoutMs });
  }

  async snapshot(handle: WorkspaceHandle): Promise<{ revision: string; changedPaths: string[] }> {
    const revision = await git(handle.path, ['rev-parse', 'HEAD']);
    const output = await git(handle.path, ['status', '--porcelain']);
    const changedPaths = output ? output.split('\n').map(line => line.slice(2).trim()).filter(Boolean) : [];
    return { revision, changedPaths };
  }

  async destroy(handle: WorkspaceHandle): Promise<void> {
    try { await git(handle.path, ['worktree', 'remove', '--force', handle.path]); } catch (error) {
      if (!String(error).includes('is not a working tree')) throw error;
    }
  }
}
