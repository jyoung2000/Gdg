import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AGENT_DEFINITIONS, AGENT_ROLES_ORDER, Orchestrator } from '@meridian/agent-sdk';
import { PIPELINE_KINDS, loadConfig, type AgentRole, type PipelineKind } from '@meridian/shared';
import { App } from '../../apps/gateway/src/services/app.js';
import { createServer } from '../../apps/gateway/src/server.js';
import { startSimServer, type SimServer } from './helpers/sim-server.js';

/**
 * Every declared agent role must be reachable.
 *
 * Two of them were not. `orchestrator` and `browser` existed in the AgentRole
 * union, in AGENT_DEFINITIONS and in AGENT_ROLES_ORDER, and `planPipeline`
 * never emitted either — so no request, by any route, could run them. A defined
 * agent nobody can select is dead weight that reads from the outside like a
 * capability, which is exactly what a release build should not ship.
 *
 * The check that matters is the first one: it derives what must be reachable
 * from the roster itself, so adding a tenth agent without a way to select it
 * fails here rather than being noticed a release later.
 */
describe('Agent roles', () => {
  let app: App;
  let server: FastifyInstance;
  let sim: SimServer;
  let dataDir: string;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'meridian-roles-'));
    sim = await startSimServer();
    const config = loadConfig({
      MERIDIAN_DATA_DIR: dataDir,
      MERIDIAN_DB: join(dataDir, 'test.db'),
      MERIDIAN_WORKSPACE_ROOT: join(dataDir, 'workspaces'),
      MERIDIAN_ASSET_ROOT: join(dataDir, 'assets'),
      MERIDIAN_MASTER_KEY: 'agent-roles-test-key',
      MERIDIAN_LOG_LEVEL: 'error',
      MERIDIAN_HEALTH_INTERVAL_MS: '0',
      MERIDIAN_DISCOVERY_INTERVAL_MS: '0',
      MERIDIAN_SANDBOX: 'process',
      MERIDIAN_LOCAL_ENDPOINTS: sim.root,
      PORT: '0',
    } as NodeJS.ProcessEnv);
    app = await App.create(config);
    server = await createServer(app);
    await server.ready();
  });

  after(async () => {
    await server?.close();
    await app?.stop();
    await sim?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  /** Which roles any named pipeline can produce. */
  function reachableRoles(): Set<AgentRole> {
    const orchestrator = app.orchestrator;
    const roles = new Set<AgentRole>();
    for (const kind of PIPELINE_KINDS) {
      // 'auto' is the heuristic path; drive it with request text of each shape
      // rather than trusting one sample to cover the branches.
      const requests =
        kind === 'auto'
          ? ['what does this repo do?', 'fix the failing test', 'add tests for the parser', 'add a feature that writes a report']
          : ['do the thing'];
      for (const request of requests) {
        for (const role of orchestrator.planPipeline(request, kind as PipelineKind).steps) roles.add(role);
      }
    }
    return roles;
  }

  it('can select every agent it declares', () => {
    const reachable = reachableRoles();
    const orphaned = AGENT_ROLES_ORDER.filter((role) => !reachable.has(role));
    assert.deepEqual(
      orphaned,
      [],
      `these agents are defined but no pipeline can select them: ${orphaned.join(', ')}. ` +
        'Either give them a way in or stop declaring them.',
    );
  });

  it('gives every agent a definition with tools it can actually be given', () => {
    for (const role of AGENT_ROLES_ORDER) {
      const def = AGENT_DEFINITIONS[role];
      assert.ok(def, `${role} is in AGENT_ROLES_ORDER with no definition`);
      assert.equal(def.role, role, `${role}'s definition names itself ${def.role}`);
      assert.ok(def.tools.length > 0, `${role} has no tools`);
      assert.ok(def.tools.includes('finish'), `${role} cannot finish, so its loop can only end by running out of steps`);
      assert.ok(def.maxSteps > 0, `${role} has no step budget`);
      assert.ok(def.systemPrompt.trim().length > 100, `${role} has no real system prompt`);
    }
  });

  it('routes the explicit pipelines to the agents they name', () => {
    const o = app.orchestrator;
    // An explicit ask must beat the heuristics: a research request whose text
    // happens to contain "add" must not be routed into the mutating pipeline.
    assert.deepEqual(o.planPipeline('add up what this does', 'research').steps, ['file-finder', 'researcher']);
    assert.deepEqual(o.planPipeline('anything', 'browse').steps, ['browser']);
    assert.ok(o.planPipeline('anything', 'orchestrate').steps.includes('orchestrator'));
    assert.deepEqual(o.planPipeline('anything', 'debug').steps, ['file-finder', 'debugger', 'tester', 'reviewer']);
    assert.deepEqual(o.planPipeline('anything', 'tests').steps, ['file-finder', 'tester', 'reviewer']);
  });

  it('never puts a workspace-mutating agent in a read-only pipeline', () => {
    // 'research' and 'browse' are documented as not touching the workspace.
    // That promise is only worth having if it is enforced.
    const MUTATING = new Set(['write_file', 'edit_file', 'delete_file', 'run_command']);
    for (const kind of ['research', 'browse'] as const) {
      for (const role of app.orchestrator.planPipeline('anything', kind).steps) {
        const tools = AGENT_DEFINITIONS[role].tools;
        const mutating = tools.filter((t) => MUTATING.has(t));
        assert.deepEqual(mutating, [], `${kind} includes ${role}, which can ${mutating.join('/')}`);
      }
    }
  });
});
