import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { Store } from '../storage/database.js';
import { buildGoalDashboard } from './dashboard.js';
import { exportDashboardJson, exportDashboardPrometheus, exportTimelineJson, exportTimelinePrometheus } from './export.js';
import { summarizeTimeline } from './timeline.js';

export interface ObservabilityHandlerOptions {
  /** Caller-owned authentication/authorization decision; false short-circuits all storage reads. */
  authorize?: (request: IncomingMessage) => boolean;
}

function dashboardFor(store: Store, goalId: string) {
  const snapshot = store.getGoalSnapshot(goalId);
  if (!snapshot) return undefined;
  return buildGoalDashboard({
    goal: snapshot.goal,
    timeline: summarizeTimeline(snapshot.events),
    workItems: snapshot.workItems,
    recoverableAttempts: snapshot.attempts.filter(attempt => attempt.endedAt === undefined),
    attempts: snapshot.attempts,
    operations: snapshot.operations,
    humanRequests: snapshot.humanRequests,
    evidence: snapshot.evidence,
    reservedBudget: snapshot.reservedBudget
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * Build a read-only observability handler. The caller owns the HTTP server and
 * decides whether it is exposed locally or behind authentication.
 */
export function createObservabilityHandler(store: Store, options: ObservabilityHandlerOptions = {}) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    let authorized = true;
    try {
      authorized = options.authorize ? options.authorize(req) : true;
    } catch {
      authorized = false;
    }
    if (!authorized) {
      send(res, 401, 'text/plain; charset=utf-8', 'unauthorized\n');
      return;
    }
    if (req.method !== 'GET') {
      send(res, 405, 'text/plain; charset=utf-8', 'method not allowed\n');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/metrics') {
      const goalId = url.searchParams.get('goal_id');
      if (goalId !== null && !store.getGoal(goalId)) {
        send(res, 404, 'text/plain; charset=utf-8', 'goal not found\n');
        return;
      }
      const rows = goalId === null ? store.listEvents() : store.listGoalEvents(goalId);
      send(res, 200, 'text/plain; version=0.0.4; charset=utf-8', exportTimelinePrometheus(summarizeTimeline(rows), goalId === null ? {} : { goal_id: goalId }));
      return;
    }
    const dashboardMatch = /^\/dashboard\/([^/]+)$/.exec(url.pathname);
    if (dashboardMatch) {
      let goalId: string;
      try {
        goalId = decodeURIComponent(dashboardMatch[1]);
      } catch {
        send(res, 400, 'text/plain; charset=utf-8', 'malformed goal id\n');
        return;
      }
      const dashboard = dashboardFor(store, goalId);
      if (!dashboard) {
        send(res, 404, 'text/plain; charset=utf-8', 'goal not found\n');
        return;
      }
      const format = url.searchParams.get('format') ?? 'json';
      if (format === 'prometheus') {
        send(res, 200, 'text/plain; version=0.0.4; charset=utf-8', exportDashboardPrometheus(dashboard));
      } else if (format === 'json') {
        send(res, 200, 'application/json; charset=utf-8', exportDashboardJson(dashboard));
      } else {
        send(res, 400, 'text/plain; charset=utf-8', 'unsupported format\n');
      }
      return;
    }
    if (url.pathname === '/timeline') {
      send(res, 200, 'application/json; charset=utf-8', exportTimelineJson(summarizeTimeline(store.listEvents())));
      return;
    }
    send(res, 404, 'text/plain; charset=utf-8', 'not found\n');
  };
}
