import { randomUUID } from 'node:crypto';
import { MeridianError, type Capability, type Skill } from '@meridian/shared';

/**
 * Skill storage and validation.
 *
 * A skill is instruction text that gets injected into a model's context, so
 * two things matter more than anything else here: it must be valid before it
 * can be assigned anywhere, and its size must be known, because the cost of a
 * skill is paid on every single request that resolves it.
 */

const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_SLUG = 64;

/**
 * Token estimate for skill content.
 *
 * Deliberately a cheap heuristic rather than a real tokenizer: the number is
 * used to warn about context pressure, and shipping a per-provider tokenizer
 * to make a warning 5% more accurate is not a trade worth making. It is
 * labelled "estimated" everywhere it surfaces.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~3.7 chars/token is a reasonable average across English prose and code,
  // and matches the estimate the executor already uses for partial output.
  return Math.ceil(text.length / 3.7);
}

export interface SkillInput {
  slug: string;
  name: string;
  description?: string;
  content: string;
  tags?: string[];
  requiresCapabilities?: Capability[];
  enabled?: boolean;
  source?: Skill['source'];
}

export function validateSkillInput(input: SkillInput): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.slug)) {
    throw new MeridianError('invalid_request', `"${input.slug}" is not a valid skill slug (lowercase letters, digits and hyphens, max ${MAX_SLUG})`);
  }
  if (!input.name.trim()) throw new MeridianError('invalid_request', 'A skill needs a name');
  if (!input.content.trim()) throw new MeridianError('invalid_request', 'A skill needs content');
  if (Buffer.byteLength(input.content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new MeridianError('invalid_request', `Skill content exceeds ${MAX_CONTENT_BYTES / 1024}KB`);
  }
}

export interface SkillStore {
  list(): Promise<Skill[]>;
  save(skill: Skill): Promise<void>;
  remove(id: string): Promise<void>;
}

export class MemorySkillStore implements SkillStore {
  private readonly skills = new Map<string, Skill>();
  async list() {
    return [...this.skills.values()];
  }
  async save(skill: Skill) {
    this.skills.set(skill.id, skill);
  }
  async remove(id: string) {
    this.skills.delete(id);
  }
}

export class SkillRegistry {
  private readonly store: SkillStore;
  private readonly now: () => number;
  private skills = new Map<string, Skill>();
  private loaded = false;

  constructor(opts: { store?: SkillStore; now?: () => number } = {}) {
    this.store = opts.store ?? new MemorySkillStore();
    this.now = opts.now ?? (() => Date.now());
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    for (const s of await this.store.list()) this.skills.set(s.id, s);
    this.loaded = true;
  }

  list(): Skill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(idOrSlug: string): Skill | null {
    return this.skills.get(idOrSlug) ?? this.list().find((s) => s.slug === idOrSlug) ?? null;
  }

  async create(input: SkillInput): Promise<Skill> {
    validateSkillInput(input);
    if (this.list().some((s) => s.slug === input.slug)) {
      throw new MeridianError('invalid_request', `A skill with slug "${input.slug}" already exists`);
    }
    const at = this.now();
    const skill: Skill = {
      id: `skl_${randomUUID().slice(0, 12)}`,
      slug: input.slug,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      content: input.content,
      tags: input.tags ?? [],
      requiresCapabilities: input.requiresCapabilities ?? [],
      estimatedTokens: estimateTokens(input.content),
      enabled: input.enabled ?? true,
      version: 1,
      source: input.source ?? 'user',
      createdAt: at,
      updatedAt: at,
    };
    this.skills.set(skill.id, skill);
    await this.store.save(skill);
    return skill;
  }

  async update(id: string, patch: Partial<SkillInput>): Promise<Skill> {
    const existing = this.skills.get(id);
    if (!existing) throw new MeridianError('invalid_request', `No skill ${id}`);
    const next: Skill = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
      ...(patch.content !== undefined ? { content: patch.content, estimatedTokens: estimateTokens(patch.content) } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.requiresCapabilities !== undefined ? { requiresCapabilities: patch.requiresCapabilities } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      // A content change is a new version: assignments point at the slug, so
      // the version is how a consumer can tell the text moved underneath it.
      version: patch.content !== undefined && patch.content !== existing.content ? existing.version + 1 : existing.version,
      updatedAt: this.now(),
    };
    if (patch.content !== undefined) validateSkillInput({ ...next, slug: next.slug });
    this.skills.set(id, next);
    await this.store.save(next);
    return next;
  }

  async remove(id: string): Promise<void> {
    this.skills.delete(id);
    await this.store.remove(id);
  }

  /** Import a skill, replacing one with the same slug rather than duplicating. */
  async importSkill(input: SkillInput): Promise<Skill> {
    const existing = this.list().find((s) => s.slug === input.slug);
    if (existing) return this.update(existing.id, input);
    return this.create({ ...input, source: input.source ?? 'imported' });
  }
}
