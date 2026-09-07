import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claimIsPositive, mergeClaim, type CapabilityClaim, type ModelDescriptor, type Pricing } from '@meridian/shared';
import { enrich, detectChanges, diffModel } from '@meridian/model-sdk';
import {
  DiscoveryScheduler,
  MemoryProfileStore,
  ProfileManager,
  SkillRegistry,
  capabilityState,
  estimateTokens,
  explainResolution,
  matchModel,
  modelSupports,
  parseRequirement,
  resolveTarget,
  searchCapabilities,
} from '@meridian/control-sdk';

const PRICING: Pricing = { kind: 'LOCAL', inputPerMTok: null, outputPerMTok: null, perRequest: null, note: null };

function model(over: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'p:m',
    providerId: 'p',
    providerModelId: 'm',
    displayName: 'm',
    family: null,
    modalities: ['text'],
    capabilities: ['text'],
    contextLength: 8000,
    maxOutputTokens: null,
    pricing: PRICING,
    discovered: true,
    deprecated: false,
    tags: [],
    updatedAt: 1,
    ...over,
  };
}

describe('capability provenance', () => {
  it('keeps a provider declaration distinct from a name guess', () => {
    // The whole point: enrich() used to flatten both into one array, which made
    // a heuristic indistinguishable from something the provider stated.
    const enriched = enrich(model({ providerModelId: 'llava-vision-7b', capabilities: ['text'] }), {
      declaredSource: 'test listing',
      now: 100,
    });
    assert.equal(enriched.capabilityClaims?.text?.state, 'provider_declared');
    assert.equal(enriched.capabilityClaims?.text?.source, 'test listing');
    assert.equal(enriched.capabilityClaims?.vision?.state, 'inferred');
    assert.match(enriched.capabilityClaims!.vision!.source, /heuristic/);
  });

  it('lets stronger evidence win and never downgrades a confirmed claim', () => {
    const inferred: CapabilityClaim = { state: 'inferred', source: 'name', confidence: 0.5, at: 1 };
    const declared: CapabilityClaim = { state: 'provider_declared', source: 'listing', confidence: 0.9, at: 2 };
    const confirmed: CapabilityClaim = { state: 'user_confirmed', source: 'operator', confidence: 0.95, at: 3 };
    assert.equal(mergeClaim(inferred, declared).state, 'provider_declared');
    assert.equal(mergeClaim(confirmed, declared).state, 'user_confirmed', 'a weaker later claim must not overwrite a confirmation');
    assert.equal(mergeClaim(declared, confirmed).state, 'user_confirmed');
  });

  it('survives re-enrichment: a confirmation is not lost on the next discovery pass', () => {
    const confirmed = model({
      capabilityClaims: { vision: { state: 'user_confirmed', source: 'operator', confidence: 0.95, at: 5 } },
    });
    const again = enrich(confirmed, { now: 10 });
    assert.equal(again.capabilityClaims?.vision?.state, 'user_confirmed');
  });

  it('treats unknown as unknown, never as unsupported', () => {
    const m = model();
    assert.equal(capabilityState(m, 'vision').state, 'unknown');
    assert.equal(modelSupports(m, 'vision'), false);
    assert.equal(claimIsPositive(undefined), false);
    assert.equal(claimIsPositive({ state: 'unknown', source: '', confidence: 0, at: 0 }), false);
    assert.equal(claimIsPositive({ state: 'inferred', source: '', confidence: 0, at: 0 }), true);
  });
});

describe('model change detection', () => {
  it('reports discovery, meaningful updates and removal, and stays quiet otherwise', () => {
    const before = [model({ id: 'p:a', contextLength: 128000 })];
    const same = detectChanges(before, [model({ id: 'p:a', contextLength: 128000 })], 1);
    assert.equal(same.length, 0, 'an unchanged catalog must not re-announce itself');

    const grown = detectChanges(before, [model({ id: 'p:a', contextLength: 256000 })], 1);
    assert.equal(grown[0].kind, 'updated');
    assert.deepEqual(grown[0].changes[0], { field: 'contextLength', from: '128000', to: '256000' });

    const added = detectChanges(before, [...before, model({ id: 'p:b' })], 1);
    assert.equal(added.find((c) => c.modelId === 'p:b')?.kind, 'discovered');

    const removed = detectChanges(before, [], 1);
    assert.equal(removed[0].kind, 'removed');
  });

  it('ignores fields a human would not care about', () => {
    assert.equal(diffModel(model({ updatedAt: 1 }), model({ updatedAt: 999 })).length, 0);
  });
});

