import {
  CREDENTIAL_SCOPE_ORDER,
  type CredentialPool,
  type CredentialRecord,
  type CredentialScope,
  type ResolvedCredential,
} from '@meridian/shared';

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

  constructor(store: CredentialStore, now: () => number = () => Date.now()) {
    this.store = store;
    this.now = now;
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
        return { credential: explicit, reason: 'Credential named on the request', anonymous: false };
      }
      // An explicitly named credential that cannot be used is an error the
      // caller should see, not something to silently paper over.
      return {
        credential: null,
        reason: `Requested credential ${q.explicitCredentialId} is unavailable for ${q.providerId}`,
        anonymous: false,
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
      return { credential: picked, reason: SCOPE_REASON[scope], anonymous: false };
    }

    if (!providerRequiresAuth) {
      return { credential: null, reason: 'Provider serves anonymous requests', anonymous: true };
    }
    return { credential: null, reason: `No credential available for ${q.providerId}`, anonymous: false };
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

  private usable(c: ResolvedCredential): boolean {
    if (!c.enabled) return false;
    if (c.expiresAt != null && c.expiresAt <= this.now()) return false;
    if (c.secret == null && c.source !== 'anonymous-endpoint') return false;
    if (c.maxConcurrency != null && (this.inFlight.get(c.id) ?? 0) >= c.maxConcurrency) return false;
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
      case 'health':
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
