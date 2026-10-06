import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('GitHub Actions CI workflow is read-only and runs deterministic gates in order', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /push:/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /node-version:\s*22/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  const commands = [...workflow.matchAll(/- run: (pnpm [^\n]+)/g)].map(match => match[1]);
  assert.deepEqual(commands, ['pnpm install --frozen-lockfile', 'pnpm ci:local']);
  assert.doesNotMatch(workflow, /secrets\.|npm publish|pnpm publish|git push|deploy/i);
  assert.doesNotMatch(workflow, /contents:\s*write/);
});

test('pnpm workspace declares a package for hosted pnpm cache discovery', () => {
  const workspace = readFileSync('pnpm-workspace.yaml', 'utf8');
  assert.match(workspace, /packages:\s*\n\s*- ['"]?\.['"]?/);
  assert.match(workspace, /allowBuilds:\s*\n\s+esbuild:\s*true/);
});