describe('assignment precedence', () => {
  const asg = (targetId: string, scope: string, scopeId: string | null, mode: 'include' | 'exclude') => ({
    id: `${scope}-${mode}`,
    kind: 'skill' as const,
    targetId,
    scope: scope as never,
    scopeId,
    mode,
    createdAt: 0,
    updatedAt: 0,
  });

  it('defaults to off when nothing has an opinion', () => {
    const r = resolveTarget('s', [], {});
    assert.equal(r.enabled, false);
    assert.equal(r.decidedBy, 'default');
  });

  it('lets a model-scoped exclusion beat a global include', () => {
    // The headline requirement: globally on, off for one model, without
    // touching the global rule.
    const assignments = [asg('s', 'global', null, 'include'), asg('s', 'model', 'm1', 'exclude')];
    const excluded = resolveTarget('s', assignments, { modelId: 'm1' });
    assert.equal(excluded.enabled, false);
    assert.equal(excluded.decidedBy, 'model');
    assert.match(explainResolution(excluded), /Excluded by model "m1"/);

    const other = resolveTarget('s', assignments, { modelId: 'm2' });
    assert.equal(other.enabled, true, 'other models still inherit the global rule');
    assert.equal(other.decidedBy, 'global');
  });

  it('walks the full order, most specific last', () => {
    const assignments = [
      asg('s', 'global', null, 'include'),
      asg('s', 'provider', 'p', 'exclude'),
      asg('s', 'model', 'm', 'include'),
      asg('s', 'session', 'sess', 'exclude'),
    ];
    const r = resolveTarget('s', assignments, { providerId: 'p', modelId: 'm', sessionId: 'sess' });
    assert.equal(r.decidedBy, 'session');
    assert.equal(r.enabled, false);
    assert.equal(r.considered.length, 4, 'every scope with an opinion is recorded for the UI');
  });

  it('ignores scopes that do not apply to the context', () => {
    const assignments = [asg('s', 'global', null, 'include'), asg('s', 'workspace', 'w1', 'exclude')];
    // No workspace in context: the workspace rule cannot have an opinion.
    const r = resolveTarget('s', assignments, { modelId: 'm' });
    assert.equal(r.enabled, true);
    assert.equal(r.decidedBy, 'global');
  });
});

