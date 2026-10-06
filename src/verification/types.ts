export type VerificationStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'ERROR';
export interface CheckDefinition { id: string; command: string[]; timeoutMs?: number; required: boolean; }
export interface VerificationResult { requirementId: string; contractVersion: string; candidateDigest: string; checkDefinitionDigest: string; environmentFingerprint: string; inputDigest: string; status: VerificationStatus; stdout: string; stderr: string; rawArtifactRefs: string[]; exitCode?: number; observedAt: string; }
