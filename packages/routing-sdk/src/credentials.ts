import {
  CREDENTIAL_SCOPE_ORDER,
  type CredentialHealth,
  type CredentialPool,
  type CredentialRecord,
  type CredentialScope,
  type ResolvedCredential,
} from '@meridian/shared';

/**
 * How the resolver asks whether an account is fit to use.
 *
 * Structural rather than a concrete dependency: `CredentialHealthStore`
 * satisfies it, and a test can satisfy it with an object literal. Optional
 * throughout — without it every credential is simply available, which is the
 * behaviour that existed before accounts had health at all.
 */
export interface CredentialAvailability {
  available(credentialId: string): boolean;
  unavailableReason(credentialId: string): string | null;
  get(credentialId: string, providerId?: string): CredentialHealth;
}

export interface CredentialQuery {
  providerId: string;
  userId?: string | null;
  workspaceId?: string | null;
  /** A credential id named explicitly on the request. */
  explicitCredentialId?: string | null;
  /** Scopes the caller is permitted to draw on. */
  allowedScopes?: CredentialScope[];
}

/**
 * The store the resolver reads from. The gateway backs this with the encrypted
 * database; tests back it with an array.
 */
export interface CredentialStore {
  listForProvider(providerId: string): ResolvedCredential[];
  getById(id: string): ResolvedCredential | null;
  pool(poolId: string): CredentialPool | null;
  /** Records a use so least-used rotation and quota tracking stay accurate. */
  markUsed(credentialId: string, at: number): void;
}

export interface CredentialResolution {
  credential: ResolvedCredential | null;
  /** Why this credential was chosen, for the routing-explanation panel. */
  reason: string;
  /** True when the provider genuinely needs no credential. */
  anonymous: boolean;
  /**
   * Why there is none, when there is none.
   *
   * `'none-configured'` — nothing this caller may use exists. A setup problem,
   *   and one they can fix.
   * `'unavailable'` — a key exists and is in good order, but is not usable this
   *   instant: at its own concurrency limit, cooling down after a 429, or out
   *   of quota until the window resets.
   *
   * The difference is a clock. One of them means "add a key", the other means
   * "wait, or use another one", and reporting the second as the first sends an
   * operator to re-enter a credential that was working the whole time.
   */
  blocked: 'none-configured' | 'unavailable' | null;
}

/**
 * Resolves which credential to use for a call.
 *
 * The precedence is the product's contract (spec §42): an explicitly named
 * credential wins, then the user's own, then the workspace's, then the
 * operator's, then the system's, then an approved managed credential, and only
 * then a genuinely anonymous endpoint.
 *
 * Automatic discovery is deliberately limited to legitimate sources — env vars,
 * OAuth, explicit configuration, admin-managed keys. Nothing in this class
 * searches for, infers, or reuses a credential that was not handed to it.
 */
export class CredentialResolver {
  private readonly store: CredentialStore;
  private readonly now: () => number;
  /** In-flight request count per credential, for concurrency limits. */
  private readonly inFlight = new Map<string, number>();
  /** Round-robin cursor per pool. */
  private readonly cursors = new Map<string, number>();

  private readonly availability: CredentialAvailability | null;

  constructor(store: CredentialStore, now: () => number = () => Date.now(), availability: CredentialAvailability | null = null) {
    this.store = store;
    this.now = now;
    this.availability = availability;
  }

  resolve(q: CredentialQuery, providerRequiresAuth: boolean, opts: { commit?: boolean } = {}): CredentialResolution {
    const commit = opts.commit !== false;
    if (q.explicitCredentialId) {
      const explicit = this.store.getById(q.explicitCredentialId);
      // Naming a credential is not the same as being entitled to it. An id is
      // guessable and, once any surface accepts one from a caller, an
      // unchecked lookup here is a cross-user key leak. So the same ownership
      // rule that governs automatic selection governs an explicit choice:
      // a user-scoped credential belongs to its user, a workspace-scoped one to
      // its workspace, and nothing else may borrow either.
      if (explicit && explicit.providerId === q.providerId && this.usable(explicit) && this.entitled(explicit, q)) {
        if (commit) this.store.markUsed(explicit.id, this.now());
        return { credential: explicit, reason: 'Credential named on the request', anonymous: false, blocked: null };
      }
      // An explicitly named credential that cannot be used is an error the
      // caller should see, not something to silently paper over.
      return {
        credential: null,
        reason: `Requested credential ${q.explicitCredentialId} is unavailable for ${q.providerId}`,
        anonymous: false,
        // A named credential that exists, belongs to this caller and is merely
        // busy is a different thing from one that is missing or revoked.
        blocked: explicit && explicit.providerId === q.providerId && this.entitled(explicit, q) && this.configured(explicit)
          ? 'unavailable'
          : 'none-configured',
      };
    }

    const allowed = new Set<CredentialScope>(q.allowedScopes ?? CREDENTIAL_SCOPE_ORDER);
    const candidates = this.store.listForProvider(q.providerId).filter((c) => this.usable(c));

    for (const scope of CREDENTIAL_SCOPE_ORDER) {
      if (scope === 'request' || !allowed.has(scope)) continue;
      const forScope = candidates.filter((c) => c.scope === scope && this.entitled(c, q));
      if (!forScope.length) continue;
      const picked = this.pick(forScope, commit);
      if (!picked) continue;
      // Routing previews and dry runs resolve too; only a resolution that will
      // actually be sent should advance rotation cursors and last-used marks,
      // or every "why this model?" panel skews the very rotation it describes.
      if (commit) this.store.markUsed(picked.id, this.now());
      return { credential: picked, reason: SCOPE_REASON[scope], anonymous: false, blocked: null };
    }

    if (!providerRequiresAuth) {
      return { credential: null, reason: 'Provider serves anonymous requests', anonymous: true, blocked: null };
    }
    // "None configured" and "all of them are cooling down" are different
    // problems with different fixes, and telling a caller the first when the
    // second is true sends them to add a key they already have.
    const entitled = this.store.listForProvider(q.providerId).filter((c) => this.entitled(c, q));
    return {
      credential: null,
      reason: this.reasonFor(q.providerId, q.userId ?? null, q.workspaceId ?? null) ?? `No credential available for ${q.providerId}`,
      anonymous: false,
      blocked: entitled.some((c) => this.configured(c)) ? 'unavailable' : 'none-configured',
    };
  }

