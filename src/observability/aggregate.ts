export interface PrometheusScrape { sourceId: string; body: string; }
export interface PrometheusAggregateOptions { gauge?: 'sum' | 'max'; }

interface Sample { name: string; labels: Record<string, string>; value: number; type: 'counter' | 'gauge'; help: string; }
type Metadata = { help?: string; type?: 'counter' | 'gauge' };

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** 合并多个本地 Prometheus scrape；不执行网络读取，也不引入 source label。 */
export function aggregatePrometheusScrapes(scrapes: PrometheusScrape[], options: PrometheusAggregateOptions = {}): string {
  const gauge = options.gauge ?? 'sum';
  if (gauge !== 'sum' && gauge !== 'max') throw new Error('gauge must be sum or max');
  const seenSources = new Set<string>();
  const metadata = new Map<string, Metadata>();
  const aggregates = new Map<string, { sample: Sample; sources: Set<string> }>();
  for (const scrape of scrapes) {
    if (!scrape || typeof scrape.sourceId !== 'string' || !scrape.sourceId.trim()) throw new Error('sourceId must be non-empty');
    const sourceId = scrape.sourceId.trim();
    if (seenSources.has(sourceId)) throw new Error(`duplicate sourceId: ${sourceId}`);
    seenSources.add(sourceId);
    if (typeof scrape.body !== 'string') throw new Error(`scrape body must be text: ${sourceId}`);
    parseScrape(scrape.body, sourceId, metadata, aggregates);
  }
  const lines: string[] = [];
  for (const name of [...metadata.keys()].sort()) {
    const meta = metadata.get(name)!;
    if (!meta.help || !meta.type) throw new Error(`incomplete metadata for ${name}`);
    lines.push(`# HELP ${name} ${meta.help}`, `# TYPE ${name} ${meta.type}`);
    const samples = [...aggregates.values()].filter(entry => entry.sample.name === name).sort((a, b) => codePointCompare(labelKey(a.sample.labels), labelKey(b.sample.labels)));
    for (const entry of samples) {
      const value = entry.sample.value;
      const rendered = renderSample(entry.sample.name, entry.sample.labels, value);
      lines.push(rendered);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';

  function parseScrape(body: string, sourceId: string, metas: Map<string, Metadata>, values: Map<string, { sample: Sample; sources: Set<string> }>): void {
    for (const [index, line] of body.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      if (line.startsWith('#')) {
        const help = line.match(/^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*) (.+)$/);
        if (help) {
          const [name, text] = [help[1]!, help[2]!];
          const existing = metas.get(name);
          if (existing?.help !== undefined && existing.help !== text) throw new Error(`HELP conflict for ${name}`);
          if (existing) existing.help = text;
          else metas.set(name, { help: text });
          continue;
        }
        const type = line.match(/^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (counter|gauge)$/);
        if (type) {
          const name = type[1]!;
          const existing = metas.get(name);
          if (existing?.type !== undefined && existing.type !== type[2]) throw new Error(`TYPE conflict for ${name}`);
          if (existing) existing.type = type[2] as 'counter' | 'gauge';
          else metas.set(name, { type: type[2] as 'counter' | 'gauge' });
          continue;
        }
        throw new Error(`invalid Prometheus comment at ${sourceId}:${index + 1}`);
      }
      const parsed = parseSample(line, sourceId, index + 1);
      const meta = metas.get(parsed.name);
      if (!meta?.help || !meta.type) throw new Error(`sample has no complete metadata for ${parsed.name}`);
      parsed.type = meta.type;
      parsed.help = meta.help;
      const key = `${parsed.name}\0${labelKey(parsed.labels)}`;
      const aggregate = values.get(key);
      if (!aggregate) { values.set(key, { sample: parsed, sources: new Set([sourceId]) }); continue; }
      if (aggregate.sources.has(sourceId)) throw new Error(`duplicate sample from source ${sourceId}: ${parsed.name}`);
      aggregate.sources.add(sourceId);
      const combined = parsed.type === 'counter' || gauge === 'sum' ? aggregate.sample.value + parsed.value : Math.max(aggregate.sample.value, parsed.value);
      if (!Number.isFinite(combined)) throw new Error(`non-finite aggregate for ${parsed.name}`);
      aggregate.sample.value = combined;
    }
  }
}

function parseSample(line: string, sourceId: string, lineNumber: number): Sample {
  const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([^\s]+)$/);
  if (!match || !NAME.test(match[1]!)) throw new Error(`invalid Prometheus sample at ${sourceId}:${lineNumber}`);
  const valueText = match[3]!;
  if (!NUMBER.test(valueText)) throw new Error(`invalid Prometheus value at ${sourceId}:${lineNumber}`);
  const value = Number(valueText);
  if (!Number.isFinite(value)) throw new Error(`non-finite Prometheus value at ${sourceId}:${lineNumber}`);
  return { name: match[1]!, labels: parseLabels(match[2] ?? '', sourceId, lineNumber), value, type: 'gauge', help: '' };
}

function parseLabels(input: string, sourceId: string, lineNumber: number): Record<string, string> {
  if (!input) return {};
  const labels: Record<string, string> = {};
  let index = 0;
  while (index < input.length) {
    while (input[index] === ' ' || input[index] === ',') index++;
    const keyStart = index;
    while (index < input.length && input[index] !== '=') index++;
    const key = input.slice(keyStart, index).trim();
    if (!LABEL.test(key) || labels[key] !== undefined) throw new Error(`invalid or duplicate label at ${sourceId}:${lineNumber}`);
    if (input[index++] !== '=' || input[index++] !== '"') throw new Error(`invalid label value at ${sourceId}:${lineNumber}`);
    let value = '';
    let closed = false;
    while (index < input.length) {
      const char = input[index++];
      if (char === '"') { closed = true; break; }
      if (char !== '\\') { value += char; continue; }
      const escaped = input[index++];
      if (escaped === 'n') value += '\n';
      else if (escaped === '"' || escaped === '\\') value += escaped;
      else throw new Error(`invalid label escape at ${sourceId}:${lineNumber}`);
    }
    if (!closed) throw new Error(`unterminated label at ${sourceId}:${lineNumber}`);
    labels[key] = value;
    while (input[index] === ' ') index++;
    if (index < input.length) {
      if (input[index++] !== ',' || index >= input.length) throw new Error(`invalid label separator at ${sourceId}:${lineNumber}`);
    }
  }
  return labels;
}

function codePointCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function labelKey(labels: Record<string, string>): string { return Object.keys(labels).sort(codePointCompare).map(key => `${key}=${JSON.stringify(labels[key])}`).join(','); }
function escapeLabel(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"'); }
function renderSample(name: string, labels: Record<string, string>, value: number): string {
  const suffix = Object.keys(labels).sort(codePointCompare).map(key => `${key}="${escapeLabel(labels[key]!) }"`).join(',');
  return `${name}${suffix ? `{${suffix}}` : ''} ${Object.is(value, -0) ? '0' : String(value)}`;
}
