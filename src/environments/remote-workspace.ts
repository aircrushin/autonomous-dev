import { posix } from 'node:path';
import type { Command, CommandExecutor, EnvironmentAdapter, ExecResult, WorkspaceHandle, WorkspaceInput } from './types.js';
import { SshCommandExecutor, type SshCommandExecutorOptions } from './remote-ssh.js';

export interface SshWorkspaceEnvironmentOptions extends SshCommandExecutorOptions {
  /** Root directory on the remote host under which all workspace paths live. */
  workspaceRoot: string;
}

function validateToken(value: string, name: string): void {
  if (!value || value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    throw new Error(`${name} must be a non-empty token without NUL or newline`);
  }
}

function validateWorkspaceId(id: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') throw new Error('invalid workspace id');
}

function validateRoot(root: string): string {
  validateToken(root, 'workspaceRoot');
  if (!posix.isAbsolute(root)) throw new Error('workspaceRoot must be an absolute path');
  const normalized = posix.normalize(root);
  if (normalized === '/') throw new Error('workspaceRoot must not be filesystem root');
  return normalized;
}

function pathFor(root: string, id: string): string {
  validateWorkspaceId(id);
  const path = posix.join(root, id);
  if (path === root || !path.startsWith(`${root}/`)) throw new Error('workspace path escaped workspaceRoot');
  return path;
}

function failedResult(command: Command, message: string): ExecResult {
  return { argv: command.argv, exitCode: 126, stdout: '', stderr: message, timedOut: false };
}

/**
 * Remote Git workspace lifecycle over the bounded SSH command transport.
 *
 * This controls command construction and path ownership; it does not claim
 * container/VM isolation on the remote host. A handle can only destroy or
 * execute below the configured workspaceRoot and its validated workspace id.
 */
export class SshWorkspaceEnvironment implements EnvironmentAdapter {
  private readonly root: string;
  private readonly executor: CommandExecutor;

  constructor(options: SshWorkspaceEnvironmentOptions, executor?: CommandExecutor) {
    this.root = validateRoot(options.workspaceRoot);
    this.executor = executor ?? options.executor ?? new SshCommandExecutor(options);
  }

  private expectedPath(id: string): string {
    return pathFor(this.root, id);
  }

  private validateHandle(handle: WorkspaceHandle): string {
    validateWorkspaceId(handle.id);
    const expected = this.expectedPath(handle.id);
    if (handle.path !== expected) throw new Error('workspace handle path is outside workspaceRoot');
    validateToken(handle.baseRevision, 'workspace baseRevision');
    return expected;
  }

  private async runChecked(command: Command, operation: string): Promise<ExecResult> {
    const result = await this.executor.exec(command);
    if (result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded || result.error) {
      const details = result.stderr || result.error || `exit code ${result.exitCode}`;
      throw new Error(`${operation} failed: ${details}`);
    }
    return result;
  }

  async create(input: WorkspaceInput): Promise<WorkspaceHandle> {
    validateWorkspaceId(input.id);
    const repository = input.repository;
    validateToken(repository, 'repository');
    const root = validateRoot(input.root);
    if (root !== this.root) throw new Error('workspace input root does not match workspaceRoot');
    if (input.baseRevision !== undefined) validateToken(input.baseRevision, 'baseRevision');
    const path = this.expectedPath(input.id);
    const pending: WorkspaceHandle = { id: input.id, path, baseRevision: input.baseRevision ?? 'pending' };
    let workspaceOwned = false;
    try {
      await this.runChecked({ argv: ['mkdir', '-p', '--', this.root] }, 'create workspace root');
      await this.runChecked({ argv: ['mkdir', '--', path] }, 'reserve workspace path');
      workspaceOwned = true;
      await this.runChecked({ argv: ['git', 'clone', '--', repository, path] }, 'clone repository');
      if (input.baseRevision !== undefined) {
        await this.runChecked({ argv: ['git', 'checkout', '--detach', '--', input.baseRevision], cwd: path }, 'checkout base revision');
      }
      const revision = (await this.runChecked({ argv: ['git', 'rev-parse', 'HEAD'], cwd: path }, 'read base revision')).stdout.trim();
      validateToken(revision, 'resolved baseRevision');
      return { ...pending, baseRevision: revision };
    } catch (error) {
      if (workspaceOwned) {
        try { await this.destroy(pending); } catch { /* preserve the original failure; cleanup is best effort */ }
      }
      throw error;
    }
  }

  async exec(handle: WorkspaceHandle, command: Command): Promise<ExecResult> {
    const path = this.validateHandle(handle);
    const cwd = command.cwd ?? path;
    validateToken(cwd, 'workspace cwd');
    if (!posix.isAbsolute(cwd)) return failedResult(command, 'cwd must be an absolute path inside workspace');
    const relative = posix.relative(path, posix.normalize(cwd));
    if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
      return failedResult(command, 'cwd outside workspace');
    }
    return this.executor.exec({ ...command, cwd });
  }

  async snapshot(handle: WorkspaceHandle): Promise<{ revision: string; changedPaths: string[] }> {
    const path = this.validateHandle(handle);
    const revision = (await this.runChecked({ argv: ['git', 'rev-parse', 'HEAD'], cwd: path }, 'read workspace revision')).stdout.trim();
    const output = (await this.runChecked({ argv: ['git', 'status', '--porcelain=v1'], cwd: path }, 'read workspace status')).stdout;
    const changedPaths = output.split('\n').filter(Boolean).map(line => line.slice(2).trim()).filter(Boolean);
    return { revision, changedPaths };
  }

  async destroy(handle: WorkspaceHandle): Promise<void> {
    const path = this.validateHandle(handle);
    await this.runChecked({ argv: ['rm', '-rf', '--', path] }, 'destroy workspace');
  }
}
