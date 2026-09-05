import type { InferencePool, PoolMember, Reservation, RoutingMode } from '@meridian/shared';

/** The built-in pools. Each is a routing policy, not just a list of models. */
export const BUILTIN_POOLS: Omit<InferencePool, 'createdAt'>[] = [
  {
    id: 'core',
    name: 'Core',
    description: 'Everyday work. Free and low-cost models that are reliable enough for most tasks.',
    strategy: 'FREE_FIRST',
    members: [],
    fallbackPoolId: 'balanced',
    maxConcurrency: 8,
    dailyBudget: 0,
    builtin: true,
    enabled: true,
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Even weighting across quality, speed and cost.',
    strategy: 'BALANCED',
    members: [],
    fallbackPoolId: 'core',
    maxConcurrency: 8,
    dailyBudget: null,
    builtin: true,
    enabled: true,
  },
  {
    id: 'frontier',
    name: 'Frontier',
    description: 'Strongest available models. Used when quality matters more than cost.',
    strategy: 'QUALITY_FIRST',
    members: [],
    fallbackPoolId: 'balanced',
    maxConcurrency: 4,
    dailyBudget: null,
    builtin: true,
    enabled: true,
  },
  {
    id: 'flagship',
    name: 'Flagship',
    description: 'The single best model per modality, without cost constraints.',
    strategy: 'QUALITY_FIRST',
    members: [],
    fallbackPoolId: 'frontier',
    maxConcurrency: 2,
    dailyBudget: null,
    builtin: true,
    enabled: true,
  },
  {
    id: 'fast',
    name: 'Fast',
    description: 'Lowest latency. Used for interactive work and cheap sub-agent steps.',
    strategy: 'FASTEST',
    members: [],
    fallbackPoolId: 'core',
    maxConcurrency: 12,
    dailyBudget: null,
    builtin: true,
    enabled: true,
  },
  {
    id: 'coding',
    name: 'Coding',
    description: 'Models measured strongest at writing and editing code.',
    strategy: 'QUALITY_FIRST',
    members: [],
    fallbackPoolId: 'balanced',
    maxConcurrency: 6,
    dailyBudget: null,
    builtin: true,
    enabled: true,
  },
  {
    id: 'reasoning',
    name: 'Reasoning',
    description: 'Models measured strongest at planning and multi-step reasoning.',
    strategy: 'QUALITY_FIRST',
    members: [],
    fallbackPoolId: 'balanced',
    maxConcurrency: 4,
    dailyBudget: null,
    builtin: true,
    enabled: true,
  },
  {
    id: 'vision',
    name: 'Vision',
    description: 'Models that accept images alongside text.',
    strategy: 'BALANCED',
    members: [],
    fallbackPoolId: 'balanced',
    maxConcurrency: 4,
    dailyBudget: null,
    builtin: true,
    enabled: true,
  },
  {
    id: 'image',
    name: 'Image',
    description: 'Image generation.',
    strategy: 'FREE_FIRST',
    members: [],
    fallbackPoolId: null,
    maxConcurrency: 4,
    dailyBudget: 0,
    builtin: true,
    enabled: true,
  },
  {
    id: 'video',
    name: 'Video',
    description: 'Video generation. Slow and usually metered.',
    strategy: 'BALANCED',
    members: [],
    fallbackPoolId: null,
    maxConcurrency: 2,
    dailyBudget: null,
    builtin: true,
    enabled: true,
  },
  {
    id: 'local',
    name: 'Local',
    description: 'Only models running on your own hardware. Nothing leaves the machine.',
    strategy: 'LOCAL',
    members: [],
    fallbackPoolId: null,
    maxConcurrency: 4,
    dailyBudget: 0,
    builtin: true,
    enabled: true,
  },
];

export interface PoolUsage {
  poolId: string;
  /** Requests in flight right now. */
  inFlight: number;
  /** USD spent in the current UTC day. */
  spentToday: number;
  /** Day key the spend applies to, as YYYY-MM-DD. */
  day: string;
}

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Pool bookkeeping: membership, concurrency, daily budget and reservations.
 *
 * A reservation is a time-boxed grant of capacity within a pool. During its
 * window it raises the pool's concurrency ceiling to its own and applies its
 * own budget; outside the window it has no effect. Capacity is only ever
 * described as unlimited when the underlying pool genuinely has no ceiling.
 */
export class PoolManager {
  private readonly pools = new Map<string, InferencePool>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly usage = new Map<string, PoolUsage>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  load(pools: InferencePool[], reservations: Reservation[] = []): void {
    for (const p of pools) this.pools.set(p.id, p);
    for (const r of reservations) this.reservations.set(r.id, r);
  }

  upsert(pool: InferencePool): void {
    this.pools.set(pool.id, pool);
  }

  remove(poolId: string): boolean {
    const pool = this.pools.get(poolId);
    if (!pool || pool.builtin) return false;
    return this.pools.delete(poolId);
  }

  get(poolId: string): InferencePool | null {
    return this.pools.get(poolId) ?? null;
  }

