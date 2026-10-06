import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('quality gate ledger lists every phase and states evidence boundaries', () => {
  const ledger = readFileSync('docs/quality-gate-ledger.md', 'utf8');
  for (let phase = 0; phase <= 8; phase += 1) assert.match(ledger, new RegExp(`Phase ${phase}`));
  assert.match(ledger, /Independent QC/);
  assert.match(ledger, /181\/181/);
  assert.match(ledger, /external boundary|未覆盖边界|真实远端/);
  assert.match(ledger, /ADR0069/);
  assert.match(ledger, /pnpm ci:local/);
});
