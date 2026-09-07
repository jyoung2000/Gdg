import {
  hintOf,
  newId,
  redact,
  type AgentTask,
  type AuditLogEntry,
  type CredentialPool,
  type CredentialRecord,
  type CredentialScope,
  type CredentialSource,
  type GenerationJob,
  type InferencePool,
  type ModelDescriptor,
  type ModelPerformance,
  type ModelScores,
  type PrivacyMode,
  type ProviderHealth,
  type Reservation,
  type ResolvedCredential,
  type Role,
  type RoutingMode,
  type TaskStep,
  type ToolCallRecord,
  type Usage,
  type UsageRecord,
  type User,
  type UserPreferences,
  type Workspace,
} from '@meridian/shared';
import type { CredentialStore } from '@meridian/routing-sdk';
import type { WorkspaceCheckpoint } from '@meridian/agent-sdk';
import { bool, int, json, type DB } from './database.js';
import { SecretBox, generateApiKey, hashApiKey, hashPassword, verifyPassword } from './crypto.js';

type Row = Record<string, unknown>;

/**
 * Every read and write of durable state.
 *
 * The store is deliberately the only place that knows SQL. Domain types cross
 * this boundary in both directions; rows never leave it. That is what lets the
 * router and agent runtime be tested against in-memory fakes.
 */
export class Store implements CredentialStore {
  readonly db: DB;
  private readonly box: SecretBox;