  /** True when at least one credential could serve this provider right now. */
  hasAny(providerId: string): boolean {
    return this.store.listForProvider(providerId).some((c) => this.usable(c));
  }

  /**
   * True when at least one credential THIS caller may use could serve the
   * provider. The distinction matters on a shared instance: another user's key
   * existing is not capacity this caller has, and routing as though it were
   * produces authentication failures the caller cannot explain or fix.
   */
  hasAnyFor(providerId: string, userId: string | null, workspaceId: string | null): boolean {
    return this.store
      .listForProvider(providerId)
      .some((c) => this.usable(c) && this.entitled(c, { providerId, userId, workspaceId }));
  }

  /**
   * Why this caller cannot use this provider right now, or null if they can.
   *
   * Exists so a routing rejection can say the true thing. The router's only
   * question used to be a boolean, so an instance whose one key was
   * rate-limited for forty seconds told every caller the provider had no
   * credential configured — sending them to add a key that was already there
   * and working.
   */
  reasonFor(providerId: string, userId: string | null, workspaceId: string | null): string | null {
    const entitled = this.store
      .listForProvider(providerId)
      .filter((c) => this.entitled(c, { providerId, userId, workspaceId }));
    if (entitled.some((c) => this.usable(c))) return null;

    const configured = entitled.filter((c) => this.configured(c));
    if (!configured.length) return `No credential this caller may use is configured for ${providerId}`;

    const reasons = configured
      .map((c) => this.availability?.unavailableReason(c.id) ?? (this.atCapacity(c) ? `at its concurrency limit of ${c.maxConcurrency}` : null))
      .filter((r): r is string => Boolean(r));
    if (!reasons.length) return `No credential this caller may use is configured for ${providerId}`;
    return configured.length === 1
      ? `The only ${providerId} account available to this caller is ${reasons[0]}`
      : `All ${configured.length} ${providerId} accounts available to this caller are unavailable (${reasons[0]})`;
  }

  /**
   * Whether this caller may use this credential.
   *
   * The rule is ownership, not scope order: a user-scoped credential belongs to
   * exactly one user and a workspace-scoped one to exactly one workspace.
   * Anything broader — operator, system, managed — is shared by definition, and
   * is the operator's decision to have made.
   *
   * A user-scoped credential with no user attached is unusable rather than
   * universal. Treating a missing owner as "anyone" is how a scoping bug becomes
   * a leak.
   */
  private entitled(credential: ResolvedCredential, q: CredentialQuery): boolean {
    if (credential.scope === 'user') return credential.userId != null && credential.userId === q.userId;
    if (credential.scope === 'workspace') return credential.workspaceId != null && credential.workspaceId === q.workspaceId;
    return true;
  }

  /**
   * Configured, entitled and not obviously broken — the state of the record.
   *
   * Deliberately separate from whether the account is *currently* fit to use:
   * a key on a 30-second rate-limit cooldown is perfectly well configured, and
   * conflating the two turns "busy for a moment" into "not set up", which is
   * what a caller is then told.
   */
  private configured(c: ResolvedCredential): boolean {
    if (!c.enabled) return false;
    if (c.expiresAt != null && c.expiresAt <= this.now()) return false;
    if (c.secret == null && c.source !== 'anonymous-endpoint') return false;
    return true;
  }

  /** True when the key is at the concurrency ceiling its operator set for it. */
  private atCapacity(c: ResolvedCredential): boolean {
    return c.maxConcurrency != null && (this.inFlight.get(c.id) ?? 0) >= c.maxConcurrency;
  }