  list(): InferencePool[] {
    return [...this.pools.values()].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));
  }

  setMembers(poolId: string, members: PoolMember[]): InferencePool | null {
    const pool = this.pools.get(poolId);
    if (!pool) return null;
    const next = { ...pool, members };
    this.pools.set(poolId, next);
    return next;
  }

  /**
   * Model ids the pool may currently route to, most-preferred first. An empty
   * member list means "any model the pool's strategy selects" rather than
   * "nothing" — a freshly created pool should not be a dead end.
   */
  eligibleModels(poolId: string): { modelIds: string[]; unconstrained: boolean } {
    const pool = this.pools.get(poolId);
    if (!pool) return { modelIds: [], unconstrained: false };

    const active = this.activeReservation(poolId);
    if (active && active.models.length) {
      return { modelIds: active.models, unconstrained: false };
    }
    const members = pool.members.filter((m) => m.enabled).sort((a, b) => b.priority - a.priority);
    if (!members.length) return { modelIds: [], unconstrained: true };
    return { modelIds: members.map((m) => m.modelId), unconstrained: false };
  }

  /** Member priority, normalised to [0,1]; 0.5 when the pool has no members. */
  memberWeight(poolId: string, modelId: string): number {
    const pool = this.pools.get(poolId);
    if (!pool || !pool.members.length) return 0.5;
    const priorities = pool.members.map((m) => m.priority);
    const max = Math.max(...priorities);
    const min = Math.min(...priorities);
    const member = pool.members.find((m) => m.modelId === modelId);
    if (!member) return 0;
    if (max === min) return 1;
    return (member.priority - min) / (max - min);
  }

  /** The pool to spill into, following the chain without looping. */
  fallbackChain(poolId: string, limit = 4): string[] {
    const chain: string[] = [];
    const seen = new Set<string>([poolId]);
    let current = this.pools.get(poolId)?.fallbackPoolId ?? null;
    while (current && chain.length < limit && !seen.has(current)) {
      chain.push(current);
      seen.add(current);
      current = this.pools.get(current)?.fallbackPoolId ?? null;
    }
    return chain;
  }

  /* ---------------------------------------------------------------- */
  /* Reservations                                                     */
  /* ---------------------------------------------------------------- */

  addReservation(r: Reservation): void {
    this.reservations.set(r.id, r);
  }

  cancelReservation(id: string): boolean {
    const r = this.reservations.get(id);
    if (!r) return false;
    this.reservations.set(id, { ...r, status: 'cancelled' });
    return true;
  }

  listReservations(): Reservation[] {
    const now = this.now();
    return [...this.reservations.values()]
      .map((r) => ({ ...r, status: statusOf(r, now) }))
      .sort((a, b) => a.startAt - b.startAt);
  }

  activeReservation(poolId: string): Reservation | null {
    const now = this.now();
    for (const r of this.reservations.values()) {
      if (r.poolId !== poolId) continue;
      if (statusOf(r, now) === 'active') return r;
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Capacity and budget                                              */
  /* ---------------------------------------------------------------- */

  private usageFor(poolId: string): PoolUsage {
    const today = dayKey(this.now());
    let u = this.usage.get(poolId);
    if (!u || u.day !== today) {
      u = { poolId, inFlight: u?.inFlight ?? 0, spentToday: 0, day: today };
      this.usage.set(poolId, u);
    }
    return u;
  }

  /** Effective concurrency ceiling: the reservation's when one is active. */
  concurrencyLimit(poolId: string): number | null {
    const active = this.activeReservation(poolId);
    if (active) return active.maxConcurrency;
    return this.pools.get(poolId)?.maxConcurrency ?? null;
  }

  /** Effective USD ceiling for the current day. */
  budgetLimit(poolId: string): number | null {
    const active = this.activeReservation(poolId);
    if (active && active.budget != null) return active.budget;
    return this.pools.get(poolId)?.dailyBudget ?? null;
  }

  /** Why the pool cannot take another request right now, or null if it can. */
  capacityBlock(poolId: string, estimatedCost: number): string | null {
    const pool = this.pools.get(poolId);
    if (!pool) return `Pool ${poolId} does not exist`;
    if (!pool.enabled) return `Pool ${pool.name} is disabled`;

    const limit = this.concurrencyLimit(poolId);
    const u = this.usageFor(poolId);
    if (limit != null && u.inFlight >= limit) return `Pool ${pool.name} is at its concurrency limit of ${limit}`;

    const budget = this.budgetLimit(poolId);
    if (budget != null && u.spentToday + estimatedCost > budget) {
      return budget === 0
        ? `Pool ${pool.name} is a no-spend pool and this call would cost money`
        : `Pool ${pool.name} would exceed its daily budget of $${budget.toFixed(2)}`;
    }
    return null;
  }

  /** Bracket a call against a pool's concurrency ceiling. */
  acquire(poolId: string): () => void {
    const u = this.usageFor(poolId);
    u.inFlight += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const cur = this.usageFor(poolId);
      cur.inFlight = Math.max(0, cur.inFlight - 1);
    };
  }

  recordSpend(poolId: string, cost: number): void {
    const u = this.usageFor(poolId);
    u.spentToday = Math.round((u.spentToday + cost) * 1e6) / 1e6;
    const active = this.activeReservation(poolId);
    if (active) {
      this.reservations.set(active.id, {
        ...active,
        used: active.used + 1,
        spend: Math.round((active.spend + cost) * 1e6) / 1e6,
      });
    }
  }

  usageOf(poolId: string): PoolUsage {
    return { ...this.usageFor(poolId) };
  }

  /** Strategy the pool applies, falling back to the caller's mode. */
  strategyOf(poolId: string, dflt: RoutingMode): RoutingMode {
    return this.pools.get(poolId)?.strategy ?? dflt;
  }
}

function statusOf(r: Reservation, now: number): Reservation['status'] {
  if (r.status === 'cancelled') return 'cancelled';
  if (now < r.startAt) return 'scheduled';
  if (now >= r.endAt) return 'expired';
  return 'active';
}