  constructor(db: DB, box: SecretBox) {
    this.db = db;
    this.box = box;
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                         */
  /* ---------------------------------------------------------------- */

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? json<T>(row.value, fallback) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), Date.now());
  }

  /* ---------------------------------------------------------------- */
  /* Users, preferences, API keys                                     */
  /* ---------------------------------------------------------------- */

  createUser(email: string, name: string, role: Role, password?: string): User {
    const user: User = { id: newId('usr'), email, name, role, createdAt: Date.now(), lastSeenAt: null };
    this.db
      .prepare('INSERT INTO users (id, email, name, role, password_hash, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)')
      .run(user.id, email, name, role, password ? hashPassword(password) : null, user.createdAt, null);
    this.setPreferences(defaultPreferences(user.id));
    return user;
  }

  getUser(id: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    return row ? toUser(row) : null;
  }

  getUserByEmail(email: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as Row | undefined;
    return row ? toUser(row) : null;
  }

  listUsers(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at').all() as Row[]).map(toUser);
  }

  countUsers(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  authenticate(email: string, password: string): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as Row | undefined;
    if (!row || typeof row.password_hash !== 'string') return null;
    if (!verifyPassword(password, row.password_hash)) return null;
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), row.id);
    return toUser(row);
  }

  getPreferences(userId: string): UserPreferences | null {
    const row = this.db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as Row | undefined;
    if (!row) return null;
    return {
      userId: String(row.user_id),
      routingMode: String(row.routing_mode) as RoutingMode,
      privacyMode: String(row.privacy_mode) as PrivacyMode,
      preferredModels: json<string[]>(row.preferred_models as string, []),
      preferredProviders: json<string[]>(row.preferred_providers as string, []),
      preferredPool: (row.preferred_pool as string) ?? null,
      theme: String(row.theme) as UserPreferences['theme'],
      reduceMotion: bool(row.reduce_motion),
      layout: json<Record<string, unknown>>(row.layout as string, {}),
      allowPaid: bool(row.allow_paid),
      maxCostPerTask: (row.max_cost_per_task as number) ?? null,
      updatedAt: Number(row.updated_at),
    };
  }

  setPreferences(prefs: UserPreferences): void {
    this.db
      .prepare(
        `INSERT INTO user_preferences (user_id, routing_mode, privacy_mode, preferred_models, preferred_providers,
           preferred_pool, theme, reduce_motion, layout, allow_paid, max_cost_per_task, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET
           routing_mode=excluded.routing_mode, privacy_mode=excluded.privacy_mode,
           preferred_models=excluded.preferred_models, preferred_providers=excluded.preferred_providers,
           preferred_pool=excluded.preferred_pool, theme=excluded.theme, reduce_motion=excluded.reduce_motion,
           layout=excluded.layout, allow_paid=excluded.allow_paid, max_cost_per_task=excluded.max_cost_per_task,
           updated_at=excluded.updated_at`,
      )
      .run(
        prefs.userId,
        prefs.routingMode,
        prefs.privacyMode,
        JSON.stringify(prefs.preferredModels),
        JSON.stringify(prefs.preferredProviders),
        prefs.preferredPool,
        prefs.theme,
        int(prefs.reduceMotion),
        JSON.stringify(prefs.layout),
        int(prefs.allowPaid),
        prefs.maxCostPerTask,
        Date.now(),
      );
  }

  /** Returns the plaintext key ONCE. It is never recoverable afterwards. */
  createApiKey(userId: string | null, name: string, scopes: string[] = ['*']): { id: string; key: string; hint: string } {
    const key = generateApiKey();
    const id = newId('key');
    const hint = hintOf(key);
    this.db
      .prepare('INSERT INTO api_keys (id, user_id, name, key_hash, hint, scopes, enabled, created_at) VALUES (?,?,?,?,?,?,1,?)')
      .run(id, userId, name, hashApiKey(key), hint, JSON.stringify(scopes), Date.now());
    return { id, key, hint };
  }

  verifyApiKey(key: string): { id: string; userId: string | null; scopes: string[] } | null {
    const row = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND enabled = 1').get(hashApiKey(key)) as Row | undefined;
    if (!row) return null;
    if (row.expires_at != null && Number(row.expires_at) <= Date.now()) return null;
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
    return { id: String(row.id), userId: (row.user_id as string) ?? null, scopes: json<string[]>(row.scopes as string, ['*']) };
  }

  listApiKeys(): { id: string; name: string; hint: string; enabled: boolean; createdAt: number; lastUsedAt: number | null }[] {
    return (this.db.prepare('SELECT id, name, hint, enabled, created_at, last_used_at FROM api_keys ORDER BY created_at DESC').all() as Row[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      hint: String(r.hint),
      enabled: bool(r.enabled),
      createdAt: Number(r.created_at),
      lastUsedAt: (r.last_used_at as number) ?? null,
    }));
  }

  deleteApiKey(id: string): boolean {
    return this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0;
  }

  /* ---------------------------------------------------------------- */
  /* Credentials — CredentialStore implementation                     */
  /* ---------------------------------------------------------------- */

  addCredential(input: {
    providerId: string;
    secret: string | null;
    scope: CredentialScope;
    source: CredentialSource;
    label: string;
    userId?: string | null;
    workspaceId?: string | null;
    poolId?: string | null;
    priority?: number;
    maxConcurrency?: number | null;
    expiresAt?: number | null;
  }): CredentialRecord {
    const record: CredentialRecord = {
      id: newId('cred'),
      providerId: input.providerId,
      scope: input.scope,
      source: input.source,
      label: input.label,
      userId: input.userId ?? null,
      workspaceId: input.workspaceId ?? null,
      poolId: input.poolId ?? null,
      priority: input.priority ?? 100,
      enabled: true,
      hint: input.secret ? hintOf(input.secret) : '',
      maxConcurrency: input.maxConcurrency ?? null,
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO credentials (id, provider_id, scope, source, label, user_id, workspace_id, pool_id, priority,
           enabled, hint, ciphertext, max_concurrency, expires_at, last_used_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?,?,NULL,?)`,
      )
      .run(
        record.id,
        record.providerId,
        record.scope,
        record.source,
        record.label,
        record.userId,
        record.workspaceId,
        record.poolId,
        record.priority,
        record.hint,
        input.secret ? this.box.seal(input.secret) : null,
        record.maxConcurrency,
        record.expiresAt,
        record.createdAt,
      );
    return record;
  }

  /** Replace the secret on an existing credential without changing its identity. */
  updateCredentialSecret(id: string, secret: string): boolean {
    return (
      this.db
        .prepare('UPDATE credentials SET ciphertext = ?, hint = ? WHERE id = ?')
        .run(this.box.seal(secret), hintOf(secret), id).changes > 0
    );
  }

  setCredentialEnabled(id: string, enabled: boolean): boolean {
    return this.db.prepare('UPDATE credentials SET enabled = ? WHERE id = ?').run(int(enabled), id).changes > 0;
  }

  deleteCredential(id: string): boolean {
    return this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id).changes > 0;
  }

  listForProvider(providerId: string): ResolvedCredential[] {
    return (this.db.prepare('SELECT * FROM credentials WHERE provider_id = ? AND enabled = 1').all(providerId) as Row[]).map((r) =>
      this.toResolved(r),
    );
  }

  getById(id: string): ResolvedCredential | null {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row | undefined;
    return row ? this.toResolved(row) : null;
  }

  pool(poolId: string): CredentialPool | null {
    const row = this.db.prepare('SELECT * FROM credential_pools WHERE id = ?').get(poolId) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      providerId: String(row.provider_id),
      name: String(row.name),
      strategy: String(row.strategy) as CredentialPool['strategy'],
      enabled: bool(row.enabled),
      createdAt: Number(row.created_at),
    };
  }

  markUsed(credentialId: string, at: number): void {
    this.db.prepare('UPDATE credentials SET last_used_at = ? WHERE id = ?').run(at, credentialId);
  }

  /** Public records only — the secret is stripped before it can leave the store. */
  /** One credential's record, secret withheld. Used for ownership checks. */
  getCredential(id: string): CredentialRecord | null {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const { secret: _secret, ...rest } = this.toResolved(row);
    return rest;
  }

  listCredentials(): CredentialRecord[] {
    return (this.db.prepare('SELECT * FROM credentials ORDER BY provider_id, priority DESC').all() as Row[]).map((r) => {
      const { secret: _secret, ...rest } = this.toResolved(r);
      return rest;
    });
  }

  addCredentialPool(providerId: string, name: string, strategy: CredentialPool['strategy']): CredentialPool {
    const p: CredentialPool = { id: newId('cpool'), providerId, name, strategy, enabled: true, createdAt: Date.now() };
    this.db
      .prepare('INSERT INTO credential_pools (id, provider_id, name, strategy, enabled, created_at) VALUES (?,?,?,?,1,?)')
      .run(p.id, p.providerId, p.name, p.strategy, p.createdAt);
    return p;
  }

  listCredentialPools(): CredentialPool[] {
    return (this.db.prepare('SELECT * FROM credential_pools ORDER BY provider_id, name').all() as Row[]).map((r) => ({
      id: String(r.id),
      providerId: String(r.provider_id),
      name: String(r.name),
      strategy: String(r.strategy) as CredentialPool['strategy'],
      enabled: bool(r.enabled),
      createdAt: Number(r.created_at),
    }));
  }

  private toResolved(row: Row): ResolvedCredential {
    return {
      id: String(row.id),
      providerId: String(row.provider_id),
      scope: String(row.scope) as CredentialScope,
      source: String(row.source) as CredentialSource,
      label: String(row.label),
      userId: (row.user_id as string) ?? null,
      workspaceId: (row.workspace_id as string) ?? null,
      poolId: (row.pool_id as string) ?? null,
      priority: Number(row.priority),
      enabled: bool(row.enabled),
      hint: String(row.hint),
      maxConcurrency: (row.max_concurrency as number) ?? null,
      expiresAt: (row.expires_at as number) ?? null,
      lastUsedAt: (row.last_used_at as number) ?? null,
      createdAt: Number(row.created_at),
      secret: this.box.open((row.ciphertext as string) ?? null),
    };
  }

  /* ---------------------------------------------------------------- */
  /* Providers                                                        */
  /* ---------------------------------------------------------------- */

  saveProviderOverride(id: string, patch: { enabled?: boolean; trust?: string | null; baseUrl?: string | null; dataUse?: unknown; verifiedAt?: number | null }): void {
    const existing = this.db.prepare('SELECT id FROM providers WHERE id = ?').get(id);
    if (!existing) {
      this.db
        .prepare('INSERT INTO providers (id, descriptor, enabled, trust, base_url, data_use, verified_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, '{}', int(patch.enabled ?? true), patch.trust ?? null, patch.baseUrl ?? null, patch.dataUse ? JSON.stringify(patch.dataUse) : null, patch.verifiedAt ?? null, Date.now());
      return;
    }
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.enabled !== undefined) { sets.push('enabled = ?'); args.push(int(patch.enabled)); }
    if (patch.trust !== undefined) { sets.push('trust = ?'); args.push(patch.trust); }
    if (patch.baseUrl !== undefined) { sets.push('base_url = ?'); args.push(patch.baseUrl); }
    if (patch.dataUse !== undefined) { sets.push('data_use = ?'); args.push(JSON.stringify(patch.dataUse)); }
    if (patch.verifiedAt !== undefined) { sets.push('verified_at = ?'); args.push(patch.verifiedAt); }
    if (!sets.length) return;
    sets.push('updated_at = ?');
    args.push(Date.now(), id);
    this.db.prepare(`UPDATE providers SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  listProviderOverrides(): { id: string; enabled: boolean; trust: string | null; baseUrl: string | null; dataUse: unknown; verifiedAt: number | null }[] {
    return (this.db.prepare('SELECT * FROM providers').all() as Row[]).map((r) => ({
      id: String(r.id),
      enabled: bool(r.enabled),
      trust: (r.trust as string) ?? null,
      baseUrl: (r.base_url as string) ?? null,
      dataUse: r.data_use ? json(r.data_use as string, null) : null,
      verifiedAt: (r.verified_at as number) ?? null,
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Models, scores, performance, benchmarks                          */
  /* ---------------------------------------------------------------- */

  upsertModels(models: ModelDescriptor[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO models (id, provider_id, provider_model_id, display_name, family, modalities, capabilities,
         context_length, max_output_tokens, pricing, discovered, deprecated, tags, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         display_name=excluded.display_name, family=excluded.family, modalities=excluded.modalities,
         capabilities=excluded.capabilities, context_length=excluded.context_length,
         max_output_tokens=excluded.max_output_tokens, pricing=excluded.pricing,
         discovered=excluded.discovered, deprecated=excluded.deprecated, tags=excluded.tags,
         updated_at=excluded.updated_at`,
    );
    const tx = this.db.transaction((rows: ModelDescriptor[]) => {
      for (const m of rows) {
        stmt.run(
          m.id, m.providerId, m.providerModelId, m.displayName, m.family,
          JSON.stringify(m.modalities), JSON.stringify(m.capabilities),
          m.contextLength, m.maxOutputTokens, JSON.stringify(m.pricing),
          int(m.discovered), int(m.deprecated), JSON.stringify(m.tags), m.updatedAt,
        );
      }
    });
    tx(models);
  }

  deleteModels(ids: string[]): void {
    if (!ids.length) return;
    const stmt = this.db.prepare('DELETE FROM models WHERE id = ?');
    this.db.transaction((rows: string[]) => { for (const id of rows) stmt.run(id); })(ids);
  }

  listModels(): ModelDescriptor[] {
    return (this.db.prepare('SELECT * FROM models').all() as Row[]).map(toModel);
  }

  setModelScores(s: ModelScores): void {
    this.db
      .prepare(
        `INSERT INTO model_scores (model_id, coding, reasoning, general, tool_use, vision, stability, samples, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(model_id) DO UPDATE SET coding=excluded.coding, reasoning=excluded.reasoning,
           general=excluded.general, tool_use=excluded.tool_use, vision=excluded.vision,
           stability=excluded.stability, samples=excluded.samples, updated_at=excluded.updated_at`,
      )
      .run(s.modelId, s.coding, s.reasoning, s.general, s.toolUse, s.vision, s.stability, s.samples, s.updatedAt);
  }

  listModelScores(): ModelScores[] {
    return (this.db.prepare('SELECT * FROM model_scores').all() as Row[]).map((r) => ({
      modelId: String(r.model_id),
      coding: (r.coding as number) ?? null,
      reasoning: (r.reasoning as number) ?? null,
      general: (r.general as number) ?? null,
      toolUse: (r.tool_use as number) ?? null,
      vision: (r.vision as number) ?? null,
      stability: (r.stability as number) ?? null,
      samples: Number(r.samples),
      updatedAt: Number(r.updated_at),
    }));
  }

  setModelPerformance(p: ModelPerformance): void {
    this.db
      .prepare(
        `INSERT INTO model_performance (model_id, ttft_ms, latency_ms, p95_latency_ms, jitter_ms, tokens_per_second, uptime, samples, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(model_id) DO UPDATE SET ttft_ms=excluded.ttft_ms, latency_ms=excluded.latency_ms,
           p95_latency_ms=excluded.p95_latency_ms, jitter_ms=excluded.jitter_ms,
           tokens_per_second=excluded.tokens_per_second, uptime=excluded.uptime,
           samples=excluded.samples, updated_at=excluded.updated_at`,
      )
      .run(p.modelId, p.ttftMs, p.latencyMs, p.p95LatencyMs, p.jitterMs, p.tokensPerSecond, p.uptime, p.samples, p.updatedAt);
  }

  listModelPerformance(): ModelPerformance[] {
    return (this.db.prepare('SELECT * FROM model_performance').all() as Row[]).map((r) => ({
      modelId: String(r.model_id),
      ttftMs: (r.ttft_ms as number) ?? null,
      latencyMs: (r.latency_ms as number) ?? null,
      p95LatencyMs: (r.p95_latency_ms as number) ?? null,
      jitterMs: (r.jitter_ms as number) ?? null,
      tokensPerSecond: (r.tokens_per_second as number) ?? null,
      uptime: (r.uptime as number) ?? null,
      samples: Number(r.samples),
      updatedAt: Number(r.updated_at),
    }));
  }

  addBenchmarkResults(rows: { modelId: string; caseId: string; dimension: string; score: number; latencyMs: number; ttftMs: number | null; outputTokens: number; tokensPerSecond: number | null; error: string | null; at: number }[]): void {
    const stmt = this.db.prepare(
      'INSERT INTO benchmarks (id, model_id, case_id, dimension, score, latency_ms, ttft_ms, output_tokens, tokens_per_second, error, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    );
    this.db.transaction((rs: typeof rows) => {
      for (const r of rs) stmt.run(newId('bm'), r.modelId, r.caseId, r.dimension, r.score, r.latencyMs, r.ttftMs, r.outputTokens, r.tokensPerSecond, r.error, r.at);
    })(rows);
  }

  listBenchmarks(modelId?: string, limit = 200): Row[] {
    return modelId
      ? (this.db.prepare('SELECT * FROM benchmarks WHERE model_id = ? ORDER BY at DESC LIMIT ?').all(modelId, limit) as Row[])
      : (this.db.prepare('SELECT * FROM benchmarks ORDER BY at DESC LIMIT ?').all(limit) as Row[]);
  }

  /* ---------------------------------------------------------------- */
  /* Health                                                           */
  /* ---------------------------------------------------------------- */

  saveHealth(h: ProviderHealth): void {
    this.db
      .prepare(
        `INSERT INTO provider_health (provider_id, state, circuit, consecutive_failures, success_count, failure_count,
           latency_ms, error_rate, cooldown_until, last_checked_at, last_error_at, last_error)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(provider_id) DO UPDATE SET state=excluded.state, circuit=excluded.circuit,
           consecutive_failures=excluded.consecutive_failures, success_count=excluded.success_count,
           failure_count=excluded.failure_count, latency_ms=excluded.latency_ms, error_rate=excluded.error_rate,
           cooldown_until=excluded.cooldown_until, last_checked_at=excluded.last_checked_at,
           last_error_at=excluded.last_error_at, last_error=excluded.last_error`,
      )
      .run(h.providerId, h.state, h.circuit, h.consecutiveFailures, h.successCount, h.failureCount, h.latencyMs, h.errorRate, h.cooldownUntil, h.lastCheckedAt, h.lastErrorAt, h.lastError);
  }

  listHealth(): ProviderHealth[] {
    return (this.db.prepare('SELECT * FROM provider_health').all() as Row[]).map((r) => ({
      providerId: String(r.provider_id),
      state: String(r.state) as ProviderHealth['state'],
      circuit: String(r.circuit) as ProviderHealth['circuit'],
      consecutiveFailures: Number(r.consecutive_failures),
      successCount: Number(r.success_count),
      failureCount: Number(r.failure_count),
      latencyMs: (r.latency_ms as number) ?? null,
      errorRate: Number(r.error_rate),
      cooldownUntil: (r.cooldown_until as number) ?? null,
      lastCheckedAt: (r.last_checked_at as number) ?? null,
      lastErrorAt: (r.last_error_at as number) ?? null,
      lastError: (r.last_error as string) ?? null,
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Pools and reservations                                           */
  /* ---------------------------------------------------------------- */

  savePool(p: InferencePool): void {
    this.db
      .prepare(
        `INSERT INTO inference_pools (id, name, description, strategy, members, fallback_pool_id, max_concurrency, daily_budget, builtin, enabled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, strategy=excluded.strategy,
           members=excluded.members, fallback_pool_id=excluded.fallback_pool_id, max_concurrency=excluded.max_concurrency,
           daily_budget=excluded.daily_budget, enabled=excluded.enabled`,
      )
      .run(p.id, p.name, p.description, p.strategy, JSON.stringify(p.members), p.fallbackPoolId, p.maxConcurrency, p.dailyBudget, int(p.builtin), int(p.enabled), p.createdAt);
  }

  listPools(): InferencePool[] {
    return (this.db.prepare('SELECT * FROM inference_pools').all() as Row[]).map((r) => ({
      id: String(r.id),
      name: String(r.name),
      description: (r.description as string) ?? null,
      strategy: String(r.strategy) as RoutingMode,
      members: json<InferencePool['members']>(r.members as string, []),
      fallbackPoolId: (r.fallback_pool_id as string) ?? null,
      maxConcurrency: (r.max_concurrency as number) ?? null,
      dailyBudget: (r.daily_budget as number) ?? null,
      builtin: bool(r.builtin),
      enabled: bool(r.enabled),
      createdAt: Number(r.created_at),
    }));
  }

  deletePool(id: string): boolean {
    return this.db.prepare('DELETE FROM inference_pools WHERE id = ? AND builtin = 0').run(id).changes > 0;
  }

  saveReservation(r: Reservation): void {
    this.db
      .prepare(
        `INSERT INTO reservations (id, pool_id, label, start_at, end_at, max_concurrency, budget, fallback_pool_id, models, status, used, spend, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, start_at=excluded.start_at, end_at=excluded.end_at,
           max_concurrency=excluded.max_concurrency, budget=excluded.budget, fallback_pool_id=excluded.fallback_pool_id,
           models=excluded.models, status=excluded.status, used=excluded.used, spend=excluded.spend`,
      )
      .run(r.id, r.poolId, r.label, r.startAt, r.endAt, r.maxConcurrency, r.budget, r.fallbackPoolId, JSON.stringify(r.models), r.status, r.used, r.spend, r.createdAt);
  }

  listReservations(): Reservation[] {
    return (this.db.prepare('SELECT * FROM reservations ORDER BY start_at DESC').all() as Row[]).map((r) => ({
      id: String(r.id),
      poolId: String(r.pool_id),
      label: String(r.label),
      startAt: Number(r.start_at),
      endAt: Number(r.end_at),
      maxConcurrency: Number(r.max_concurrency),
      budget: (r.budget as number) ?? null,
      fallbackPoolId: (r.fallback_pool_id as string) ?? null,
      models: json<string[]>(r.models as string, []),
      status: String(r.status) as Reservation['status'],
      used: Number(r.used),
      spend: Number(r.spend),
      createdAt: Number(r.created_at),
    }));
  }

  deleteReservation(id: string): boolean {
    return this.db.prepare('DELETE FROM reservations WHERE id = ?').run(id).changes > 0;
  }

  /* ---------------------------------------------------------------- */
  /* Workspaces                                                       */
  /* ---------------------------------------------------------------- */

  createWorkspace(w: Workspace): Workspace {
    this.db
      .prepare(
        'INSERT INTO workspaces (id, name, path, repo_url, branch, privacy_mode, default_mode, created_at, last_opened_at, user_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(w.id, w.name, w.path, w.repoUrl, w.branch, w.privacyMode, w.defaultMode, w.createdAt, w.lastOpenedAt, w.userId ?? null);
    return w;
  }

  getWorkspace(id: string): Workspace | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Row | undefined;
    return row ? toWorkspace(row) : null;
  }

  listWorkspaces(): Workspace[] {
    return (this.db.prepare('SELECT * FROM workspaces ORDER BY COALESCE(last_opened_at, created_at) DESC').all() as Row[]).map(toWorkspace);
  }

  touchWorkspace(id: string): void {
    this.db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?').run(Date.now(), id);
  }

  updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'name' | 'privacyMode' | 'defaultMode' | 'branch'>>): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name); }
    if (patch.privacyMode !== undefined) { sets.push('privacy_mode = ?'); args.push(patch.privacyMode); }
    if (patch.defaultMode !== undefined) { sets.push('default_mode = ?'); args.push(patch.defaultMode); }
    if (patch.branch !== undefined) { sets.push('branch = ?'); args.push(patch.branch); }
    if (!sets.length) return;
    args.push(id);
    this.db.prepare(`UPDATE workspaces SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }

  deleteWorkspace(id: string): boolean {
    return this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id).changes > 0;
  }

  /* ---------------------------------------------------------------- */
  /* Tasks                                                            */
  /* ---------------------------------------------------------------- */

  saveTask(t: AgentTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace_id, user_id, title, request, status, lane, mode, created_at, started_at, finished_at, error, estimate, usage, result)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, started_at=excluded.started_at,
           finished_at=excluded.finished_at, error=excluded.error, estimate=excluded.estimate,
           usage=excluded.usage, result=excluded.result, title=excluded.title`,
      )
      .run(t.id, t.workspaceId, t.userId, t.title, t.request, t.status, t.lane, t.mode, t.createdAt, t.startedAt, t.finishedAt, t.error, t.estimate ? JSON.stringify(t.estimate) : null, JSON.stringify(t.usage), t.result);
  }

  getTask(id: string): AgentTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return row ? toTask(row) : null;
  }

  listTasks(workspaceId?: string, limit = 100): AgentTask[] {
    const rows = workspaceId
      ? (this.db.prepare('SELECT * FROM tasks WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?').all(workspaceId, limit) as Row[])
      : (this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]);
    return rows.map(toTask);
  }

  saveStep(s: TaskStep): void {
    this.db
      .prepare(
        `INSERT INTO task_steps (id, task_id, label, role, status, started_at, finished_at, summary, model_id, provider_id,
           latency_ms, usage, tool_call_count, files_touched, error, fallback_events, step_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, started_at=excluded.started_at, finished_at=excluded.finished_at,
           summary=excluded.summary, model_id=excluded.model_id, provider_id=excluded.provider_id, latency_ms=excluded.latency_ms,
           usage=excluded.usage, tool_call_count=excluded.tool_call_count, files_touched=excluded.files_touched,
           error=excluded.error, fallback_events=excluded.fallback_events`,
      )
      .run(s.id, s.taskId, s.label, s.role, s.status, s.startedAt, s.finishedAt, s.summary, s.modelId, s.providerId, s.latencyMs, s.usage ? JSON.stringify(s.usage) : null, s.toolCallCount, JSON.stringify(s.filesTouched), s.error, JSON.stringify(s.fallbackEvents), s.order);
  }

  listSteps(taskId: string): TaskStep[] {
    return (this.db.prepare('SELECT * FROM task_steps WHERE task_id = ? ORDER BY step_order').all(taskId) as Row[]).map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      label: String(r.label),
      role: String(r.role) as TaskStep['role'],
      status: String(r.status) as TaskStep['status'],
      startedAt: (r.started_at as number) ?? null,
      finishedAt: (r.finished_at as number) ?? null,
      summary: (r.summary as string) ?? null,
      modelId: (r.model_id as string) ?? null,
      providerId: (r.provider_id as string) ?? null,
      latencyMs: (r.latency_ms as number) ?? null,
      usage: r.usage ? json<Usage>(r.usage as string, { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 }) : null,
      toolCallCount: Number(r.tool_call_count),
      filesTouched: json<string[]>(r.files_touched as string, []),
      error: (r.error as string) ?? null,
      fallbackEvents: json<TaskStep['fallbackEvents']>(r.fallback_events as string, []),
      order: Number(r.step_order),
    }));
  }

  /** Tool arguments are redacted before persistence — they can carry secrets. */
  saveToolCall(c: ToolCallRecord): void {
    this.db
      .prepare('INSERT INTO tool_calls (id, task_id, step_id, name, arguments, result, error, duration_ms, at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(c.id, c.taskId, c.stepId, c.name, JSON.stringify(redact(c.arguments)), c.result ? redact(c.result) : null, c.error, c.durationMs, c.at);
  }

  listToolCalls(taskId: string): ToolCallRecord[] {
    return (this.db.prepare('SELECT * FROM tool_calls WHERE task_id = ? ORDER BY at').all(taskId) as Row[]).map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      stepId: (r.step_id as string) ?? null,
      name: String(r.name),
      arguments: json<Record<string, unknown>>(r.arguments as string, {}),
      result: (r.result as string) ?? null,
      error: (r.error as string) ?? null,
      durationMs: Number(r.duration_ms),
      at: Number(r.at),
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Usage, generations, audit                                        */
  /* ---------------------------------------------------------------- */

  recordUsage(u: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO usage (id, at, request_id, user_id, workspace_id, task_id, agent_role, provider_id, model_id,
           credential_id, pool_id, modality, task_type, prompt_tokens, completion_tokens, cost, latency_ms, ttft_ms,
           success, fallback_count, error_code)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(u.id, u.at, u.requestId, u.userId, u.workspaceId, u.taskId, u.agentRole, u.providerId, u.modelId, u.credentialId, u.poolId, u.modality, u.taskType, u.promptTokens, u.completionTokens, u.cost, u.latencyMs, u.ttftMs, int(u.success), u.fallbackCount, u.errorCode);
  }

  listUsage(opts: { since?: number; limit?: number; modelId?: string; taskId?: string; userId?: string | null } = {}): UsageRecord[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (opts.since != null) { clauses.push('at >= ?'); args.push(opts.since); }
    if (opts.userId !== undefined) {
      // Explicitly including rows with no user: those are the instance's own
      // calls, not another person's, and hiding them would make a single-user
      // install look empty.
      clauses.push('(user_id = ? OR user_id IS NULL)');
      args.push(opts.userId);
    }
    if (opts.modelId) { clauses.push('model_id = ?'); args.push(opts.modelId); }
    if (opts.taskId) { clauses.push('task_id = ?'); args.push(opts.taskId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    args.push(opts.limit ?? 500);
    return (this.db.prepare(`SELECT * FROM usage ${where} ORDER BY at DESC LIMIT ?`).all(...args) as Row[]).map((r) => ({
      id: String(r.id),
      at: Number(r.at),
      requestId: String(r.request_id),
      userId: (r.user_id as string) ?? null,
      workspaceId: (r.workspace_id as string) ?? null,
      taskId: (r.task_id as string) ?? null,
      agentRole: (r.agent_role as UsageRecord['agentRole']) ?? null,
      providerId: String(r.provider_id),
      modelId: String(r.model_id),
      credentialId: (r.credential_id as string) ?? null,
      poolId: (r.pool_id as string) ?? null,
      modality: r.modality as UsageRecord['modality'],
      taskType: r.task_type as UsageRecord['taskType'],
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      cost: Number(r.cost),
      latencyMs: Number(r.latency_ms),
      ttftMs: (r.ttft_ms as number) ?? null,
      success: bool(r.success),
      fallbackCount: Number(r.fallback_count),
      errorCode: (r.error_code as string) ?? null,
    }));
  }

  /** Aggregates for the usage screen, computed in SQL rather than in memory. */
  /**
   * Usage totals since a moment, optionally for one user.
   *
   * `userId` undefined means the whole instance, which is what an administrator
   * sees; a value narrows to that user's rows plus the instance's own unattributed
   * calls, so a shared install does not show one person another's spend.
   */
  usageSummary(since: number, userId?: string | null): {
    totals: { requests: number; tokens: number; cost: number; failures: number; fallbacks: number };
    byModel: { modelId: string; providerId: string; requests: number; tokens: number; cost: number; avgLatency: number; successRate: number }[];
    byDay: { day: string; requests: number; tokens: number; cost: number }[];
    byProvider: { providerId: string; requests: number; cost: number; errorRate: number }[];
  } {
    const totals = this.db
      .prepare('SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens, COALESCE(SUM(cost),0) AS cost, SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failures, COALESCE(SUM(fallback_count),0) AS fallbacks FROM usage WHERE at >= ? AND (? IS NULL OR user_id = ? OR user_id IS NULL)')
      .get(since, userId ?? null, userId ?? null) as Row;
    const byModel = (this.db
      .prepare(
        `SELECT model_id, provider_id, COUNT(*) AS requests, COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens,
           COALESCE(SUM(cost),0) AS cost, AVG(latency_ms) AS avg_latency,
           AVG(CASE WHEN success=1 THEN 1.0 ELSE 0.0 END) AS success_rate
         FROM usage WHERE at >= ? AND (? IS NULL OR user_id = ? OR user_id IS NULL) GROUP BY model_id, provider_id ORDER BY requests DESC LIMIT 50`,
      )
      .all(since, userId ?? null, userId ?? null) as Row[]).map((r) => ({
      modelId: String(r.model_id),
      providerId: String(r.provider_id),
      requests: Number(r.requests),
      tokens: Number(r.tokens),
      cost: Number(r.cost),
      avgLatency: Number(r.avg_latency ?? 0),
      successRate: Number(r.success_rate ?? 0),
    }));
    const byDay = (this.db
      .prepare(
        `SELECT date(at/1000, 'unixepoch') AS day, COUNT(*) AS requests,
           COALESCE(SUM(prompt_tokens+completion_tokens),0) AS tokens, COALESCE(SUM(cost),0) AS cost
         FROM usage WHERE at >= ? AND (? IS NULL OR user_id = ? OR user_id IS NULL) GROUP BY day ORDER BY day`,
      )
      .all(since, userId ?? null, userId ?? null) as Row[]).map((r) => ({ day: String(r.day), requests: Number(r.requests), tokens: Number(r.tokens), cost: Number(r.cost) }));
    const byProvider = (this.db
      .prepare(
        `SELECT provider_id, COUNT(*) AS requests, COALESCE(SUM(cost),0) AS cost,
           AVG(CASE WHEN success=0 THEN 1.0 ELSE 0.0 END) AS error_rate
         FROM usage WHERE at >= ? AND (? IS NULL OR user_id = ? OR user_id IS NULL) GROUP BY provider_id ORDER BY requests DESC`,
      )
      .all(since, userId ?? null, userId ?? null) as Row[]).map((r) => ({ providerId: String(r.provider_id), requests: Number(r.requests), cost: Number(r.cost), errorRate: Number(r.error_rate ?? 0) }));

    return {
      totals: {
        requests: Number(totals.requests ?? 0),
        tokens: Number(totals.tokens ?? 0),
        cost: Number(totals.cost ?? 0),
        failures: Number(totals.failures ?? 0),
        fallbacks: Number(totals.fallbacks ?? 0),
      },
      byModel,
      byDay,
      byProvider,
    };
  }

  saveGenerationJob(j: GenerationJob): void {
    this.db
      .prepare(
        `INSERT INTO generation_jobs (id, user_id, workspace_id, modality, status, prompt, params, model_id, provider_id, assets, error, progress, cost, created_at, started_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, model_id=excluded.model_id, provider_id=excluded.provider_id,
           assets=excluded.assets, error=excluded.error, progress=excluded.progress, cost=excluded.cost,
           started_at=excluded.started_at, finished_at=excluded.finished_at`,
      )
      .run(j.id, j.userId, j.workspaceId, j.modality, j.status, j.prompt, JSON.stringify(j.params), j.modelId, j.providerId, JSON.stringify(j.assets), j.error, j.progress, j.cost, j.createdAt, j.startedAt, j.finishedAt);
  }

  getGenerationJob(id: string): GenerationJob | null {
    const row = this.db.prepare('SELECT * FROM generation_jobs WHERE id = ?').get(id) as Row | undefined;
    return row ? toGeneration(row) : null;
  }

  listGenerationJobs(limit = 60): GenerationJob[] {
    return (this.db.prepare('SELECT * FROM generation_jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(toGeneration);
  }

  audit(entry: Omit<AuditLogEntry, 'id' | 'at'> & { at?: number }): void {
    this.db
      .prepare('INSERT INTO audit_logs (id, at, actor, action, target, details, ip) VALUES (?,?,?,?,?,?,?)')
      .run(newId('aud'), entry.at ?? Date.now(), entry.actor, entry.action, entry.target, JSON.stringify(redact(entry.details)), entry.ip);
  }

  listAudit(limit = 200): AuditLogEntry[] {
    return (this.db.prepare('SELECT * FROM audit_logs ORDER BY at DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      id: String(r.id),
      at: Number(r.at),
      actor: String(r.actor),
      action: String(r.action),
      target: (r.target as string) ?? null,
      details: json<Record<string, unknown>>(r.details as string, {}),
      ip: (r.ip as string) ?? null,
    }));
  }

  /** Today's spend per pool (UTC day), for warming budget counters after a restart. */
  spentTodayByPool(): Record<string, number> {
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const rows = this.db
      .prepare('SELECT pool_id AS poolId, COALESCE(SUM(cost),0) AS spent FROM usage WHERE at >= ? AND pool_id IS NOT NULL GROUP BY pool_id')
      .all(dayStart.getTime()) as { poolId: string; spent: number }[];
    return Object.fromEntries(rows.map((r) => [r.poolId, Number(r.spent)]));
  }

  /* ---------------------------------------------------------------- */
  /* Task checkpoints                                                 */
  /* ---------------------------------------------------------------- */

  saveCheckpoint(taskId: string, stepId: string | null, cp: WorkspaceCheckpoint): void {
    this.db
      .prepare('INSERT OR REPLACE INTO task_checkpoints (id, task_id, step_id, label, at, snapshot) VALUES (?,?,?,?,?,?)')
      .run(cp.id, taskId, stepId, cp.label, cp.at, JSON.stringify(cp));
  }

  /**
   * Checkpoints for a task, newest last.
   *
   * `withSnapshot` is off by default because the listing feeds a UI that only
   * needs labels and times — shipping every file's content to render a row
   * would make the panel unusable on a large change set.
   */
  listCheckpoints(taskId: string, withSnapshot = false): (WorkspaceCheckpoint | Omit<WorkspaceCheckpoint, 'files' | 'changes'>)[] {
    const rows = this.db.prepare('SELECT * FROM task_checkpoints WHERE task_id = ? ORDER BY at ASC').all(taskId) as Row[];
    return rows.map((r) => {
      const snapshot = json<WorkspaceCheckpoint>(r.snapshot as string, {
        id: String(r.id),
        label: String(r.label),
        at: Number(r.at),
        files: [],
        skipped: [],
        changes: [],
      });
      if (withSnapshot) return snapshot;
      const { files, changes, ...rest } = snapshot;
      return { ...rest, fileCount: files.length, changeCount: changes.length } as Omit<WorkspaceCheckpoint, 'files' | 'changes'>;
    });
  }

  getCheckpoint(id: string): { taskId: string; stepId: string | null; snapshot: WorkspaceCheckpoint } | null {
    const row = this.db.prepare('SELECT * FROM task_checkpoints WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const snapshot = json<WorkspaceCheckpoint | null>(row.snapshot as string, null);
    if (!snapshot) return null;
    return { taskId: String(row.task_id), stepId: (row.step_id as string) ?? null, snapshot };
  }

  /** Drop checkpoints taken after this one, since a rewind invalidates them. */
  deleteCheckpointsAfter(taskId: string, at: number): number {
    return this.db.prepare('DELETE FROM task_checkpoints WHERE task_id = ? AND at > ?').run(taskId, at).changes;
  }

  /* ---------------------------------------------------------------- */
  /* Idempotency                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Claim an idempotency key, or report what is already known about it.
   *
   * The insert is the lock: two concurrent retries race on the primary key and
   * exactly one wins, so the second sees `in_flight` rather than starting a
   * duplicate. Doing this with a read-then-write would leave the window open.
   */
  claimIdempotency(input: {
    key: string;
    userId: string;
    method: string;
    path: string;
    bodyHash: string;
  }): { state: 'claimed' } | { state: 'in_flight' } | { state: 'complete'; status: number; response: string } | { state: 'conflict' } {
    const now = Date.now();
    try {
      this.db
        .prepare(
          'INSERT INTO idempotency (key, user_id, method, path, body_hash, state, created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(input.key, input.userId, input.method, input.path, input.bodyHash, 'in_flight', now);
      return { state: 'claimed' };
    } catch {
      // The key already exists for this caller and route.
    }

    const row = this.db
      .prepare('SELECT * FROM idempotency WHERE key = ? AND user_id = ? AND method = ? AND path = ?')
      .get(input.key, input.userId, input.method, input.path) as Row | undefined;
    if (!row) return { state: 'claimed' };

    // A key reused with a different payload is a client bug. Replaying the first
    // response would silently discard the second request.
    if (String(row.body_hash) !== input.bodyHash) return { state: 'conflict' };
    if (String(row.state) !== 'complete' || row.response == null) return { state: 'in_flight' };
    return { state: 'complete', status: Number(row.status ?? 200), response: String(row.response) };
  }

  completeIdempotency(input: { key: string; userId: string; method: string; path: string }, status: number, response: string): void {
    this.db
      .prepare(
        'UPDATE idempotency SET state = ?, status = ?, response = ?, completed_at = ? WHERE key = ? AND user_id = ? AND method = ? AND path = ?',
      )
      .run('complete', status, response, Date.now(), input.key, input.userId, input.method, input.path);
  }

  /** Drop a claim whose request failed, so a retry is allowed to try again. */
  releaseIdempotency(input: { key: string; userId: string; method: string; path: string }): void {
    this.db
      .prepare('DELETE FROM idempotency WHERE key = ? AND user_id = ? AND method = ? AND path = ? AND state = ?')
      .run(input.key, input.userId, input.method, input.path, 'in_flight');
  }

  /** Expire old records. Retention is bounded so the table cannot grow forever. */
  pruneIdempotency(olderThanMs: number): number {
    const result = this.db.prepare('DELETE FROM idempotency WHERE created_at < ?').run(Date.now() - olderThanMs);
    return result.changes;
  }

  /* ---------------------------------------------------------------- */
  /* MCP control plane                                                */
  /* ---------------------------------------------------------------- */

  // Specs are JSON blobs by design: their shape belongs to mcp-sdk, and secret
  // values are never inside them — only vault handles are.

  listMcpServers(): unknown[] {
    return (this.db.prepare('SELECT spec FROM mcp_servers ORDER BY created_at').all() as { spec: string }[]).map((r) =>
      JSON.parse(r.spec),
    );
  }

  saveMcpServer(id: string, spec: unknown, createdAt: number, updatedAt: number): void {
    this.db
      .prepare(
        'INSERT INTO mcp_servers (id, spec, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at',
      )
      .run(id, JSON.stringify(spec), createdAt, updatedAt);
  }

  deleteMcpServer(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  }

  sealMcpSecret(handle: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO mcp_secrets (handle, ciphertext, created_at) VALUES (?, ?, ?)')
      .run(handle, this.box.seal(value), Date.now());
  }

  openMcpSecret(handle: string): string | null {
    const row = this.db.prepare('SELECT ciphertext FROM mcp_secrets WHERE handle = ?').get(handle) as { ciphertext: string } | undefined;
    return row ? this.box.open(row.ciphertext) : null;
  }

  discardMcpSecret(handle: string): void {
    this.db.prepare('DELETE FROM mcp_secrets WHERE handle = ?').run(handle);
  }

  listMcpPolicies(): unknown[] {
    return (this.db.prepare('SELECT policy FROM mcp_policies').all() as { policy: string }[]).map((r) => JSON.parse(r.policy));
  }

  saveMcpPolicy(id: string, policy: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO mcp_policies (id, policy) VALUES (?, ?)').run(id, JSON.stringify(policy));
  }

  deleteMcpPolicy(id: string): void {
    this.db.prepare('DELETE FROM mcp_policies WHERE id = ?').run(id);
  }

  listMcpPresets(): unknown[] {
    return (this.db.prepare('SELECT preset FROM mcp_presets').all() as { preset: string }[]).map((r) => JSON.parse(r.preset));
  }

  saveMcpPreset(id: string, preset: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO mcp_presets (id, preset) VALUES (?, ?)').run(id, JSON.stringify(preset));
  }

  deleteMcpPreset(id: string): void {
    this.db.prepare('DELETE FROM mcp_presets WHERE id = ?').run(id);
  }

  /* ---------------------------------------------------------------- */
  /* Browser profiles and research provenance                         */
  /* ---------------------------------------------------------------- */

  // Profile state is cookies and origin storage: sealed at rest, and opened
  // only to hand to a launching browser context.

  loadBrowserProfile(name: string): { state: string; createdAt: number; lastUsedAt: number | null } | null {
    const row = this.db.prepare('SELECT state_sealed, created_at, last_used_at FROM browser_profiles WHERE name = ?').get(name) as
      | { state_sealed: string; created_at: number; last_used_at: number | null }
      | undefined;
    if (!row) return null;
    const state = this.box.open(row.state_sealed);
    if (state == null) return null;
    return { state, createdAt: row.created_at, lastUsedAt: row.last_used_at };
  }

  saveBrowserProfile(name: string, state: string, meta: { createdAt: number; lastUsedAt: number }): void {
    this.db
      .prepare(
        'INSERT INTO browser_profiles (name, state_sealed, created_at, last_used_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET state_sealed = excluded.state_sealed, last_used_at = excluded.last_used_at',
      )
      .run(name, this.box.seal(state), meta.createdAt, meta.lastUsedAt);
  }

  listBrowserProfiles(): { name: string; state: string; createdAt: number; lastUsedAt: number | null }[] {
    const rows = this.db.prepare('SELECT name, state_sealed, created_at, last_used_at FROM browser_profiles').all() as {
      name: string;
      state_sealed: string;
      created_at: number;
      last_used_at: number | null;
    }[];
    const out: { name: string; state: string; createdAt: number; lastUsedAt: number | null }[] = [];
    for (const r of rows) {
      const state = this.box.open(r.state_sealed);
      if (state != null) out.push({ name: r.name, state, createdAt: r.created_at, lastUsedAt: r.last_used_at });
    }
    return out;
  }

  deleteBrowserProfile(name: string): void {
    this.db.prepare('DELETE FROM browser_profiles WHERE name = ?').run(name);
  }

  saveResearchRecord(id: string, record: unknown, at: number): void {
    this.db.prepare('INSERT OR REPLACE INTO research_records (id, record, at) VALUES (?, ?, ?)').run(id, JSON.stringify(record), at);
  }

  listResearchRecords(limit = 100): unknown[] {
    return (
      this.db.prepare('SELECT record FROM research_records ORDER BY at DESC LIMIT ?').all(Math.min(limit, 500)) as { record: string }[]
    ).map((r) => JSON.parse(r.record));
  }

  /* ---------------------------------------------------------------- */
  /* Control plane: skills, profiles, assignments, model history      */
  /* ---------------------------------------------------------------- */

  listSkills(): unknown[] {
    return (this.db.prepare('SELECT skill FROM skills ORDER BY slug').all() as { skill: string }[]).map((r) => JSON.parse(r.skill));
  }

  saveSkill(id: string, slug: string, skill: unknown, updatedAt: number): void {
    this.db
      .prepare(
        'INSERT INTO skills (id, slug, skill, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, skill = excluded.skill, updated_at = excluded.updated_at',
      )
      .run(id, slug, JSON.stringify(skill), updatedAt);
  }

  deleteSkill(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  }

  listAIProfiles(): unknown[] {
    return (this.db.prepare('SELECT profile FROM ai_profiles ORDER BY updated_at').all() as { profile: string }[]).map((r) =>
      JSON.parse(r.profile),
    );
  }

  saveAIProfile(id: string, profile: unknown, updatedAt: number): void {
    this.db
      .prepare(
        'INSERT INTO ai_profiles (id, profile, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at',
      )
      .run(id, JSON.stringify(profile), updatedAt);
  }

  deleteAIProfile(id: string): void {
    this.db.prepare('DELETE FROM ai_profiles WHERE id = ?').run(id);
  }

  listAssignments(): {
    id: string;
    kind: string;
    targetId: string;
    scope: string;
    scopeId: string | null;
    mode: string;
    createdAt: number;
    updatedAt: number;
  }[] {
    const rows = this.db.prepare('SELECT * FROM assignments').all() as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      kind: String(r.kind),
      targetId: String(r.target_id),
      scope: String(r.scope),
      scopeId: (r.scope_id as string) ?? null,
      mode: String(r.mode),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }

  saveAssignment(a: {
    id: string;
    kind: string;
    targetId: string;
    scope: string;
    scopeId: string | null;
    mode: string;
    createdAt: number;
    updatedAt: number;
  }): void {
    // The unique index is on the natural key, so an upsert there keeps one
    // decision per scope even when a caller invents a fresh id.
    this.db
      .prepare(
        `INSERT INTO assignments (id, kind, target_id, scope, scope_id, mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, target_id, scope, IFNULL(scope_id, '')) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at`,
      )
      .run(a.id, a.kind, a.targetId, a.scope, a.scopeId, a.mode, a.createdAt, a.updatedAt);
  }

  deleteAssignment(id: string): void {
    this.db.prepare('DELETE FROM assignments WHERE id = ?').run(id);
  }

  recordModelChanges(changes: { id: string; modelId: string; at: number; kind: string; changes: unknown }[]): void {
    if (!changes.length) return;
    const stmt = this.db.prepare('INSERT OR REPLACE INTO model_changes (id, model_id, at, kind, changes) VALUES (?, ?, ?, ?, ?)');
    const tx = this.db.transaction((rows: typeof changes) => {
      for (const c of rows) stmt.run(c.id, c.modelId, c.at, c.kind, JSON.stringify(c.changes));
    });
    tx(changes);
  }

  listModelChanges(limit = 100): { id: string; modelId: string; at: number; kind: string; changes: unknown }[] {
    const rows = this.db.prepare('SELECT * FROM model_changes ORDER BY at DESC LIMIT ?').all(Math.min(limit, 500)) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      modelId: String(r.model_id),
      at: Number(r.at),
      kind: String(r.kind),
      changes: json<unknown>(r.changes as string, []),
    }));
  }

  /** Prune history so a long-running instance does not grow without bound. */
  pruneModelChanges(keep = 2000): number {
    return this.db.prepare('DELETE FROM model_changes WHERE id NOT IN (SELECT id FROM model_changes ORDER BY at DESC LIMIT ?)').run(keep)
      .changes;
  }
}

/* ------------------------------------------------------------------ */
/* Row mappers                                                        */
/* ------------------------------------------------------------------ */

function toUser(r: Row): User {
  return {
    id: String(r.id),
    email: String(r.email),
    name: String(r.name),
    role: String(r.role) as Role,
    createdAt: Number(r.created_at),
    lastSeenAt: (r.last_seen_at as number) ?? null,
  };
}

function toWorkspace(r: Row): Workspace {
  return {
    id: String(r.id),
    name: String(r.name),
    path: String(r.path),
    repoUrl: (r.repo_url as string) ?? null,
    branch: (r.branch as string) ?? null,
    privacyMode: String(r.privacy_mode) as PrivacyMode,
    defaultMode: String(r.default_mode) as RoutingMode,
    createdAt: Number(r.created_at),
    lastOpenedAt: (r.last_opened_at as number) ?? null,
    userId: (r.user_id as string) ?? null,
  };
}

function toModel(r: Row): ModelDescriptor {
  return {
    id: String(r.id),
    providerId: String(r.provider_id),
    providerModelId: String(r.provider_model_id),
    displayName: String(r.display_name),
    family: (r.family as string) ?? null,
    modalities: json<ModelDescriptor['modalities']>(r.modalities as string, ['text']),
    capabilities: json<ModelDescriptor['capabilities']>(r.capabilities as string, ['text']),
    contextLength: (r.context_length as number) ?? null,
    maxOutputTokens: (r.max_output_tokens as number) ?? null,
    pricing: json<ModelDescriptor['pricing']>(r.pricing as string, { kind: 'UNKNOWN', inputPerMTok: null, outputPerMTok: null, perRequest: null }),
    discovered: bool(r.discovered),
    deprecated: bool(r.deprecated),
    tags: json<string[]>(r.tags as string, []),
    updatedAt: Number(r.updated_at),
  };
}

function toTask(r: Row): AgentTask {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    userId: (r.user_id as string) ?? null,
    title: String(r.title),
    request: String(r.request),
    status: String(r.status) as AgentTask['status'],
    lane: (r.lane as string) ?? null,
    mode: String(r.mode) as RoutingMode,
    createdAt: Number(r.created_at),
    startedAt: (r.started_at as number) ?? null,
    finishedAt: (r.finished_at as number) ?? null,
    error: (r.error as string) ?? null,
    estimate: r.estimate ? json<AgentTask['estimate']>(r.estimate as string, null) : null,
    usage: json<Usage>(r.usage as string, { promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 }),
    result: (r.result as string) ?? null,
  };
}

function toGeneration(r: Row): GenerationJob {
  return {
    id: String(r.id),
    userId: (r.user_id as string) ?? null,
    workspaceId: (r.workspace_id as string) ?? null,
    modality: r.modality as GenerationJob['modality'],
    status: String(r.status) as GenerationJob['status'],
    prompt: String(r.prompt),
    params: json<Record<string, unknown>>(r.params as string, {}),
    modelId: (r.model_id as string) ?? null,
    providerId: (r.provider_id as string) ?? null,
    assets: json<GenerationJob['assets']>(r.assets as string, []),
    error: (r.error as string) ?? null,
    progress: Number(r.progress),
    cost: Number(r.cost),
    createdAt: Number(r.created_at),
    startedAt: (r.started_at as number) ?? null,
    finishedAt: (r.finished_at as number) ?? null,
  };
}

export function defaultPreferences(userId: string): UserPreferences {
  return {
    userId,
    routingMode: 'AUTO',
    privacyMode: 'TRUSTED_ONLY',
    preferredModels: [],
    preferredProviders: [],
    preferredPool: null,
    theme: 'system',
    reduceMotion: false,
    layout: {},
    allowPaid: false,
    maxCostPerTask: null,
    updatedAt: Date.now(),
  };
}
