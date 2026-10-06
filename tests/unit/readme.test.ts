import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('README 提供最小启动、验证入口和外部边界说明', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const command of ['pnpm install --frozen-lockfile', 'pnpm ci:local', 'pnpm devctl']) assert.match(readme, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(readme, /Node\.js >= 22/);
  assert.match(readme, /implementation-status\.md/);
  assert.match(readme, /external-validation-runbook\.md/);
  assert.match(readme, /\.github\/workflows\/ci\.yml/);
  assert.match(readme, /不能替代 hosted CI/);
  assert.match(readme, /不要把凭据写入/);
});
