import type { DockerOrchestrator } from './orchestrator.js';
import { classifyFailure } from './orchestrator.js';
import type { ClassifiedFailure, DockerProjectInfo, VerifyLoopResult, VerifyStepResult } from './types.js';

/** First host port a container publishes, from docker ps port syntax. */
export function hostPortOf(ports: string): number | null {
  const m = /(?:0\.0\.0\.0|\[?::\]?|127\.0\.0\.1):(\d+)->/.exec(ports);
  return m ? Number(m[1]) : null;
}

export interface VerifyLoopInput {
  orchestrator: DockerOrchestrator;
  project: DockerProjectInfo;
  /** Run the project's tests inside the container, when it has any. */
  testCommand?: string[] | null;
  testService?: string;
  /**
   * The browser leg: given the app's reachable base URL, drive a real browser
   * against it and report. Injected so this package needs no browser
   * dependency; the gateway passes a browser-sdk-backed check.
   */
  browserCheck?: ((baseUrl: string) => Promise<{ ok: boolean; detail: string }>) | null;
  /** Which service's published port is the app; defaults to the first found. */
  appService?: string;
  /** Build args, e.g. an alternate BASE_IMAGE where the default registry is unreachable. */
  buildArgs?: Record<string, string>;
  /** Extra retries for retryable failure classes. Total attempts = 1 + budget. */
  retryBudget?: number;
  healthBudgetMs?: number;
  onLog?: (line: string) => void;
}

/**
 * The build → up → healthy → test → browser-verify → down loop.
 *
 * One attempt runs every stage in order and stops at the first failure, which
 * is classified; a retryable class spends the retry budget, everything else
 * fails fast. Teardown always runs — a failed verification never leaves
 * session containers behind.
 */
export async function runVerifyLoop(input: VerifyLoopInput): Promise<VerifyLoopResult> {
  const { orchestrator, project } = input;
  const budget = Math.min(input.retryBudget ?? 1, 3);
  const log = input.onLog ?? (() => undefined);
  const steps: VerifyStepResult[] = [];
  let failure: ClassifiedFailure | null = null;
  let attempts = 0;

  const availability = await orchestrator.detectDocker();
  if (!availability.available) {
    return {
      ok: false,
      project: orchestrator.projectName(project.path),
      attempts: 0,
      steps: [{ name: 'detect-docker', ok: false, detail: availability.detail ?? 'unavailable', durationMs: 0 }],
      failure: { class: 'DOCKER_UNAVAILABLE', stage: 'detect', detail: availability.detail ?? 'unavailable', retryable: false },
      cleaned: true,
    };
  }

  for (attempts = 1; attempts <= budget + 1; attempts++) {
    steps.length = 0;
    failure = null;
    log(`attempt ${attempts}/${budget + 1}`);

    try {
      failure = await runAttempt(input, steps, log);
    } finally {
      const t0 = Date.now();
      const down = await orchestrator.down(project);
      steps.push({ name: 'down', ok: down.ok, detail: down.ok ? 'cleaned up' : down.stderr.slice(0, 200), durationMs: Date.now() - t0 });
      await orchestrator.cleanupSession().catch(() => undefined);
    }

    if (!failure) break;
    if (!failure.retryable) {
      log(`failure class ${failure.class} is not retryable; stopping`);
      break;
    }
    if (attempts <= budget) log(`retrying after ${failure.class}`);
  }

  return {
    ok: failure === null,
    project: orchestrator.projectName(project.path),
    attempts,
    steps: [...steps],
    failure,
    cleaned: true,
  };
}

async function runAttempt(
  input: VerifyLoopInput,
  steps: VerifyStepResult[],
  log: (line: string) => void,
): Promise<ClassifiedFailure | null> {
  const { orchestrator, project } = input;

  const step = async <T>(name: VerifyStepResult['name'], fn: () => Promise<{ ok: boolean; detail: string; value?: T }>) => {
    const t0 = Date.now();
    const result = await fn();
    steps.push({ name, ok: result.ok, detail: result.detail.slice(0, 400), durationMs: Date.now() - t0 });
    log(`${name}: ${result.ok ? 'ok' : 'FAIL'} (${result.detail.slice(0, 160)})`);
    return result;
  };

  const build = await step('build', async () => {
    const r = await orchestrator.build(project, { buildArgs: input.buildArgs });
    return { ok: r.ok, detail: r.ok ? `built in ${Math.round(r.durationMs / 1000)}s` : r.stderr || r.stdout };
  });
  if (!build.ok) return classifyFailure('build', build.detail);

  const up = await step('up', async () => {
    const r = await orchestrator.up(project);
    return { ok: r.ok, detail: r.ok ? 'containers started' : r.stderr || r.stdout };
  });
  if (!up.ok) return classifyFailure('up', up.detail);

  const health = await step('health', async () => orchestrator.waitHealthy(project, input.healthBudgetMs ?? 120_000));
  if (!health.ok) {
    const logs = await orchestrator.logs(project, { tail: 80 }).catch(() => '');
    return classifyFailure('health', `${health.detail}\n${logs}`);
  }

  if (input.testCommand && input.testCommand.length > 0) {
    const test = await step('test', async () => {
      const r = await orchestrator.execIn(project, input.testCommand!, { service: input.testService, timeoutMs: 600_000 });
      return { ok: r.ok, detail: r.ok ? 'tests passed' : (r.stderr || r.stdout).slice(-600) };
    });
    if (!test.ok) return classifyFailure('test', test.detail);
  }

  if (input.browserCheck) {
    const containers = await orchestrator.ps(project);
    const app = input.appService ? containers.find((c) => c.name.includes(input.appService!)) : containers.find((c) => hostPortOf(c.ports) !== null);
    const port = app ? hostPortOf(app.ports) : null;
    if (!port) {
      steps.push({ name: 'verify', ok: false, detail: 'no published port found to point the browser at', durationMs: 0 });
      return classifyFailure('verify', 'no published port found');
    }
    const verify = await step('verify', async () => input.browserCheck!(`http://localhost:${port}`));
    if (!verify.ok) return classifyFailure('verify', verify.detail);
  }

  return null;
}
