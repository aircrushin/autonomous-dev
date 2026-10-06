import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('构建后的 verifier 在独立 dist 副本中运行 mandatory quality checks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-build-runtime-'));
  const candidate = join(root, 'candidate');
  const isolatedDist = join(root, 'dist');
  try {
    await mkdir(candidate, { recursive: true });
    await writeFile(join(candidate, 'safe.ts'), 'export const value = 1;\n');
    await cp(resolve('dist'), isolatedDist, { recursive: true });
    const runner = await import(`${isolatedDist}/src/verification/runner.js?runtime=${Date.now()}`);
    const checks = runner.mandatoryQualityChecks(candidate);
    const pass = await runner.verifyChecks({ workspace: candidate, contractVersion: 'v1', candidateDigest: 'candidate', environmentFingerprint: 'isolated', inputDigest: 'input', checks, qualityProfile: 'mandatory' });
    assert.deepEqual(pass.map((result: { status: string }) => result.status), ['PASS', 'PASS']);
    await writeFile(join(candidate, '.env'), 'TOKEN="credential-value"\n');
    const fail = await runner.verifyChecks({ workspace: candidate, contractVersion: 'v1', candidateDigest: 'candidate', environmentFingerprint: 'isolated', inputDigest: 'input', checks: runner.mandatoryQualityChecks(candidate), qualityProfile: 'mandatory' });
    assert.deepEqual(fail.map((result: { status: string }) => result.status), ['PASS', 'FAIL']);
    assert.match(fail[1]!.stderr, /dangerous file name|credential-like assignment/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
