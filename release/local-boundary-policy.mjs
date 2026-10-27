export const localBoundaryPolicy = 'thor-local-capability-v1';
export const requiredLocalBoundaryChecks = [
  'httpAuthenticatedHealth', 'httpAuthenticatedApi', 'httpMissingCapabilityRejected',
  'httpWrongCapabilityRejected', 'httpForeignHostRejected', 'httpForeignOriginRejected',
  'httpNullOriginRequiresCapability', 'httpDuplicateCapabilityRejected', 'httpDuplicateOriginRejected',
  'httpAuthenticatedPreflight', 'httpUnauthenticatedPreflightRejected', 'httpNoWildcardCors',
  'wsAuthenticatedPong', 'wsMissingCapabilityRejected', 'wsWrongCapabilityRejected',
  'wsForeignHostRejected', 'wsForeignOriginRejected', 'wsNullOriginRequiresCapability',
  'wsDuplicateCapabilityRejected', 'wsDuplicateOriginRejected',
];

export function validateCoreBoundaryProof(proof, coreSha256) {
  if (!proof || proof.schemaVersion !== 1 || proof.policy !== localBoundaryPolicy || proof.passed !== true || !/^[a-f0-9]{64}$/.test(coreSha256 || '') || proof.coreSha256 !== coreSha256) throw new Error('Release requires current local-boundary evidence bound to the exact Core binary.');
  if (!proof.checks || requiredLocalBoundaryChecks.some(name => proof.checks[name] !== true) || !Number.isSafeInteger(proof.httpDeniedRequests) || proof.httpDeniedRequests < 12 || !Number.isSafeInteger(proof.wsDeniedRequests) || proof.wsDeniedRequests < 8) throw new Error('Local-boundary evidence is incomplete for the required HTTP/WebSocket policy.');
  return proof;
}
