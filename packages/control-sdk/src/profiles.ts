import { randomUUID } from 'node:crypto';
import {
  MeridianError,
  type AIProfile,
  type Assignment,
  type AssignmentKind,
  type AssignmentScope,
  type Capability,
  type EffectiveConfig,
  type ModelDescriptor,
  type PrivacyPreference,
  type ResolutionReason,
  type Skill,
} from '@meridian/shared';
import { resolveAll, type ResolutionContext } from './assignments.js';
import { modelSupports } from './capabilities.js';

/**
 * AI profiles and the effective-configuration resolver.
 *
 * The resolver is the single authority the runtime and the UI both read. If it
 * says a skill is active, the request carries it; if the UI shows a skill as
 * active, it is because this function said so. Keeping one implementation for
 * both is what stops the settings screen from becoming decoration.
 */

export interface ProfileStore {
  listProfiles(): Promise<AIProfile[]>;
  saveProfile(profile: AIProfile): Promise<void>;
  removeProfile(id: string): Promise<void>;
  listAssignments(): Promise<Assignment[]>;
  saveAssignment(assignment: Assignment): Promise<void>;
  removeAssignment(id: string): Promise<void>;
}

export class MemoryProfileStore implements ProfileStore {
  private profiles = new Map<string, AIProfile>();
  private assignments = new Map<string, Assignment>();
  async listProfiles() {
    return [...this.profiles.values()];
  }
  async saveProfile(p: AIProfile) {
    this.profiles.set(p.id, p);
  }
  async removeProfile(id: string) {
    this.profiles.delete(id);
  }
  async listAssignments() {
    return [...this.assignments.values()];
  }
  async saveAssignment(a: Assignment) {
    this.assignments.set(a.id, a);
  }
  async removeAssignment(id: string) {
    this.assignments.delete(id);
  }
}

export interface ProfileInput {
  name: string;
  description?: string;
  modelId?: string | null;
  providerId?: string | null;
  routingMode?: string | null;
  requiredCapabilities?: Capability[];
  privacyPreference?: PrivacyPreference;
  enabled?: boolean;
}

export interface AssignmentInput {
  kind: AssignmentKind;
  targetId: string;
  scope: AssignmentScope;
  scopeId?: string | null;
  mode: 'include' | 'exclude';
}

/** What the resolver needs to know about the world outside the control plane. */
export interface ResolverDeps {
  /** Every skill Meridian holds. */
  skills: () => Skill[];
  /** Every MCP server: id, name, and whether it can be used at all. */
  mcpServers: () => { id: string; name: string; enabled: boolean; unavailableReason: string | null }[];
  /** The model a profile resolves to, when one is known. */
  model: (modelId: string) => ModelDescriptor | null;
}

export class ProfileManager {
  private readonly store: ProfileStore;
  private readonly deps: ResolverDeps;
  private readonly now: () => number;
  private profiles = new Map<string, AIProfile>();
  private assignments = new Map<string, Assignment>();
  private loaded = false;

  constructor(opts: { store?: ProfileStore; deps: ResolverDeps; now?: () => number }) {
    this.store = opts.store ?? new MemoryProfileStore();
    this.deps = opts.deps;
    this.now = opts.now ?? (() => Date.now());
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    for (const p of await this.store.listProfiles()) this.profiles.set(p.id, p);
    for (const a of await this.store.listAssignments()) this.assignments.set(a.id, a);
    this.loaded = true;
  }

  /* ---- profiles --------------------------------------------------- */

