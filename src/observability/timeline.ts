export interface TimelineEvent { sequence: number; entityType: string; entityId: string; eventType: string; payload: unknown; occurredAt: string; }
export interface TimelineSummary { events: TimelineEvent[]; counts: Record<string, number>; failureCount: number; humanRequestCount: number; lastEventAt?: string; }
export function summarizeTimeline(rows: Array<Record<string, unknown>>): TimelineSummary {
  const events = rows.slice().sort((a, b) => Number(a.sequence) - Number(b.sequence)).map(row => ({ sequence: row.sequence as number, entityType: row.entity_type as string, entityId: row.entity_id as string, eventType: row.event_type as string, payload: JSON.parse((row.payload_json as string | undefined) ?? '{}'), occurredAt: row.occurred_at as string }));
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
  const failureCount = events.filter(event => {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : undefined;
    return /FAIL|ERROR|FAILED/.test(event.eventType) || ['FAIL', 'ERROR'].includes(String(payload?.status)) || ['FAILED', 'CLOSED_UNACHIEVABLE'].includes(String(payload?.to));
  }).length;
  const humanRequestCount = new Set(events.filter(event => event.eventType === 'HUMAN_REQUEST_CREATED').map(event => event.entityId)).size;
  return { events, counts, failureCount, humanRequestCount, lastEventAt: events.at(-1)?.occurredAt };
}