describe('skills and effective configuration', () => {
  const setup = async () => {
    const skills = new SkillRegistry();
    await skills.load();
    await skills.create({ slug: 'plain', name: 'Plain', content: 'x'.repeat(370) });
    await skills.create({ slug: 'seeing', name: 'Seeing', content: 'look', requiresCapabilities: ['vision'] });
    const models = new Map<string, ModelDescriptor>([
      ['p:text', model({ id: 'p:text', displayName: 'Text only', contextLength: 1000 })],
      ['p:vision', model({ id: 'p:vision', displayName: 'Sees', capabilities: ['text', 'vision'], contextLength: 1000 })],
    ]);
    const profiles = new ProfileManager({
      store: new MemoryProfileStore(),
      deps: {
        skills: () => skills.list(),
        mcpServers: () => [{ id: 'mcp1', name: 'Files', enabled: true, unavailableReason: null }],
        model: (id) => models.get(id) ?? null,
      },
    });
    await profiles.load();
    return { skills, profiles };
  };

  it('estimates token cost so context pressure can be warned about', () => {
    assert.equal(estimateTokens(''), 0);
    assert.ok(estimateTokens('x'.repeat(370)) === 100);
  });

  it('blocks a skill whose capability requirement the model does not meet, with a reason', async () => {
    const { profiles } = await setup();
    await profiles.setAssignment({ kind: 'skill', targetId: 'seeing', scope: 'global', mode: 'include' });

    const onText = profiles.effectiveConfig({ modelId: 'p:text' });
    assert.equal(onText.skills.length, 0);
    const blocked = onText.excludedSkills.find((r) => r.targetId === 'seeing');
    assert.match(blocked!.blocked!, /needs vision/);
    assert.equal(onText.warnings.length, 1, 'a misconfiguration is surfaced, not silently dropped');

    const onVision = profiles.effectiveConfig({ modelId: 'p:vision' });
    assert.deepEqual(onVision.skills.map((s) => s.skill.slug), ['seeing']);
  });

  it('warns when active skills eat the context window', async () => {
    const { profiles } = await setup();
    await profiles.setAssignment({ kind: 'skill', targetId: 'plain', scope: 'global', mode: 'include' });
    const config = profiles.effectiveConfig({ modelId: 'p:text' });
    assert.equal(config.skillTokens, 100);
    assert.equal(config.contextPressure, 0.1);
    // 10% is under the warning threshold; the number is still reported.
    assert.equal(config.warnings.length, 0);
  });

  it('builds a stable prompt from the active skills only', async () => {
    const { profiles } = await setup();
    await profiles.setAssignment({ kind: 'skill', targetId: 'plain', scope: 'global', mode: 'include' });
    const config = profiles.effectiveConfig({ modelId: 'p:vision' });
    const prompt = profiles.skillPrompt(config);
    assert.match(prompt, /## Plain/);
    assert.doesNotMatch(prompt, /## Seeing/, 'an unassigned skill must never reach the prompt');
  });

  it('clearing an assignment restores inheritance rather than forcing off', async () => {
    const { profiles } = await setup();
    await profiles.setAssignment({ kind: 'skill', targetId: 'plain', scope: 'global', mode: 'include' });
    await profiles.setAssignment({ kind: 'skill', targetId: 'plain', scope: 'model', scopeId: 'p:text', mode: 'exclude' });
    assert.equal(profiles.effectiveConfig({ modelId: 'p:text' }).skills.length, 0);

    await profiles.clearAssignment({ kind: 'skill', targetId: 'plain', scope: 'model', scopeId: 'p:text' });
    assert.equal(profiles.effectiveConfig({ modelId: 'p:text' }).skills.length, 1, 'clearing returns to the global rule');
  });

  it('reports an MCP grant as blocked when the model cannot call tools', async () => {
    const { profiles } = await setup();
    await profiles.setAssignment({ kind: 'mcp', targetId: 'mcp1', scope: 'global', mode: 'include' });
    const config = profiles.effectiveConfig({ modelId: 'p:text' });
    assert.equal(config.mcpServers.length, 0);
    assert.match(config.excludedMcpServers[0].blocked!, /tool calling/);
  });

  it('keeps one decision per scope instead of stacking contradictions', async () => {
    const { profiles } = await setup();
    await profiles.setAssignment({ kind: 'skill', targetId: 'plain', scope: 'global', mode: 'include' });
    await profiles.setAssignment({ kind: 'skill', targetId: 'plain', scope: 'global', mode: 'exclude' });
    assert.equal(profiles.listAssignments('skill').filter((a) => a.scope === 'global').length, 1);
    assert.equal(profiles.effectiveConfig({ modelId: 'p:text' }).skills.length, 0);
  });
});

describe('capability matching and search', () => {
  const available = () => ({ available: true, local: false, detail: null });

  it('ranks proven support above a name guess', () => {
    const guessed = enrich(model({ id: 'p:guess', providerModelId: 'vision-x', capabilities: [] }), { now: 1 });
    const declared = model({
      id: 'p:declared',
      capabilities: ['text', 'vision'],
      capabilityClaims: { vision: { state: 'provider_declared', source: 'listing', confidence: 0.9, at: 1 } },
    });
    const ranked = searchCapabilities([guessed, declared], { capabilities: ['vision'] }, available);
    assert.equal(ranked[0].modelId, 'p:declared', 'declared support outranks an inference');
    assert.ok(ranked[1].reasons.some((r) => /inferred/.test(r)), 'the guess is labelled as one');
  });

  it('returns an ineligible model with the reason instead of hiding it', () => {
    const m = model({ contextLength: 4000 });
    const match = matchModel(m, { capabilities: ['vision'], minContextLength: 100000 }, available());
    assert.equal(match.eligible, false);
    assert.deepEqual(match.missing.map((x) => x.capability), ['vision']);
    assert.ok(match.reasons.some((r) => /context 4000 is below/.test(r)));
  });

  it('refuses to route a local-only request to a cloud model', () => {
    const match = matchModel(model(), { capabilities: ['text'], localOnly: true }, { available: true, local: false, detail: null });
    assert.equal(match.eligible, false);
    assert.ok(match.reasons.some((r) => /local-only/.test(r)));
  });

  it('reads a plain-language question into a requirement', () => {
    const r = parseRequirement('analyze an image and browse the web');
    assert.ok(r.capabilities.includes('vision'));
    assert.ok(r.capabilities.includes('tools'));
    const local = parseRequirement('which local models can use tools?');
    assert.equal(local.localOnly, true);
    assert.ok(local.capabilities.includes('tools'));
  });
});

describe('discovery scheduler', () => {
  it('paces a provider, backs off after failure, and pauses after repeated failure', () => {
    let now = 1_000_000;
    const s = new DiscoveryScheduler({ minIntervalMs: 1000, baseBackoffMs: 100, maxConsecutiveFailures: 3, now: () => now, random: () => 0.5 });

    assert.equal(s.canRun('p').allowed, true);
    s.markSuccess('p');
    assert.equal(s.canRun('p').allowed, false, 'a provider queried just now is not re-asked');
    now += 1001;
    assert.equal(s.canRun('p').allowed, true);

    s.markFailure('p', 'boom');
    assert.equal(s.canRun('p').allowed, false, 'backing off');
    now += 1000;
    s.markFailure('p', 'boom');
    s.markFailure('p', 'boom');
    const verdict = s.canRun('p');
    assert.equal(verdict.allowed, false);
    assert.match(verdict.reason!, /consecutive failures/);
  });

  it('lets a manual refresh bypass pacing but not become a click storm', () => {
    let now = 1_000_000;
    const s = new DiscoveryScheduler({ minIntervalMs: 60_000, now: () => now, random: () => 0.5 });
    s.markSuccess('p');
    assert.equal(s.canRun('p').allowed, false);
    assert.equal(s.canRun('p', { force: true }).allowed, false, 'a forced run right after an attempt still respects the floor');
    now += 6000;
    assert.equal(s.canRun('p', { force: true }).allowed, true);
  });
});
