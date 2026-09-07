import { randomUUID } from 'node:crypto';
import type { AIProfile, Assignment, Logger, ModelDescriptor, Skill } from '@meridian/shared';
import {
  BUILTIN_SKILLS,
  DiscoveryScheduler,
  ProfileManager,
  SkillRegistry,
  type ProfileStore,
  type SkillStore,
} from '@meridian/control-sdk';
import type { ModelRegistry } from '@meridian/model-sdk';
import type { McpManager } from '@meridian/mcp-sdk';
import type { Store } from '../db/store.js';

/**
 * The AI control plane, bound to the gateway's persistence.
 *
 * Everything here is the same objects the routes and the runtime use: there is
 * one SkillRegistry and one ProfileManager per process, so a change made
 * through the API is visible to the very next request rather than after a
 * restart. That is what keeps the settings screens from being decoration.
 */
export interface ControlPlane {
  skills: SkillRegistry;
  profiles: ProfileManager;
  scheduler: DiscoveryScheduler;
}

export async function createAIControlPlane(opts: {
  store: Store;
  models: ModelRegistry;
  mcp: McpManager;
  logger: Logger;
}): Promise<ControlPlane> {
  const { store, models, mcp, logger } = opts;

  const skillStore: SkillStore = {
    list: async () => store.listSkills() as Skill[],
    save: async (skill) => store.saveSkill(skill.id, skill.slug, skill, skill.updatedAt),
    remove: async (id) => store.deleteSkill(id),
  };
  const skills = new SkillRegistry({ store: skillStore });
  await skills.load();

  // Seed the shipped skills once. Keyed on slug, so an operator who deletes one
  // does not get it back on every restart — only a genuinely empty install is
  // seeded.
  if (skills.list().length === 0) {
    for (const input of BUILTIN_SKILLS) {
      await skills.create(input).catch((e: unknown) => logger.warn('builtin skill seed failed', { detail: String(e) }));
    }
    logger.info('seeded builtin skills', { count: skills.list().length });
  }

  const profileStore: ProfileStore = {
    listProfiles: async () => store.listAIProfiles() as AIProfile[],
    saveProfile: async (p) => store.saveAIProfile(p.id, p, p.updatedAt),
    removeProfile: async (id) => store.deleteAIProfile(id),
    listAssignments: async () => store.listAssignments() as Assignment[],
    saveAssignment: async (a) => store.saveAssignment(a),
    removeAssignment: async (id) => store.deleteAssignment(id),
  };

  const profiles = new ProfileManager({
    store: profileStore,
    deps: {
      skills: () => skills.list(),
      // Read straight from the live MCP manager: a server that was just
      // disabled must stop appearing as assignable in the same breath.
      mcpServers: () =>
        mcp.listServers().map((s) => ({
          id: s.id,
          name: s.name,
          enabled: s.enabled,
          unavailableReason: s.status === 'failed' || s.status === 'unhealthy' ? `the server is ${s.status}` : null,
        })),
      model: (modelId: string): ModelDescriptor | null => models.get(modelId) ?? null,
    },
  });
  await profiles.load();

  const scheduler = new DiscoveryScheduler({
    minIntervalMs: 5 * 60_000,
    baseBackoffMs: 30_000,
    maxBackoffMs: 60 * 60_000,
  });

  return { skills, profiles, scheduler };
}

export function newChangeId(): string {
  return `mch_${randomUUID().slice(0, 12)}`;
}
