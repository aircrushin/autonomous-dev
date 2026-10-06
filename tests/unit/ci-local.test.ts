import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('ci:local reuses deterministic scripts in the required order', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.equal(packageJson.scripts['ci:local'], 'node scripts/ci-local.mjs');
  const script = readFileSync('scripts/ci-local.mjs', 'utf8');
  assert.deepEqual([...script.matchAll(/\['([^']+)'\]/g)].map(match => match[1]), ['typecheck', 'lint', 'scan:secrets', 'test', 'build']);
  assert.match(script, /spawnSync\('pnpm'/);
  assert.match(script, /result\.status !== 0/);
});
