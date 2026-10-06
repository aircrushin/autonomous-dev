export interface WorkspaceHandle { id: string; path: string; baseRevision: string; }
export interface WorkspaceInput { id: string; repository: string; baseRevision?: string; root: string; }
export interface Command {
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /** 限制 stdout/stderr 的总捕获量，避免失控日志占满控制器内存。 */
  maxOutputBytes?: number;
}
export interface ExecResult {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded?: boolean;
  error?: string;
}

/** 可替换的有界命令执行契约；本地和 SSH transport 共用。 */
export interface CommandExecutor {
  exec(command: Command): Promise<ExecResult>;
}

export interface EnvironmentAdapter {
  create(input: WorkspaceInput): Promise<WorkspaceHandle>;
  exec(handle: WorkspaceHandle, command: Command): Promise<ExecResult>;
  snapshot(handle: WorkspaceHandle): Promise<{ revision: string; changedPaths: string[] }>;
  destroy(handle: WorkspaceHandle): Promise<void>;
}