  listProfiles(): AIProfile[] {
    return [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getProfile(id: string): AIProfile | null {
    return this.profiles.get(id) ?? null;
  }

  async createProfile(input: ProfileInput): Promise<AIProfile> {
    if (!input.name.trim()) throw new MeridianError('invalid_request', 'A profile needs a name');
    const at = this.now();
    const profile: AIProfile = {
      id: `aip_${randomUUID().slice(0, 12)}`,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      modelId: input.modelId ?? null,
      providerId: input.providerId ?? null,
      routingMode: input.routingMode ?? null,
      requiredCapabilities: input.requiredCapabilities ?? [],
      privacyPreference: input.privacyPreference ?? 'balanced',
      enabled: input.enabled ?? true,
      createdAt: at,
      updatedAt: at,
    };
    this.profiles.set(profile.id, profile);
    await this.store.saveProfile(profile);
    return profile;
  }

  async updateProfile(id: string, patch: Partial<ProfileInput>): Promise<AIProfile> {
    const existing = this.profiles.get(id);
    if (!existing) throw new MeridianError('invalid_request', `No profile ${id}`);
    const next: AIProfile = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.modelId !== undefined ? { modelId: patch.modelId } : {}),
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.routingMode !== undefined ? { routingMode: patch.routingMode } : {}),
      ...(patch.requiredCapabilities !== undefined ? { requiredCapabilities: patch.requiredCapabilities } : {}),
      ...(patch.privacyPreference !== undefined ? { privacyPreference: patch.privacyPreference } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: this.now(),
    };
    this.profiles.set(id, next);
    await this.store.saveProfile(next);
    return next;
  }

  async removeProfile(id: string): Promise<void> {
    this.profiles.delete(id);
    await this.store.removeProfile(id);
    // Assignments scoped to a deleted profile would otherwise linger and could
    // be resurrected by a new profile reusing the id.
    for (const a of [...this.assignments.values()]) {
      if (a.scope === 'profile' && a.scopeId === id) await this.removeAssignment(a.id);
    }
  }

  /* ---- assignments ------------------------------------------------- */

  listAssignments(kind?: AssignmentKind): Assignment[] {
    const all = [...this.assignments.values()];
    return kind ? all.filter((a) => a.kind === kind) : all;
  }

  /**
   * Set one assignment. One decision per (kind, target, scope, scopeId), so
   * re-assigning replaces rather than stacking contradictory rules.
   */
  async setAssignment(input: AssignmentInput): Promise<Assignment> {
    if (input.scope !== 'global' && !input.scopeId) {
      throw new MeridianError('invalid_request', `A ${input.scope} assignment needs a scopeId`);
    }
    const scopeId = input.scope === 'global' ? null : (input.scopeId ?? null);
    const existing = [...this.assignments.values()].find(
      (a) => a.kind === input.kind && a.targetId === input.targetId && a.scope === input.scope && (a.scopeId ?? null) === scopeId,
    );
    const at = this.now();
    const assignment: Assignment = existing
      ? { ...existing, mode: input.mode, updatedAt: at }
      : {
          id: `asg_${randomUUID().slice(0, 12)}`,
          kind: input.kind,
          targetId: input.targetId,
          scope: input.scope,
          scopeId,
          mode: input.mode,
          createdAt: at,
          updatedAt: at,
        };
    this.assignments.set(assignment.id, assignment);
    await this.store.saveAssignment(assignment);
    return assignment;
  }

  /** Remove an assignment so the target inherits from broader scopes again. */
  async clearAssignment(input: Omit<AssignmentInput, 'mode'>): Promise<boolean> {
    const scopeId = input.scope === 'global' ? null : (input.scopeId ?? null);
    const hit = [...this.assignments.values()].find(
      (a) => a.kind === input.kind && a.targetId === input.targetId && a.scope === input.scope && (a.scopeId ?? null) === scopeId,
    );
    if (!hit) return false;
    this.assignments.delete(hit.id);
    await this.store.removeAssignment(hit.id);
    return true;
  }

  async removeAssignment(id: string): Promise<void> {
    this.assignments.delete(id);
    await this.store.removeAssignment(id);
  }

  /* ---- effective configuration -------------------------------------- */

