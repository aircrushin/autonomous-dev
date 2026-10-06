import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { CommandExecutor } from '../environments/types.js';
import type { CheckDefinition, VerificationResult } from './types.js';

const run = promisify(execFile);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const MANDATORY_QUALITY_CHECK_IDS = ['quality-lint', 'quality-secrets'] as const;
export function mandatoryQualityChecks(workspace: string): CheckDefinition[] {
  const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url));
  return [
    { id: 'quality-lint', command: [process.execPath, join(scripts, 'lint.mjs'), workspace], required: true },
    { id: 'quality-secrets', command: [process.execPath, join(scripts, 'scan-secrets.mjs'), workspace], required: true },
  ];
}

function persistArtifacts(artifactDir: string | undefined, check: CheckDefinition, index: number, artifactKey: string, stdout: string, stderr: string): string[] {
  if (artifactDir === undefined) return [];
  const directory = resolve(artifactDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stem = `${String(index).padStart(3, '0')}-${digest(`${check.id}:${artifactKey}`).slice(0, 24)}`;
  const refs: string[] = [];
  for (const [kind, content] of [['stdout', stdout], ['stderr', stderr]] as const) {
    const path = join(directory, `${stem}-${kind}.log`);
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    refs.push(path);
  }
  return refs;
}

function safePersistArtifacts(artifactDir: string | undefined, check: CheckDefinition, index: number, artifactKey: string, stdout: string, stderr: string): { refs: string[]; error?: string } {
  try {
    return { refs: persistArtifacts(artifactDir, check, index, artifactKey, stdout, stderr) };
  } catch (error) {
    return { refs: [], error: `artifact persistence failed: ${String(error)}` };
  }
}

export function assertQualityProfile(workspace: string, checks: CheckDefinition[], qualityProfile?: 'mandatory'): void {
  if (qualityProfile === 'mandatory') {
    const canonical = mandatoryQualityChecks(workspace);
    for (const required of canonical) {
      const supplied = checks.find(check => check.id === required.id);
      if (!supplied) throw new Error(`mandatory quality check missing: ${required.id}`);
      if (!supplied.required || checks.filter(check => check.id === required.id).length !== 1) throw new Error(`invalid mandatory quality check: ${required.id}`);
      if (JSON.stringify(supplied.command) !== JSON.stringify(required.command)) throw new Error(`mandatory quality check command mismatch: ${required.id}`);
    }
  }
}

export async function verifyChecks(input: { workspace: string; contractVersion: string; candidateDigest: string; environmentFingerprint: string; inputDigest: string; checks: CheckDefinition[]; executor?: CommandExecutor; artifactDir?: string; qualityProfile?: 'mandatory' }): Promise<VerificationResult[]> {
  assertQualityProfile(input.workspace, input.checks, input.qualityProfile);
  const results: VerificationResult[] = [];
  const runId = randomUUID();
  for (const [index, check] of input.checks.entries()) {
    const observedAt = new Date().toISOString();
    const base = { requirementId: check.id, contractVersion: input.contractVersion, candidateDigest: input.candidateDigest, checkDefinitionDigest: digest(check), environmentFingerprint: input.environmentFingerprint, inputDigest: input.inputDigest, observedAt, rawArtifactRefs: [] as string[] };
    try {
      if (input.executor) {
        const result = await input.executor.exec({ argv: [...check.command], cwd: input.workspace, timeoutMs: check.timeoutMs ?? 120_000, maxOutputBytes: 16 * 1024 * 1024 });
        // Interrupted or truncated checks cannot establish candidate correctness.
        const diagnostics = [result.stderr, result.error, result.outputLimitExceeded ? 'verification output limit exceeded' : undefined].filter(Boolean).join('\n');
        const artifact = safePersistArtifacts(input.artifactDir, check, index, `${runId}:${input.candidateDigest}:${input.inputDigest}:${input.contractVersion}:${base.observedAt}`, result.stdout, diagnostics);
        const artifactDiagnostics = [diagnostics, artifact.error].filter(Boolean).join('\n');
        const status = artifact.error ? 'ERROR' : result.timedOut ? 'INCONCLUSIVE'
          : result.outputLimitExceeded || result.error !== undefined || !Number.isInteger(result.exitCode) ? 'ERROR'
          : result.exitCode !== 0 ? 'FAIL'
          : result.stderr && !check.required ? 'INCONCLUSIVE' : 'PASS';
        results.push({ ...base, rawArtifactRefs: artifact.refs, status, stdout: result.stdout, stderr: artifactDiagnostics, exitCode: result.exitCode });
        continue;
      }
      const result = await run(check.command[0], check.command.slice(1), { cwd: input.workspace, timeout: check.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 });
      const artifact = safePersistArtifacts(input.artifactDir, check, index, `${runId}:${input.candidateDigest}:${input.inputDigest}:${input.contractVersion}:${base.observedAt}`, result.stdout, result.stderr);
      results.push({ ...base, rawArtifactRefs: artifact.refs, status: artifact.error ? 'ERROR' : result.stderr ? (check.required ? 'PASS' : 'INCONCLUSIVE') : 'PASS', stdout: result.stdout, stderr: [result.stderr, artifact.error].filter(Boolean).join('\n'), exitCode: 0 });
    } catch (error) {
      const e = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; signal?: string };
      const timedOut = e.killed === true || e.signal === 'SIGTERM';
      const stdout = e.stdout ?? '';
      const stderr = e.stderr ?? String(error);
      const artifact = safePersistArtifacts(input.artifactDir, check, index, `${runId}:${input.candidateDigest}:${input.inputDigest}:${input.contractVersion}:${base.observedAt}`, stdout, stderr);
      results.push({ ...base, rawArtifactRefs: artifact.refs, status: artifact.error ? 'ERROR' : input.executor ? 'ERROR' : timedOut ? 'INCONCLUSIVE' : (typeof e.code === 'number' ? 'FAIL' : 'ERROR'), stdout, stderr: [stderr, artifact.error].filter(Boolean).join('\n'), exitCode: typeof e.code === 'number' ? e.code : undefined });
    }
  }
  return results;
}

export class CheckRegistry {
  private readonly checks = new Map<string, CheckDefinition>();
  register(check: CheckDefinition): void { if (!check.id || !check.command.length) throw new Error('invalid check definition'); this.checks.set(check.id, check); }
  list(): CheckDefinition[] { return [...this.checks.values()]; }
  get(id: string): CheckDefinition { const check = this.checks.get(id); if (!check) throw new Error(`check not registered: ${id}`); return check; }
}
