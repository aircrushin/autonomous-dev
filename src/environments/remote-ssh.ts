import type { Command, CommandExecutor, ExecResult } from './types.js';
import { LocalProcessExecutor, validateCommand } from './local-process.js';

export interface SshCommandExecutorOptions {
  /** OpenSSH target, for example `builder@example.test`. */
  target: string;
  sshPath?: string;
  port?: number;
  identityFile?: string;
  /** Additional fixed ssh options. Values are passed as argv, never through a shell. */
  options?: string[];
  executor?: CommandExecutor;
  defaultTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
}

function quoteRemoteArg(value: string): string {
  if (value.includes('\0')) throw new Error('remote command arguments must not contain NUL bytes');
  // The remote command is interpreted by the SSH server's login shell. Single
  // quote every argument so command input remains data even though transport
  // itself is argv-based and shell:false on the controller.
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function validateOptions(options: SshCommandExecutorOptions): void {
  if (!options.target || options.target.includes('\0') || options.target.startsWith('-')) throw new Error('invalid ssh target');
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error('port must be between 1 and 65535');
  for (const value of options.options ?? []) {
    if (!value || value.includes('\0')) throw new Error('ssh options must contain non-empty strings without NUL bytes');
  }
  if (options.identityFile?.includes('\0')) throw new Error('identityFile must not contain NUL bytes');
}

function buildRemoteCommand(command: Command): string {
  const pieces: string[] = [];
  if (command.cwd !== undefined) {
    if (!command.cwd || command.cwd.includes('\0')) throw new Error('remote cwd must be non-empty and contain no NUL bytes');
    pieces.push(`cd ${quoteRemoteArg(command.cwd)}`);
  }
  for (const [key, value] of Object.entries(command.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) throw new Error(`invalid environment variable: ${key}`);
    pieces.push(`export ${key}=${quoteRemoteArg(value)}`);
  }
  pieces.push(`exec ${command.argv.map(quoteRemoteArg).join(' ')}`);
  return pieces.join(' && ');
}

/**
 * SSH transport for a bounded remote command.
 *
 * The controller only starts `ssh` with argv and shell:false. Timeout and
 * output limits are enforced around that transport process by the same
 * LocalProcessExecutor used for local work. This is a transport adapter, not
 * proof of remote isolation or a live remote-host integration.
 */
export class SshCommandExecutor implements CommandExecutor {
  private readonly options: Required<Pick<SshCommandExecutorOptions, 'target' | 'sshPath'>> & SshCommandExecutorOptions;
  private readonly executor: CommandExecutor;

  constructor(options: SshCommandExecutorOptions) {
    validateOptions(options);
    this.options = { ...options, target: options.target, sshPath: options.sshPath ?? 'ssh' };
    this.executor = options.executor ?? new LocalProcessExecutor({
      defaultTimeoutMs: options.defaultTimeoutMs,
      defaultMaxOutputBytes: options.defaultMaxOutputBytes
    });
  }

  async exec(command: Command): Promise<ExecResult> {
    validateCommand(command);
    const argv = [this.options.sshPath];
    for (const option of this.options.options ?? []) argv.push(option);
    if (this.options.port !== undefined) argv.push('-p', String(this.options.port));
    if (this.options.identityFile !== undefined) argv.push('-i', this.options.identityFile);
    argv.push('--', this.options.target, buildRemoteCommand(command));
    const result = await this.executor.exec({
      argv,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: command.maxOutputBytes
    });
    return { ...result, argv: command.argv };
  }
}