  /**
   * What this AI will actually be given, and why.
   *
   * Every enabled item carries its resolution chain, every excluded one is
   * reported too, and anything enabled-but-unusable is marked `blocked` rather
   * than silently dropped — a skill whose model lacks a required capability is
   * a configuration problem the user needs to see, not a no-op.
   */
  effectiveConfig(ctx: ResolutionContext & { profileId?: string | null }): EffectiveConfig {
    const profile = ctx.profileId ? this.profiles.get(ctx.profileId) : null;
    const modelId = ctx.modelId ?? profile?.modelId ?? null;
    const model = modelId ? this.deps.model(modelId) : null;
    const providerId = ctx.providerId ?? profile?.providerId ?? model?.providerId ?? null;

    const resolutionCtx: ResolutionContext = {
      providerId,
      modelId,
      profileId: ctx.profileId ?? null,
      workspaceId: ctx.workspaceId ?? null,
      sessionId: ctx.sessionId ?? null,
    };

    const allSkills = this.deps.skills();
    const assignments = [...this.assignments.values()];

    const skillReasons = resolveAll(
      allSkills.map((s) => s.slug),
      assignments,
      'skill',
      resolutionCtx,
    );

    const skills: EffectiveConfig['skills'] = [];
    const excludedSkills: ResolutionReason[] = [];
    const warnings: string[] = [];

    for (const reason of skillReasons) {
      const skill = allSkills.find((s) => s.slug === reason.targetId);
      if (!skill) continue;
      if (!reason.enabled) {
        excludedSkills.push(reason);
        continue;
      }
      if (!skill.enabled) {
        excludedSkills.push({ ...reason, enabled: false, blocked: 'the skill itself is disabled' });
        continue;
      }
      // A skill that needs vision is worse than useless on a text-only model:
      // it spends context telling the model to do something it cannot do.
      const unmet = model ? skill.requiresCapabilities.filter((c) => !modelSupports(model, c)) : [];
      if (unmet.length) {
        const blocked = `needs ${unmet.join(', ')}, which ${model?.displayName ?? 'this model'} does not report`;
        excludedSkills.push({ ...reason, enabled: false, blocked });
        warnings.push(`Skill "${skill.name}" is assigned but ${blocked}.`);
        continue;
      }
      skills.push({ skill, reason });
    }

    const servers = this.deps.mcpServers();
    const mcpReasons = resolveAll(
      servers.map((s) => s.id),
      assignments,
      'mcp',
      resolutionCtx,
    );

    const mcpServers: EffectiveConfig['mcpServers'] = [];
    const excludedMcpServers: ResolutionReason[] = [];
    for (const reason of mcpReasons) {
      const server = servers.find((s) => s.id === reason.targetId);
      if (!server) continue;
      if (!reason.enabled) {
        excludedMcpServers.push(reason);
        continue;
      }
      const blocked = !server.enabled
        ? 'the server is disabled'
        : server.unavailableReason
          ? server.unavailableReason
          : model && !modelSupports(model, 'tools')
            ? `${model.displayName} does not report tool calling, which MCP requires`
            : null;
      if (blocked) {
        excludedMcpServers.push({ ...reason, enabled: false, blocked });
        warnings.push(`MCP server "${server.name}" is assigned but ${blocked}.`);
        continue;
      }
      mcpServers.push({ serverId: server.id, name: server.name, reason });
    }

    const skillTokens = skills.reduce((sum, s) => sum + s.skill.estimatedTokens, 0);
    const contextLength = model?.contextLength ?? null;
    const contextPressure = contextLength && contextLength > 0 ? skillTokens / contextLength : null;
    if (contextPressure !== null && contextPressure > 0.25) {
      warnings.push(
        `Active skills use an estimated ${skillTokens.toLocaleString()} tokens — ${Math.round(contextPressure * 100)}% of this model's context.`,
      );
    }

    return {
      profileId: ctx.profileId ?? null,
      modelId,
      providerId,
      skills,
      excludedSkills,
      mcpServers,
      excludedMcpServers,
      skillTokens,
      contextLength,
      contextPressure,
      warnings,
    };
  }

  /** The system-prompt fragment for the resolved skills, in a stable order. */
  skillPrompt(config: EffectiveConfig): string {
    if (!config.skills.length) return '';
    return config.skills
      .map((s) => s.skill)
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((s) => `## ${s.name}\n\n${s.content.trim()}`)
      .join('\n\n');
  }
}
