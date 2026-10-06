import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('external validation runbook covers staged evidence and stop boundaries without credentials', () => {
  const doc = readFileSync('docs/external-validation-runbook.md', 'utf8');
  for (const heading of ['GitHub Actions hosted run', 'PR、CI 与 merge 对账', 'SSH 远程主机', 'Docker/Podman daemon 与镜像供应链', 'VM 与跨机 Agent', 'Metrics 认证、TLS 与生产只读验收']) assert.match(doc, new RegExp(heading));
  assert.match(doc, /只读 preflight/);
  assert.match(doc, /成功证据/);
  assert.match(doc, /失败\/停止/);
  assert.match(doc, /pnpm ci:local|workflow/);
  for (const command of ['gh workflow view', 'gh run list', 'gh pr view', 'gh api', 'ssh --', 'pwd && git --version', 'docker version', 'docker image inspect', 'podman version', 'podman image inspect', 'curl --fail-with-body']) assert.match(doc, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(doc, /<OWNER>\/\<REPO>|<SSH_TARGET>|<IMAGE_REF>|<READ_ONLY_ENDPOINT>/);
  assert.doesNotMatch(doc, /gh\s+(pr\s+(create|merge)|workflow\s+run)|git\s+push|npm\s+publish|Bearer\s+[A-Za-z0-9]/i);
  assert.match(doc, /不得把私钥|凭据只存在/);
});