  private usable(c: ResolvedCredential): boolean {
    if (!this.configured(c)) return false;
    // A revoked key, a spent quota or a live rate-limit cooldown all mean the
    // same thing to a router: do not send this one now. A key with every slot
    // busy is in that same category — momentarily unusable, perfectly well
    // configured — which is why the check is here and not above.
    if (this.atCapacity(c)) return false;
    if (this.availability && !this.availability.available(c.id)) return false;
    return true;
  }

  /**
   * Choose among several usable credentials for the same scope, honouring the
   * pool strategy when they belong to one.
   *
   * Rotation here exists to spread load across capacity the operator legitimately
   * owns and to respect each key's own concurrency limit. It is not a mechanism
   * for exceeding a provider's per-account limits, and pools are per-provider by
   * construction so a key can never be presented to a provider it does not
   * belong to.
   */
  private pick(candidates: ResolvedCredential[], commit = true): ResolvedCredential | null {
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    const poolId = candidates.find((c) => c.poolId)?.poolId ?? null;
    const strategy = poolId ? (this.store.pool(poolId)?.strategy ?? 'priority') : 'priority';

    switch (strategy) {
      case 'round-robin': {
        const key = poolId ?? candidates[0].providerId;
        const idx = (this.cursors.get(key) ?? 0) % candidates.length;
        if (commit) this.cursors.set(key, idx + 1);
        return candidates[idx];
      }
      case 'least-used': {
        return [...candidates].sort(
          (a, b) => (this.inFlight.get(a.id) ?? 0) - (this.inFlight.get(b.id) ?? 0) || (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0),
        )[0];
      }
      case 'health': {
        // Advertised in the type, accepted by the API, persisted — and, until
        // accounts had health, identical to `priority`, because there was
        // nothing per-credential to sort on. Now there is: an account that has
        // been failing goes last even if it has the highest priority, since
        // priority expresses which key an operator PREFERS and health expresses
        // which one is currently working.
        const failures = (c: ResolvedCredential): number => this.availability?.get(c.id, c.providerId).consecutiveFailures ?? 0;
        const lastSuccess = (c: ResolvedCredential): number => this.availability?.get(c.id, c.providerId).lastSuccessAt ?? 0;
        return [...candidates].sort(
          (a, b) => failures(a) - failures(b) || b.priority - a.priority || lastSuccess(b) - lastSuccess(a),
        )[0];
      }
      case 'priority':
      default:
        return [...candidates].sort((a, b) => b.priority - a.priority || (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))[0];
    }
  }

  /** Bracket a call so concurrency limits are enforced. */
  acquire(credentialId: string | null): () => void {
    if (!credentialId) return () => undefined;
    this.inFlight.set(credentialId, (this.inFlight.get(credentialId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight.set(credentialId, Math.max(0, (this.inFlight.get(credentialId) ?? 1) - 1));
    };
  }

  concurrencyOf(credentialId: string): number {
    return this.inFlight.get(credentialId) ?? 0;
  }
}

const SCOPE_REASON: Record<CredentialScope, string> = {
  request: 'Credential named on the request',
  user: "Your own credential for this provider",
  workspace: "This workspace's credential",
  admin: "An operator-managed credential",
  system: "A system credential from the environment",
  managed: 'An approved managed provider credential',
  anonymous: 'An anonymous free endpoint',
};

/** In-memory store, used by tests and by the CLI's dry-run mode. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly rows = new Map<string, ResolvedCredential>();
  private readonly pools = new Map<string, CredentialPool>();
  /** Observed by tests that assert when rotation actually advances. */
  onMarkUsed?: (credentialId: string, at: number) => void;

  constructor(rows: ResolvedCredential[] = [], pools: CredentialPool[] = []) {
    for (const r of rows) this.rows.set(r.id, r);
    for (const p of pools) this.pools.set(p.id, p);
  }

  add(row: ResolvedCredential): void {
    this.rows.set(row.id, row);
  }

  addPool(pool: CredentialPool): void {
    this.pools.set(pool.id, pool);
  }

  listForProvider(providerId: string): ResolvedCredential[] {
    return [...this.rows.values()].filter((r) => r.providerId === providerId);
  }

  getById(id: string): ResolvedCredential | null {
    return this.rows.get(id) ?? null;
  }

  pool(poolId: string): CredentialPool | null {
    return this.pools.get(poolId) ?? null;
  }

  markUsed(credentialId: string, at: number): void {
    this.onMarkUsed?.(credentialId, at);
    const row = this.rows.get(credentialId);
    if (row) this.rows.set(credentialId, { ...row, lastUsedAt: at });
  }

  /** Public records only — never exposes a secret. */
  publicRecords(): CredentialRecord[] {
    return [...this.rows.values()].map(({ secret: _secret, ...rest }) => rest);
  }
}
