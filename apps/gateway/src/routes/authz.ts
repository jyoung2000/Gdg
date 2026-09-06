import { MeridianError, type CredentialRecord, type Role } from '@meridian/shared';
import type { FastifyRequest } from 'fastify';

/**
 * Who may do what.
 *
 * Meridian has two very different deployments and both have to be right:
 *
 *  - A single-user install with `MERIDIAN_AUTH_REQUIRED=false`. There is one
 *    operator, every request is theirs, and asking them to authenticate to
 *    themselves would be theatre. They are an admin.
 *  - A shared install with authentication on. Now "the caller" is a specific
 *    user, and every route that reads or changes something belonging to someone
 *    else has to say so out loud.
 *
 * The rules live here rather than inline in each route so that adding a route
 * is a decision about which rule applies, not an opportunity to forget one.
 */

/** Scopes an API key can carry. `*` means every scope. */
export const SCOPES = ['inference', 'workspaces', 'credentials', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

/** True when the key's scopes cover this one. */
export function hasScope(scopes: string[], scope: Scope): boolean {
  return scopes.includes('*') || scopes.includes(scope);
}

/**
 * Refuse anything the caller's API key was not issued for.
 *
 * A key created with narrow scopes that is honoured as though it were
 * unrestricted is worse than no scoping at all: the operator believes they
 * limited it.
 */
export function requireScope(req: FastifyRequest, scope: Scope): void {
  if (hasScope(req.auth.scopes, scope)) return;
  throw new MeridianError(
    'authentication_failed',
    `This API key does not carry the "${scope}" scope.`,
  );
}

/** Refuse a caller who is not an administrator of this instance. */
export function requireAdmin(req: FastifyRequest): void {
  requireScope(req, 'admin');
  if (req.auth.role === 'admin') return;
  throw new MeridianError('authentication_failed', 'This action requires an administrator.');
}

/**
 * Whether this caller may see or change this credential.
 *
 * Ownership, not scope order: a user-scoped credential belongs to one user and a
 * workspace-scoped one to one workspace. Everything broader is shared by the
 * operator's deliberate choice, and only an administrator may change it.
 *
 * A user-scoped credential whose owner is missing is nobody's, not everybody's.
 */
export function mayUseCredential(
  req: FastifyRequest,
  credential: Pick<CredentialRecord, 'scope' | 'userId' | 'workspaceId'>,
  workspaceIds: Set<string>,
): boolean {
  if (req.auth.role === 'admin') return true;
  switch (credential.scope) {
    case 'user':
      return credential.userId != null && credential.userId === req.auth.userId;
    case 'workspace':
      return credential.workspaceId != null && workspaceIds.has(credential.workspaceId);
    default:
      // admin, system and managed credentials are readable as "something exists
      // here" but never modifiable by a non-administrator; the caller-facing
      // routes enforce the second half.
      return true;
  }
}

/** Refuse a caller who does not own this credential and is not an administrator. */
export function requireCredentialOwner(
  req: FastifyRequest,
  credential: Pick<CredentialRecord, 'scope' | 'userId' | 'workspaceId'> | null,
  workspaceIds: Set<string>,
): void {
  requireScope(req, 'credentials');
  if (!credential) throw new MeridianError('invalid_request', 'No such credential');
  if (req.auth.role === 'admin') return;
  if (credential.scope === 'user' && credential.userId != null && credential.userId === req.auth.userId) return;
  if (credential.scope === 'workspace' && credential.workspaceId != null && workspaceIds.has(credential.workspaceId)) return;
  // Deliberately the same message whether the credential is someone else's or
  // does not exist: telling a caller which one it was is an enumeration oracle.
  throw new MeridianError('invalid_request', 'No such credential');
}
