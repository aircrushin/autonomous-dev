import { spawn } from 'node:child_process';
import type { Command, CommandExecutor, ExecResult } from './types.js';

export interface LocalProcessOptions {
  /** 默认不继承调用方环境；调用方必须显式选择 inheritEnv 才能扩大权限边界。 */
  inheritEnv?: boolean;
  defaultTimeoutMs?: number;
  defaultMaxOutputBytes?: number;
}

export function validateCommand(command: Command): void {
  if (!command.argv.length || command.argv.some(part => typeof part !== 'string' || part.length === 0 || part.includes('\0'))) {
    throw new Error('command argv must contain non-empty strings without NUL bytes');
  }
  if (command.timeoutMs !== undefined && (!Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0)) {
    throw new Error('timeoutMs must be a positive number');
  }
  if (command.maxOutputBytes !== undefined && (!Number.isInteger(command.maxOutputBytes) || command.maxOutputBytes <= 0)) {
    throw new Error('maxOutputBytes must be a positive integer');
  }
}

function killProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

/** 本地有界进程执行器；不启用 shell，也不声称提供容器级隔离。 */
export class LocalProcessExecutor implements CommandExecutor {
  private readonly options: Required<LocalProcessOptions>;

  constructor(options: LocalProcessOptions = {}) {
    if (options.defaultTimeoutMs !== undefined && (!Number.isFinite(options.defaultTimeoutMs) || options.defaultTimeoutMs <= 0)) {
      throw new Error('defaultTimeoutMs must be a positive number');
    }
    if (options.defaultMaxOutputBytes !== undefined && (!Number.isInteger(options.defaultMaxOutputBytes) || options.defaultMaxOutputBytes <= 0)) {
      throw new Error('defaultMaxOutputBytes must be a positive integer');
    }
    this.options = {
      inheritEnv: options.inheritEnv ?? false,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 120_000,
      defaultMaxOutputBytes: options.defaultMaxOutputBytes ?? 16 * 1024 * 1024
    };
  }

  async exec(command: Command): Promise<ExecResult> {
    validateCommand(command);
    const timeoutMs = command.timeoutMs ?? this.options.defaultTimeoutMs;
    const maxOutputBytes = command.maxOutputBytes ?? this.options.defaultMaxOutputBytes;
    const env: NodeJS.ProcessEnv = this.options.inheritEnv ? { ...process.env } : {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: process.env.LANG ?? 'C'
    };
    for (const [key, value] of Object.entries(command.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) throw new Error(`invalid environment variable: ${key}`);
      env[key] = value;
    }

    const cwd = command.cwd;
    return await new Promise<ExecResult>((resolve) => {
      const child = spawn(command.argv[0], command.argv.slice(1), {
        cwd,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let outputLimitExceeded = false;
      let timedOut = false;
      let settled = false;
      let terminationRequested = false;
      let terminationTimer: ReturnType<typeof setTimeout> | undefined;
      let diagnosticError: string | undefined;
      const requestTermination = (): void => {
        if (terminationRequested) return;
        terminationRequested = true;
        killProcessTree(child, 'SIGTERM');
        terminationTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), 100);
        terminationTimer.unref?.();
      };
      const append = (target: Buffer[], chunk: Buffer): void => {
        if (outputLimitExceeded) return;
        const remaining = maxOutputBytes - outputBytes;
        if (remaining <= 0) {
          outputLimitExceeded = true;
          requestTermination();
          return;
        }
        const kept = chunk.subarray(0, remaining);
        target.push(kept);
        outputBytes += kept.length;
        if (kept.length < chunk.length) {
          outputLimitExceeded = true;
          requestTermination();
        }
      };
      child.stdout.on('data', chunk => append(stdout, Buffer.from(chunk)));
      child.stderr.on('data', chunk => append(stderr, Buffer.from(chunk)));
      const timer = setTimeout(() => {
        timedOut = true;
        requestTermination();
      }, timeoutMs);
      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (terminationTimer) clearTimeout(terminationTimer);
        resolve({ argv: command.argv, exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut, outputLimitExceeded: outputLimitExceeded || undefined, error: diagnosticError });
      };
      child.once('error', error => { diagnosticError = String(error); finish(1); });
      child.once('close', (code, signal) => finish(typeof code === 'number' ? code : signal ? 1 : 0));
    });
  }
}
