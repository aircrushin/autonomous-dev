import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// verifyChecks uses a three-digit minimum index; allow larger batches too.
const VERIFIER_ARTIFACT = /^\d{3,}-[0-9a-f]{24}-(?:stdout|stderr)\.log$/;

export interface PruneVerificationArtifactsOptions {
  maxAgeMs: number;
  maxBytes?: number;
  nowMs?: number;
}

export interface PruneVerificationArtifactsResult {
  deleted: number;
  retained: number;
  bytes: number;
  deletedBytes: number;
  retainedBytes: number;
  deletedPaths: string[];
  retainedPaths: string[];
}

interface Candidate { path: string; mtimeMs: number; size: number; }

/** 只清理 verifier 固定命名的普通文件，不递归也不跟随符号链接。 */
export async function pruneVerificationArtifacts(directory: string, options: PruneVerificationArtifactsOptions): Promise<PruneVerificationArtifactsResult> {
  if (!directory || typeof directory !== 'string') throw new Error('directory is required');
  if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) throw new Error('maxAgeMs must be a non-negative number');
  if (options.maxBytes !== undefined && (!Number.isInteger(options.maxBytes) || options.maxBytes < 0)) throw new Error('maxBytes must be a non-negative integer');
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) throw new Error('nowMs must be finite');
  const root = resolve(directory);
  let rootStat;
  try { rootStat = await lstat(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyResult();
    throw error;
  }
  if (!rootStat.isDirectory()) throw new Error('artifact directory must be a real directory');

  const candidates: Candidate[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!VERIFIER_ARTIFACT.test(entry.name)) continue;
    const path = join(root, entry.name);
    let stat;
    try { stat = await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile()) continue;
    candidates.push({ path, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));

  const remove = new Set<string>();
  for (const candidate of candidates) if (nowMs - candidate.mtimeMs > options.maxAgeMs) remove.add(candidate.path);
  if (options.maxBytes !== undefined) {
    let retainedBytes = candidates.filter(candidate => !remove.has(candidate.path)).reduce((sum, candidate) => sum + candidate.size, 0);
    for (const candidate of candidates) {
      if (retainedBytes <= options.maxBytes) break;
      if (remove.has(candidate.path)) continue;
      remove.add(candidate.path);
      retainedBytes -= candidate.size;
    }
  }

  const deletedPaths: string[] = [];
  const retainedPaths: string[] = [];
  let deletedBytes = 0;
  let retainedBytes = 0;
  for (const candidate of candidates) {
    if (remove.has(candidate.path)) {
      try { await unlink(candidate.path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      deletedPaths.push(candidate.path);
      deletedBytes += candidate.size;
    } else {
      retainedPaths.push(candidate.path);
      retainedBytes += candidate.size;
    }
  }
  return { deleted: deletedPaths.length, retained: retainedPaths.length, bytes: retainedBytes, deletedBytes, retainedBytes, deletedPaths, retainedPaths };
}

function emptyResult(): PruneVerificationArtifactsResult {
  return { deleted: 0, retained: 0, bytes: 0, deletedBytes: 0, retainedBytes: 0, deletedPaths: [], retainedPaths: [] };
}
