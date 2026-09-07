/**
 * Docker development orchestration vocabulary.
 *
 * Everything Meridian creates carries the meridian.session label and a
 * session-scoped name, so parallel test runs cannot collide and cleanup can
 * always find its own resources — and only its own.
 */

export type ProjectKind = 'compose' | 'dockerfile' | 'none';

export interface DockerProjectInfo {
  path: string;
  kind: ProjectKind;
  composeFile: string | null;
  dockerfile: string | null;
  /** Service names from compose, or the single derived name for a Dockerfile. */
  services: string[];
}

export interface DockerAvailability {
  available: boolean;
  version: string | null;
  compose: boolean;
  detail: string | null;
}

export interface DockerOpResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  command: string;
}

export type FailureClass =
  | 'DOCKER_UNAVAILABLE'
  | 'BUILD_FAILURE'
  | 'STARTUP_FAILURE'
  | 'HEALTHCHECK_TIMEOUT'
  | 'NETWORK_FAILURE'
  | 'TEST_FAILURE'
  | 'VERIFY_FAILURE'
  | 'TIMEOUT'
  | 'UNKNOWN';

export interface ClassifiedFailure {
  class: FailureClass;
  stage: 'detect' | 'build' | 'up' | 'health' | 'exec' | 'test' | 'verify' | 'down';
  detail: string;
  /** Whether spending a retry on this class ever helps. */
  retryable: boolean;
}

export interface ContainerStatus {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

export interface VerifyStepResult {
  name: string;
  ok: boolean;
  detail: string;
  durationMs: number;
}

export interface VerifyLoopResult {
  ok: boolean;
  project: string;
  attempts: number;
  steps: VerifyStepResult[];
  failure: ClassifiedFailure | null;
  /** Everything was torn down at the end, whatever happened. */
  cleaned: boolean;
}
