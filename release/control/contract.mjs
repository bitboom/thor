import { validateCoreBoundaryProof } from '../local-boundary-policy.mjs';
import { nativeDesktopElectron, validateNativeDesktopProof } from '../native-policy.mjs';

export const repository = 'bitboom/thor';
export const windowsWorkflow = '.github/workflows/windows-release.yml';
export const artifactName = 'thor-windows-x64';

export function versionParts(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Release version must be a stable numeric semantic version.');
  const parts = version.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('Release version exceeds safe numeric bounds.');
  return parts;
}

export function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['runId', 'schemaVersion', 'sourceSha', 'version'])) throw new Error('Release request has unexpected or missing fields.');
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(value.sourceSha) || !Number.isSafeInteger(value.runId) || value.runId < 1) throw new Error('Invalid release request source or workflow run.');
  versionParts(value.version);
  return value;
}

export function validateRun(run, request) {
  if (run.id !== request.runId || run.head_sha !== request.sourceSha || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Requested Windows run has not successfully tested this exact source revision.');
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository || !['push', 'workflow_dispatch'].includes(run.event) || run.head_branch !== 'main' || run.path?.split('@')[0] !== windowsWorkflow || run.name !== 'Thor Windows') throw new Error('Release artifacts must come from the Thor Windows workflow on this repository main branch.');
  return run;
}

export function selectArtifact(value, request) {
  if (!Array.isArray(value?.artifacts)) throw new Error('Invalid Actions artifact response.');
  const matches = value.artifacts.filter(artifact => artifact.name === artifactName);
  if (matches.length !== 1 || matches[0].expired !== false || !Number.isSafeInteger(matches[0].id) || matches[0].id < 1 || !Number.isSafeInteger(matches[0].size_in_bytes) || matches[0].size_in_bytes < 1) throw new Error('Exactly one unexpired Windows release artifact is required.');
  const artifact = matches[0];
  if (artifact.workflow_run && (artifact.workflow_run.id !== request.runId || artifact.workflow_run.head_sha !== request.sourceSha)) throw new Error('Artifact does not belong to the requested source run.');
  return artifact;
}

export function validateProvenance(value, request) {
  if (value.version !== request.version || value.repository !== repository || value.source?.commit !== request.sourceSha || value.source?.dirty !== false || value.runUrl !== `https://github.com/${repository}/actions/runs/${request.runId}`) throw new Error('Downloaded provenance does not match the reviewed release request.');
  // This is the current controller's policy, evaluated before any code from
  // the requested historical source is executed. Old successful builds do
  // not become eligible merely because their own verifier accepts them.
  validateCoreBoundaryProof(value.bundle?.core?.localBoundary, value.bundle?.core?.sha256);
  validateNativeDesktopProof(value.desktopNative, nativeDesktopElectron);
}

export function requireNewVersion(version, latestTag) {
  const wanted = versionParts(version);
  if (latestTag === null) return;
  if (typeof latestTag !== 'string' || !latestTag.startsWith('v')) throw new Error('Latest public release has an unrecognized version.');
  const current = versionParts(latestTag.slice(1));
  for (let index = 0; index < wanted.length; index++) {
    if (wanted[index] > current[index]) return;
    if (wanted[index] < current[index]) throw new Error('Requested release must be newer than the current public release.');
  }
  throw new Error('Requested release must be newer than the current public release.');
}

