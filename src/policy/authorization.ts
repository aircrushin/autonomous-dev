export interface AuthorizationPolicy { allowedActions?: string[]; deniedActions?: string[]; version?: string; }

/**
 * Policy revisions are owned by the control plane.  Callers may supply a
 * human-readable version, but updates always advance the stored revision.
 */
export function nextPolicyVersion(previous: unknown): string {
  if (previous === undefined || previous === null || previous === '') return 'v1';
  const value = String(previous);
  const match = /^v(\d+)$/.exec(value);
  if (match) return `v${Number(match[1]) + 1}`;
  if (/^\d+$/.test(value)) return String(Number(value) + 1);
  return `${value}.1`;
}

export function assertAuthorized(policy: AuthorizationPolicy, action: string): void {
  if (policy.deniedActions?.includes(action)) throw new Error(`action denied: ${action}`);
  if (policy.allowedActions && !policy.allowedActions.includes(action)) throw new Error(`action not authorized: ${action}`);
}

export function assertExplicitlyAuthorized(policy: AuthorizationPolicy, action: string): void {
  if (policy.deniedActions?.includes(action)) throw new Error(`action denied: ${action}`);
  if (!policy.allowedActions?.includes(action)) throw new Error(`action not explicitly authorized: ${action}`);
}
