import {
  SCOPE_ORDER,
  type Assignment,
  type AssignmentKind,
  type AssignmentScope,
  type ResolutionReason,
} from '@meridian/shared';

/**
 * The scope resolution engine.
 *
 * One rule decides everything the control plane does with skills and MCP
 * servers: walk the scopes from least to most specific, and the last scope
 * with an opinion wins. That single rule is what makes "globally on, off for
 * this one model" expressible without editing the global rule, and it is why
 * an assignment carries `mode: 'exclude'` rather than simply being absent —
 * absence means "no opinion", which must inherit.
 *
 * Nothing here knows what a skill or an MCP server is. That keeps the
 * precedence behaviour identical for both, which is the property the UI
 * promises when it shows the same inheritance chain in both screens.
 */

/** Which scope ids apply to the AI a request is being resolved for. */
export interface ResolutionContext {
  providerId?: string | null;
  modelId?: string | null;
  profileId?: string | null;
  workspaceId?: string | null;
  sessionId?: string | null;
}

function scopeIdFor(scope: AssignmentScope, ctx: ResolutionContext): string | null | undefined {
  switch (scope) {
    case 'global':
      return null;
    case 'provider':
      return ctx.providerId ?? undefined;
    case 'model':
      return ctx.modelId ?? undefined;
    case 'profile':
      return ctx.profileId ?? undefined;
    case 'workspace':
      return ctx.workspaceId ?? undefined;
    case 'session':
      return ctx.sessionId ?? undefined;
  }
}

/**
 * Decide one target's fate and record the whole chain that led there.
 *
 * `considered` is not decoration: the UI renders it verbatim so a user can see
 * that a skill is on because of a global rule and would be off if the model
 * scope said so. Returning only the verdict would make the precedence system
 * unexplainable, which is the failure mode this design exists to avoid.
 */
export function resolveTarget(
  targetId: string,
  assignments: Assignment[],
  ctx: ResolutionContext,
  opts: { defaultEnabled?: boolean } = {},
): ResolutionReason {
  const relevant = assignments.filter((a) => a.targetId === targetId);
  const considered: ResolutionReason['considered'] = [];
  let decidedBy: AssignmentScope | 'default' = 'default';
  let decidedScopeId: string | null = null;
  let mode: 'include' | 'exclude' | 'none' = 'none';

  for (const scope of SCOPE_ORDER) {
    const wanted = scopeIdFor(scope, ctx);
    // undefined means this scope does not apply to the current context at all
    // (no workspace, no session): it cannot have an opinion.
    if (wanted === undefined) continue;
    const hit = relevant.find((a) => a.scope === scope && (a.scopeId ?? null) === wanted);
    if (!hit) continue;
    considered.push({ scope, scopeId: hit.scopeId ?? null, mode: hit.mode });
    decidedBy = scope;
    decidedScopeId = hit.scopeId ?? null;
    mode = hit.mode;
  }

  const enabled = mode === 'none' ? (opts.defaultEnabled ?? false) : mode === 'include';
  return { targetId, enabled, decidedBy, scopeId: decidedScopeId, mode, considered, blocked: null };
}

/** Every target that any assignment mentions, for the given kind. */
export function targetsOf(assignments: Assignment[], kind: AssignmentKind): string[] {
  return [...new Set(assignments.filter((a) => a.kind === kind).map((a) => a.targetId))];
}

/**
 * Resolve a whole set of candidate targets at once.
 *
 * Candidates are passed in rather than derived from the assignments, because a
 * skill with no assignment anywhere still has to appear in the answer as
 * "off, by default" — otherwise the UI cannot offer to turn it on.
 */
export function resolveAll(
  candidates: string[],
  assignments: Assignment[],
  kind: AssignmentKind,
  ctx: ResolutionContext,
  opts: { defaultEnabled?: boolean } = {},
): ResolutionReason[] {
  const forKind = assignments.filter((a) => a.kind === kind);
  return candidates.map((id) => resolveTarget(id, forKind, ctx, opts));
}

/** Human sentence for one resolution, used in the UI and in the CLI. */
export function explainResolution(reason: ResolutionReason): string {
  if (reason.blocked) return `Unavailable: ${reason.blocked}`;
  if (reason.decidedBy === 'default') return reason.enabled ? 'Enabled by default' : 'Not assigned';
  const where = reason.scopeId ? `${reason.decidedBy} "${reason.scopeId}"` : reason.decidedBy;
  const verb = reason.mode === 'exclude' ? 'Excluded' : 'Enabled';
  const overridden = reason.considered.length > 1 ? `, overriding ${reason.considered.length - 1} broader assignment(s)` : '';
  return `${verb} by ${where} assignment${overridden}`;
}
