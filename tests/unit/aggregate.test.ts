import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePrometheusScrapes } from '../../src/observability/aggregate.js';

const escape = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
const scrape = (events: number, gauge: number, label = 'plain') => `# HELP demo_events_total Demo events.\n# TYPE demo_events_total counter\ndemo_events_total{z="last",a="${escape(label)}"} ${events}\n# HELP demo_lag Demo lag.\n# TYPE demo_lag gauge\ndemo_lag{a="${escape(label)}"} ${gauge}\n`;

test('aggregatePrometheusScrapes 合并多 source，counter sum、gauge 使用显式 max 且规范化标签', () => {
  const result = aggregatePrometheusScrapes([
    { sourceId: 'b', body: scrape(2, 10, 'x"\\\n') },
    { sourceId: 'a', body: scrape(3, 7, 'x"\\\n') }
  ], { gauge: 'max' });
  assert.equal(result, '# HELP demo_events_total Demo events.\n# TYPE demo_events_total counter\ndemo_events_total{a="x\\"\\\\\\n",z="last"} 5\n# HELP demo_lag Demo lag.\n# TYPE demo_lag gauge\ndemo_lag{a="x\\"\\\\\\n"} 10\n');
});

test('aggregatePrometheusScrapes 默认 gauge sum 且不添加 source label', () => {
  const result = aggregatePrometheusScrapes([{ sourceId: 'one', body: scrape(1, 4) }, { sourceId: 'two', body: scrape(2, 6) }]);
  assert.match(result, /demo_lag\{a="plain"\} 10/);
  assert.doesNotMatch(result, /sourceId|source=/);
});

test('aggregatePrometheusScrapes 拒绝空或重复 source、同源重复样本和元数据冲突', () => {
  assert.throws(() => aggregatePrometheusScrapes([{ sourceId: '', body: '' }]), /sourceId/);
  assert.throws(() => aggregatePrometheusScrapes([{ sourceId: 'x', body: '' }, { sourceId: 'x', body: '' }]), /duplicate sourceId/);
  assert.throws(() => aggregatePrometheusScrapes([{ sourceId: 'x', body: `${scrape(1, 1)}demo_events_total{z="last",a="plain"} 2\n` }]), /duplicate sample/);
  assert.throws(() => aggregatePrometheusScrapes([{ sourceId: 'x', body: '# HELP m One\n# TYPE m counter\n' }, { sourceId: 'y', body: '# HELP m Two\n# TYPE m counter\n' }]), /HELP conflict/);
  assert.throws(() => aggregatePrometheusScrapes([{ sourceId: 'x', body: '# HELP m One\n# TYPE m counter\nm 1\n' }, { sourceId: 'y', body: '# HELP m One\n# TYPE m gauge\nm 1\n' }]), /TYPE conflict/);
});

test('aggregatePrometheusScrapes 拒绝非法 Prometheus 行和标签', () => {
  assert.throws(() => aggregatePrometheusScrapes([{ sourceId: 'x', body: '# HELP m M\n# TYPE m gauge\nm nope\n' }]), /value/);
  assert.throws(() => aggregatePrometheusScrapes([{ sourceId: 'x', body: '# HELP m M\n# TYPE m gauge\nm{bad-label="x"} 1\n' }]), /label/);
  assert.throws(() => aggregatePrometheusScrapes([{ sourceId: 'x', body: '# HELP m M\nm 1\n' }]), /metadata/);
  assert.throws(() => aggregatePrometheusScrapes([{ sourceId: 'x', body: '# HELP m M\n# TYPE m gauge\nm{a="x",} 1\n' }]), /separator/);
});

test('aggregatePrometheusScrapes 拒绝 counter 溢出并按 code point 排序标签组', () => {
  const huge = '1e308';
  assert.throws(() => aggregatePrometheusScrapes([
    { sourceId: 'a', body: `# HELP m M\n# TYPE m counter\nm ${huge}\n` },
    { sourceId: 'b', body: `# HELP m M\n# TYPE m counter\nm ${huge}\n` }
  ]), /non-finite aggregate/);
  const output = aggregatePrometheusScrapes([
    { sourceId: 'a', body: '# HELP m M\n# TYPE m gauge\nm{a="1"} 1\n' },
    { sourceId: 'b', body: '# HELP m M\n# TYPE m gauge\nm{Z="1"} 1\n' }
  ]);
  assert.ok(output.indexOf('m{Z="1"}') < output.indexOf('m{a="1"}'));
});
