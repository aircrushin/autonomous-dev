import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitRemotePushProvider } from '../../src/delivery/git-remote.js';

test('GitRemotePushProvider 在 bare remote 上通过 ref 回读实现幂等 push', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-remote-'));
  const remote = join(dir, 'remote.git');
  const source = join(dir, 'source');
  execFileSync('git', ['init', '--bare', '-q', remote]);
  execFileSync('git', ['init', '-q', source]);
  writeFileSync(join(source, 'a.txt'), 'a');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'init']);
  const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', source, 'remote', 'add', 'local', remote]);
  const provider = new GitRemotePushProvider({ repository: source, remote: 'local' });
  const secondProvider = new GitRemotePushProvider({ repository: source, remote: 'local' });
  assert.equal(await provider.findByIdempotency('key-1'), undefined);
  const [pushed, raced] = await Promise.all([
    provider.push({ idempotencyKey: 'key-1', revision }),
    secondProvider.push({ idempotencyKey: 'key-1', revision }),
  ]);
  assert.equal(pushed.revision, revision);
  assert.equal(raced.revision, revision);
  assert.deepEqual(await provider.findByIdempotency('key-1'), pushed);
  writeFileSync(join(source, 'b.txt'), 'b');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-qm', 'next']);
  const nextRevision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await assert.rejects(() => provider.push({ idempotencyKey: 'key-1', revision: nextRevision }), /different revision/);
  assert.deepEqual(await provider.findByIdempotency('key-1'), pushed);
  assert.throws(() => new GitRemotePushProvider({ repository: source, remote: '-bad' }), /must not start/);
  assert.throws(() => new GitRemotePushProvider({ repository: source, remote: 'local', branchPrefix: '../unsafe' }), /invalid branch/);
  assert.throws(() => new GitRemotePushProvider({ repository: source, remote: 'local', branchPrefix: 'foo.lock' }), /invalid branch/);
  rmSync(dir, { recursive: true, force: true });
});
