#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const commands = [
  ['typecheck'],
  ['lint'],
  ['scan:secrets'],
  ['build'],
  ['test'],
];
for (const args of commands) {
  const result = spawnSync('pnpm', args, { stdio: 'inherit', shell: false });
  if (result.error) { console.error(result.error.message); process.exitCode = 1; break; }
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
