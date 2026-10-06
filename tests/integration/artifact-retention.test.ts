import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneVerificationArtifacts } from '../../src/verification/artifacts.js';

const name = (index: number, digest: string, kind: 'stdout' | 'stderr' = 'stdout') => `${String(index).padStart(3, '0')}-${digest.padEnd(24, '0').slice(0, 24)}-${kind}.log`;
const createRoot = () => mkdtemp(join(tmpdir(), 'murex-artifact-retention-'));

test('artifact retention 保留新 verifier 产物并忽略非产物', async () => {
  const root = await createRoot();
  const now = 1_700_000_000_000;
  const fresh = join(root, name(1, 'a'.repeat(24)));
  const unrelated = join(root, 'notes.log');
  await writeFile(fresh, 'fresh');
  await writeFile(unrelated, 'keep');
  await utimes(fresh, new Date(now - 100), new Date(now - 100));
  const result = await pruneVerificationArtifacts(root, { maxAgeMs: 1_000, nowMs: now });
  assert.deepEqual({ deleted: result.deleted, retained: result.retained, bytes: result.bytes }, { deleted: 0, retained: 1, bytes: 5 });
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
});

test('artifact retention 删除过期产物但不跟随符号链接', async () => {
  const root = await createRoot();
  const now = 1_700_000_000_000;
  const old = join(root, name(2, 'b'.repeat(24), 'stderr'));
  const target = join(root, 'outside.log');
  const link = join(root, name(3, 'c'.repeat(24)));
  await writeFile(old, 'old');
  await writeFile(target, 'outside');
  await symlink(target, link);
  await utimes(old, new Date(now - 10_000), new Date(now - 10_000));
  const result = await pruneVerificationArtifacts(root, { maxAgeMs: 1_000, nowMs: now });
  assert.equal(result.deleted, 1);
  await assert.rejects(() => lstat(old), { code: 'ENOENT' });
  assert.equal(await readFile(target, 'utf8'), 'outside');
  assert.equal((await lstat(link)).isSymbolicLink(), true);
});

test('artifact retention 按最旧顺序执行字节上限', async () => {
  const root = await createRoot();
  const now = 1_700_000_000_000;
  const oldest = join(root, name(1, 'd'.repeat(24)));
  const newer = join(root, name(2, 'e'.repeat(24)));
  await writeFile(oldest, '12345');
  await writeFile(newer, '67890');
  await utimes(oldest, new Date(now - 200), new Date(now - 200));
  await utimes(newer, new Date(now - 100), new Date(now - 100));
  const result = await pruneVerificationArtifacts(root, { maxAgeMs: 1_000, maxBytes: 5, nowMs: now });
  assert.equal(result.deleted, 1);
  assert.equal(result.retained, 1);
  assert.equal(result.bytes, 5);
  assert.deepEqual(result.deletedPaths, [oldest]);
});

test('artifact retention 不存在的目录按空目录处理并校验限制', async () => {
  const root = join(tmpdir(), `murex-missing-${Date.now()}-${Math.random()}`);
  assert.deepEqual(await pruneVerificationArtifacts(root, { maxAgeMs: 10 }), { deleted: 0, retained: 0, bytes: 0, deletedBytes: 0, retainedBytes: 0, deletedPaths: [], retainedPaths: [] });
  await assert.rejects(() => pruneVerificationArtifacts(root, { maxAgeMs: -1 }), /maxAgeMs/);
  await assert.rejects(() => pruneVerificationArtifacts(root, { maxAgeMs: 1, maxBytes: -1 }), /maxBytes/);
});

test('artifact retention 忽略少于三位索引并支持千项以上索引', async () => {
  const root = await createRoot();
  const now = 1_700_000_000_000;
  const short = join(root, `12-${'f'.repeat(24)}-stdout.log`);
  const large = join(root, `1000-${'e'.repeat(24)}-stdout.log`);
  await writeFile(short, 'short');
  await writeFile(large, 'large');
  await utimes(short, new Date(now - 10_000), new Date(now - 10_000));
  await utimes(large, new Date(now - 10_000), new Date(now - 10_000));
  const result = await pruneVerificationArtifacts(root, { maxAgeMs: 1_000, nowMs: now });
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.deletedPaths, [large]);
  assert.equal(await readFile(short, 'utf8'), 'short');
});
