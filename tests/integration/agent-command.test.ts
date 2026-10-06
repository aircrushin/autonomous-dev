import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import type { Command, CommandExecutor, ExecResult } from '../../src/environments/types.js';
import { CommandAgentAdapter } from '../../src/agents/command.js';

class FakeExecutor implements CommandExecutor {
  readonly commands: Command[] = [];
  constructor(private readonly result: ExecResult) {}
  async exec(command: Command): Promise<ExecResult> { this.commands.push(command); return { ...this.result, argv: command.argv }; }
}

test('CommandAgentAdapter passes agent argv through the injected environment and logs bounded result', async () => {
  const fake = new FakeExecutor({ argv: [], exitCode: 0, stdout: 'changed', stderr: '', timedOut: false });
  const logPath = `/tmp/murex-agent-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`;
  const adapter = new CommandAgentAdapter(fake, logPath);
  const result = await adapter.run({ goal: 'goal', workItem: 'item', workspace: '/remote/ws', budget: {}, completionCriteria: ['check'], command: ['agent', '--once'], timeoutMs: 7, maxOutputBytes: 9, env: { TOKEN: 'secret' } });
  assert.equal(result.result, 'SUCCEEDED');
  assert.deepEqual(fake.commands[0], { argv: ['agent', '--once'], cwd: '/remote/ws', timeoutMs: 7, maxOutputBytes: 9, env: { TOKEN: 'secret' } });
  const log = await readFile(logPath, 'utf8');
  assert.match(log, /"status":"SUCCEEDED"/);
  assert.doesNotMatch(log, /--once/);
  assert.doesNotMatch(log, /"stdout"/);
  await rm(logPath, { force: true });
});

test('CommandAgentAdapter maps bounded executor failures and does not run a local fallback', async () => {
  const fake = new FakeExecutor({ argv: [], exitCode: 137, stdout: 'partial', stderr: 'killed', timedOut: true, outputLimitExceeded: true });
  const logPath = `/tmp/murex-agent-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`;
  const adapter = new CommandAgentAdapter(fake, logPath);
  const result = await adapter.run({ goal: 'goal', workItem: 'item', workspace: '/remote/ws', budget: {}, completionCriteria: [], command: ['remote-agent'] });
  assert.equal(result.result, 'FAILED');
  assert.match(result.summary, /killed/);
  assert.match(result.summary, /timed out/);
  await rm(logPath, { force: true });
});

test('CommandAgentAdapter enforces per-work-item run budget and missing command', async () => {
  const fake = new FakeExecutor({ argv: [], exitCode: 0, stdout: '', stderr: '', timedOut: false });
  const logPath = `/tmp/murex-agent-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`;
  const adapter = new CommandAgentAdapter(fake, logPath);
  const input = { goal: 'goal', workItem: 'item', workspace: '/ws', budget: { maxRuns: 1 }, completionCriteria: [], command: ['agent'] };
  assert.equal((await adapter.run(input)).result, 'SUCCEEDED');
  assert.equal((await adapter.run(input)).summary, 'budget exhausted');
  assert.equal((await adapter.run({ ...input, workItem: 'missing', command: undefined })).summary, 'missing agent command');
  assert.equal(fake.commands.length, 1);
  await rm(logPath, { force: true });
});

test('CommandAgentAdapter fences an in-flight cancel request into CANCELLED', async () => {
  let release!: (result: ExecResult) => void;
  const fake: CommandExecutor = { exec: async command => await new Promise<ExecResult>(resolve => { release = resolve; }) };
  const logPath = `/tmp/murex-agent-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`;
  const adapter = new CommandAgentAdapter(fake, logPath);
  const running = adapter.run({ runId: 'cancel-run', goal: 'goal', workItem: 'cancel', workspace: '/ws', budget: {}, completionCriteria: [], command: ['agent'] });
  await new Promise(resolve => setImmediate(resolve));
  await adapter.cancel('cancel-run');
  release({ argv: ['agent'], exitCode: 0, stdout: 'done', stderr: '', timedOut: false });
  const result = await running;
  assert.equal(result.result, 'CANCELLED');
  await rm(logPath, { force: true });
});

test('CommandAgentAdapter records executor throws as failure and resume refuses implicit replay', async () => {
  const logPath = `/tmp/murex-agent-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`;
  const adapter = new CommandAgentAdapter({ exec: async () => { throw new Error('transport down'); } }, logPath);
  const result = await adapter.run({ goal: 'goal', workItem: 'throw', workspace: '/ws', budget: {}, completionCriteria: [], command: ['agent'] });
  assert.equal(result.result, 'FAILED');
  assert.match(result.summary, /transport down/);
  const resumed = await adapter.resume('r', { completed: [], verification: [], failures: [], ruledOut: [], remaining: [], nextStep: 'provide command' });
  assert.equal(resumed.result, 'FAILED');
  assert.match(resumed.summary, /provide command/);
  await rm(logPath, { force: true });
});
