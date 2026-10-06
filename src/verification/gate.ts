import type { VerificationResult } from './types.js';

export type GateResult = 'ALLOW' | 'REPAIR' | 'COLLECT' | 'ESCALATE';
export interface GateDecision { candidateDigest: string; result: GateResult; reasonCodes: string[]; evidenceRefs: string[]; }

export function decideGate(results: VerificationResult[]): GateDecision {
  const candidateDigest = results[0]?.candidateDigest ?? '';
  const reasonCodes: string[] = [];
  if (!results.length) return { candidateDigest, result: 'COLLECT', reasonCodes: ['NO_EVIDENCE'], evidenceRefs: [] };
  for (const result of results) {
    if (result.status === 'FAIL') reasonCodes.push(`${result.requirementId}:FAIL`);
    if (result.status === 'INCONCLUSIVE') reasonCodes.push(`${result.requirementId}:INCONCLUSIVE`);
    if (result.status === 'ERROR') reasonCodes.push(`${result.requirementId}:ERROR`);
  }
  const result: GateResult = results.some(r => r.status === 'ERROR') ? 'ESCALATE' : results.some(r => r.status === 'INCONCLUSIVE') ? 'COLLECT' : results.some(r => r.status === 'FAIL') ? 'REPAIR' : 'ALLOW';
  return { candidateDigest, result, reasonCodes, evidenceRefs: results.map(r => `${r.requirementId}:${r.checkDefinitionDigest}`) };
}
