import { isFree, parseModelKey, type Capability, type Modality, type ModelDescriptor, type ModelPerformance, type ModelScores, type ModelStatus } from '@meridian/shared';

export interface ModelFilter {
  modality?: Modality;
  capabilities?: Capability[];
  providerIds?: string[];
  excludeProviderIds?: string[];
  minContext?: number;
  freeOnly?: boolean;
  localOnly?: boolean;
  includeDeprecated?: boolean;
  tags?: string[];
  /** Substring match across id, display name and family. */
  search?: string;
}

/** A model plus everything routing knows about how it behaves. */
export interface ModelView {
  model: ModelDescriptor;
  scores: ModelScores | null;
  performance: ModelPerformance | null;
  status: ModelStatus;
}

/**
 * In-memory index of every known model, its measured quality and its measured
 * performance. Persistence lives in the gateway; this class is pure so the
 * router can be tested without a database.
 */
export class ModelRegistry {
  private readonly models = new Map<string, ModelDescriptor>();
  private readonly scores = new Map<string, ModelScores>();
  private readonly performance = new Map<string, ModelPerformance>();
  private readonly statuses = new Map<string, ModelStatus>();

  upsert(model: ModelDescriptor): void {
    this.models.set(model.id, model);
  }

  upsertMany(models: ModelDescriptor[]): void {
    for (const m of models) this.upsert(m);
  }

  /**
   * Replace every model belonging to a provider. Used after a discovery pass so
   * models the provider has withdrawn disappear instead of lingering forever.
   */
  replaceProviderModels(providerId: string, models: ModelDescriptor[]): { added: string[]; removed: string[] } {
    const existing = new Set([...this.models.values()].filter((m) => m.providerId === providerId).map((m) => m.id));
    const incoming = new Set(models.map((m) => m.id));
    const added = models.filter((m) => !existing.has(m.id)).map((m) => m.id);
    const removed = [...existing].filter((id) => !incoming.has(id));
    for (const id of removed) {
      this.models.delete(id);
      this.statuses.delete(id);
    }
    this.upsertMany(models);
    return { added, removed };
  }

  remove(modelId: string): void {
    this.models.delete(modelId);
    this.scores.delete(modelId);
    this.performance.delete(modelId);
    this.statuses.delete(modelId);
  }

  get(modelId: string): ModelDescriptor | null {
    return this.models.get(modelId) ?? null;
  }

  /**
   * Resolve a user-supplied model reference. Accepts a fully-qualified
   * `provider:model` id, a bare provider model id (unique match wins), or a
   * display name. Returns every match so callers can report ambiguity.
   */
  resolve(ref: string): ModelDescriptor[] {
    const exact = this.models.get(ref);
    if (exact) return [exact];
    const parsed = parseModelKey(ref);
    if (parsed) {
      const byParts = [...this.models.values()].filter(
        (m) => m.providerId === parsed.providerId && m.providerModelId === parsed.providerModelId,
      );
      if (byParts.length) return byParts;
    }
    const lowered = ref.toLowerCase();
    const byModelId = [...this.models.values()].filter((m) => m.providerModelId.toLowerCase() === lowered);
    if (byModelId.length) return byModelId;
    return [...this.models.values()].filter((m) => m.displayName.toLowerCase() === lowered);
  }

  all(): ModelDescriptor[] {
    return [...this.models.values()];
  }

  size(): number {
    return this.models.size;
  }

  setScores(scores: ModelScores): void {
    this.scores.set(scores.modelId, scores);
  }

  getScores(modelId: string): ModelScores | null {
    return this.scores.get(modelId) ?? null;
  }

  setPerformance(perf: ModelPerformance): void {
    this.performance.set(perf.modelId, perf);
  }

  getPerformance(modelId: string): ModelPerformance | null {
    return this.performance.get(modelId) ?? null;
  }

  setStatus(modelId: string, status: ModelStatus): void {
    this.statuses.set(modelId, status);
  }

  getStatus(modelId: string): ModelStatus {
    return this.statuses.get(modelId) ?? 'unknown';
  }

  view(modelId: string): ModelView | null {
    const model = this.models.get(modelId);
    if (!model) return null;
    return {
      model,
      scores: this.scores.get(modelId) ?? null,
      performance: this.performance.get(modelId) ?? null,
      status: this.getStatus(modelId),
    };
  }

  filter(f: ModelFilter): ModelDescriptor[] {
    const search = f.search?.toLowerCase().trim();
    return [...this.models.values()].filter((m) => {
      if (!f.includeDeprecated && m.deprecated) return false;
      if (f.modality && !m.modalities.includes(f.modality)) return false;
      if (f.capabilities?.length && !f.capabilities.every((c) => m.capabilities.includes(c))) return false;
      if (f.providerIds?.length && !f.providerIds.includes(m.providerId)) return false;
      if (f.excludeProviderIds?.length && f.excludeProviderIds.includes(m.providerId)) return false;
      if (f.minContext != null && (m.contextLength ?? 0) < f.minContext) return false;
      if (f.freeOnly && !isFree(m.pricing)) return false;
      if (f.localOnly && m.pricing.kind !== 'LOCAL') return false;
      if (f.tags?.length && !f.tags.some((t) => m.tags.includes(t))) return false;
      if (search) {
        const hay = `${m.id} ${m.displayName} ${m.family ?? ''} ${m.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
  }

  views(f: ModelFilter): ModelView[] {
    return this.filter(f).map((m) => this.view(m.id)!);
  }

  clear(): void {
    this.models.clear();
    this.scores.clear();
    this.performance.clear();
    this.statuses.clear();
  }
}
