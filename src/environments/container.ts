import { isAbsolute, relative, resolve, posix } from 'node:path';
import type { Command, CommandExecutor, ExecResult } from './types.js';
import { LocalProcessExecutor, validateCommand } from './local-process.js';

export type ContainerRuntime = 'docker' | 'podman';

export interface ContainerCommandExecutorOptions {
  /** Supported runtimes default to Docker; use runtimePath for a test double or pinned binary. */
  runtime?: ContainerRuntime;
  runtimePath?: string;
  /** Image is deliberately required so execution cannot fall back to a host process. */
  image: string;
  /** Host workspace that is the only project filesystem made visible to the container. */
  workspacePath: string;
  /** Absolute path inside the container where workspacePath is mounted. */
  containerWorkspacePath?: string;
  readOnlyWorkspace?: boolean;
  executor?: CommandExecutor;
  defaultTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
}

function validateToken(value: string, name: string, options: { allowWhitespace?: boolean } = {}): void {
  if (!value || value.includes('\0') || (!options.allowWhitespace && /[\r\n]/.test(value)) || value.startsWith('-')) {
    throw new Error(`invalid ${name}`);
  }
}

function validateContainerPath(value: string, name: string): void {
  validateToken(value, name, { allowWhitespace: true });
  if (!value.startsWith('/') || value.includes(',') || value.includes(':')) throw new Error(`${name} must be an absolute container path without delimiters`);
  const normalized = posix.normalize(value);
  if (normalized === '/' || normalized === '/..' || normalized.startsWith('/../') || normalized.includes('/../')) {
    throw new Error(`${name} must not escape the container workspace`);
  }
}

function validateEnvironment(command: Command): void {
  for (const [key, value] of Object.entries(command.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0') || /[\r\n]/.test(value)) {
      throw new Error(`invalid environment variable: ${key}`);
    }
  }
}

function containerCwd(commandCwd: string | undefined, workspacePath: string, containerWorkspacePath: string): string {
  if (commandCwd === undefined) return containerWorkspacePath;
  if (!isAbsolute(commandCwd) || commandCwd.includes('\0')) throw new Error('container cwd must be an absolute path');
  const relativePath = relative(workspacePath, resolve(commandCwd));
  if (relativePath === '..' || relativePath.startsWith(`..${requirePathSeparator()}`) || isAbsolute(relativePath)) {
    throw new Error('container cwd must stay inside workspacePath');
  }
  return relativePath ? posix.join(containerWorkspacePath, ...relativePath.split(requirePathSeparator())) : containerWorkspacePath;
}

function requirePathSeparator(): '/' | '\\' {
  return process.platform === 'win32' ? '\\' : '/';
}

function validateOptions(options: ContainerCommandExecutorOptions): void {
  const runtimePath = options.runtimePath ?? options.runtime ?? 'docker';
  validateToken(runtimePath, 'container runtime');
  validateToken(options.image, 'container image');
  if (!isAbsolute(options.workspacePath) || options.workspacePath.includes('\0') || /[\r\n,:]/.test(options.workspacePath)) {
    throw new Error('workspacePath must be an absolute path without container mount delimiters');
  }
  validateContainerPath(options.containerWorkspacePath ?? '/workspace', 'containerWorkspacePath');
}

/**
 * Container transport using Docker or Podman argv. It intentionally does not
 * claim that a runtime is installed or that a container has been started: the
 * injected executor provides the same bounded timeout/output/error semantics as
 * LocalProcessExecutor and makes command construction independently testable.
 */
export class ContainerCommandExecutor implements CommandExecutor {
  private readonly options: Required<Pick<ContainerCommandExecutorOptions, 'runtimePath' | 'image' | 'workspacePath' | 'containerWorkspacePath'>> & ContainerCommandExecutorOptions;
  private readonly executor: CommandExecutor;

  constructor(options: ContainerCommandExecutorOptions) {
    validateOptions(options);
    const runtimePath = options.runtimePath ?? options.runtime ?? 'docker';
    const workspacePath = resolve(options.workspacePath);
    this.options = {
      ...options,
      runtimePath,
      image: options.image,
      workspacePath,
      containerWorkspacePath: options.containerWorkspacePath ?? '/workspace'
    };
    this.executor = options.executor ?? new LocalProcessExecutor({
      defaultTimeoutMs: options.defaultTimeoutMs,
      defaultMaxOutputBytes: options.defaultMaxOutputBytes
    });
  }

  async exec(command: Command): Promise<ExecResult> {
    validateCommand(command);
    validateEnvironment(command);
    const cwd = containerCwd(command.cwd, this.options.workspacePath, this.options.containerWorkspacePath);
    const mount = `type=bind,src=${this.options.workspacePath},dst=${this.options.containerWorkspacePath}${this.options.readOnlyWorkspace ? ',readonly' : ''}`;
    const argv = [
      this.options.runtimePath,
      'run',
      '--rm',
      '--init',
      '--network', 'none',
      '--workdir', cwd,
      '--mount', mount
    ];
    for (const [key, value] of Object.entries(command.env ?? {})) argv.push('--env', `${key}=${value}`);
    argv.push(this.options.image, ...command.argv);
    const result = await this.executor.exec({
      argv,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: command.maxOutputBytes
    });
    return { ...result, argv: command.argv };
  }
}
