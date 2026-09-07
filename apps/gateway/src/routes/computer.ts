import type { FastifyInstance } from 'fastify';
import { MeridianError } from '@meridian/shared';
import {
  APPROVAL_MODES,
  PERMISSIONS,
  READ_ONLY_PERMISSIONS,
  SAFE_PERMISSIONS,
  describeAction,
  runDiagnostics,
  type ApprovalMode,
  type PermissionSet,
  type SessionConfig,
} from '@meridian/computer-sdk';
import type { App } from '../services/app.js';
import { requireAdmin, requireScope } from './authz.js';

/**
 * The computer agent's API.
 *
 * Starting a session is administrative: it hands a model control of a pointer
 * and a keyboard on a real machine, which is the most consequential thing this
 * gateway can be asked to do. Reading a session's state is not, so a viewer can
 * watch and — importantly — press Stop.
 */
export async function registerComputerRoutes(server: FastifyInstance, app: App): Promise<void> {
  const service = app.computer;

  /** A session belongs to whoever started it; nobody else may see or steer it. */
  const owned = (req: { auth: { userId: string | null; role: string } }, sessionUserId: string | null): boolean =>
    req.auth.role === 'admin' || sessionUserId === null || sessionUserId === req.auth.userId;

  /**
   * Resolve a live session the caller is entitled to act on.
   *
   * Deliberately reports a missing session rather than a forbidden one: a user
   * who may not touch a session should not learn it exists, nor be able to
   * probe for other people's session ids.
   */
  const ownedLive = (req: { auth: { userId: string | null; role: string } }, id: string) => {
    const session = service.sessions.get(id);
    if (!owned(req, session.userId)) throw new MeridianError('invalid_request', `No computer session ${id}`);
    return session;
  };

  /* ---- Capability surface -------------------------------------------- */

  server.get('/api/computer/backends', async (req) => {
    requireScope(req, 'workspaces');
    return { backends: await service.describeBackends() };
  });

  server.get('/api/computer/vocabulary', async (req) => {
    requireScope(req, 'workspaces');
    return {
      permissions: PERMISSIONS,
      approvalModes: APPROVAL_MODES,
      presets: {
        readOnly: READ_ONLY_PERMISSIONS,
        safe: SAFE_PERMISSIONS,
      },
      // Stated plainly so the UI never has to imply computer control is on.
      defaultEnabled: false,
    };
  });

  /** What Auto would choose, without starting anything. */
  server.post('/api/computer/plan', async (req) => {
    requireScope(req, 'workspaces');
    const body = (req.body ?? {}) as {
      modelId?: string | null;
      backendId?: string | null;
      groundingMode?: SessionConfig['groundingMode'];
      privacyPreference?: SessionConfig['privacyPreference'];
    };
    return { decision: await service.plan(body) };
  });

  server.post('/api/computer/diagnostics', async (req) => {
    requireScope(req, 'workspaces');
    const body = (req.body ?? {}) as { backendId?: string };
    return await runDiagnostics(service.backends, body.backendId ?? null);
  });

  /* ---- Sessions -------------------------------------------------------- */

  server.get('/api/computer/sessions', async (req) => {
    requireScope(req, 'workspaces');
    const live = service.sessions
      .list()
      .filter((s) => owned(req, s.userId))
      .map((s) => s.info());
    const stored = app.store.listComputerSessions(req.auth.role === 'admin' ? null : req.auth.userId, 50);
    return { live, history: stored };
  });

  server.post('/api/computer/sessions', async (req, reply) => {
    // Handing a model a pointer and a keyboard is an administrative act.
    requireAdmin(req);
    const body = (req.body ?? {}) as {
      task?: string;
      modelId?: string | null;
      backendId?: string | null;
      groundingMode?: SessionConfig['groundingMode'];
      permissions?: PermissionSet;
      approvalMode?: ApprovalMode;
      privacyPreference?: SessionConfig['privacyPreference'];
      maxSteps?: number;
      actionTimeoutMs?: number;
      profileId?: string | null;
      workspaceId?: string | null;
    };
    if (!body.task?.trim()) throw new MeridianError('invalid_request', 'task is required');

    // Only the known permission names are honoured; an unrecognised key is
    // dropped rather than stored, so a typo cannot look like a grant.
    const permissions: PermissionSet = {};
    for (const key of PERMISSIONS) if (body.permissions?.[key] === true) permissions[key] = true;

    const session = await service.start({
      task: body.task,
      modelId: body.modelId,
      backendId: body.backendId,
      groundingMode: body.groundingMode,
      permissions: body.permissions ? permissions : undefined,
      approvalMode: body.approvalMode,
      privacyPreference: body.privacyPreference,
      maxSteps: body.maxSteps,
      actionTimeoutMs: body.actionTimeoutMs,
      profileId: body.profileId,
      workspaceId: body.workspaceId,
      userId: req.auth.userId,
    });

    app.store.audit({
      actor: req.auth.userId ?? 'anonymous',
      action: 'computer.session.start',
      target: session.id,
      details: {
        task: body.task.slice(0, 200),
        backend: session.info().activeBackendId,
        model: session.info().activeModelId,
        approvalMode: session.config.approvalMode,
        permissions: Object.keys(session.config.permissions).filter((k) => session.config.permissions[k as never]),
      },
      ip: req.ip,
    });

    reply.code(201);
    return { session: session.info() };
  });

  server.get('/api/computer/sessions/:id', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const live = service.sessions.find(id);
    if (live) {
      if (!owned(req, live.userId)) throw new MeridianError('invalid_request', `No computer session ${id}`);
      return { session: live.info(), actions: live.actions(), live: true };
    }
    const stored = app.store.getComputerSession(id);
    if (!stored) throw new MeridianError('invalid_request', `No computer session ${id}`);
    if (!owned(req, (stored.userId as string) ?? null)) throw new MeridianError('invalid_request', `No computer session ${id}`);
    return { session: stored, actions: app.store.listComputerActions(id), live: false };
  });

  /** The latest frame, for the live view. */
  server.get('/api/computer/sessions/:id/screenshot', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const shot = ownedLive(req, id).latestScreenshot();
    if (!shot) throw new MeridianError('invalid_request', 'No screenshot has been captured yet');
    return shot;
  });

  server.post('/api/computer/sessions/:id/pause', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    return { paused: ownedLive(req, id).pause() };
  });

  server.post('/api/computer/sessions/:id/resume', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    return { resumed: ownedLive(req, id).resume() };
  });

  /**
   * Stop.
   *
   * Deliberately the one action with no ownership check, unlike pause, resume
   * and approve: anyone who can see that a machine is being driven must be able
   * to make it stop, without first proving whose session it is or finding an
   * administrator. Being able to halt someone else's agent is a far smaller
   * risk than being unable to halt your own.
   */
  server.post('/api/computer/sessions/:id/stop', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const session = service.sessions.get(id);
    session.stop('stopped by the user');
    app.store.audit({
      actor: req.auth.userId ?? 'anonymous',
      action: 'computer.session.stop',
      target: id,
      details: { step: session.info().step },
      ip: req.ip,
    });
    return { stopped: true, session: session.info() };
  });

  /* ---- Approvals -------------------------------------------------------- */

  server.post('/api/computer/sessions/:id/approve', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { approvalId?: string; scope?: 'once' | 'task' };
    if (!body.approvalId) throw new MeridianError('invalid_request', 'approvalId is required');
    const session = ownedLive(req, id);
    const pending = session.info().pendingApproval;
    const granted = session.approve(body.approvalId, body.scope === 'task' ? 'task' : 'once');
    if (!granted) throw new MeridianError('invalid_request', 'That approval is no longer pending');
    app.store.audit({
      actor: req.auth.userId ?? 'anonymous',
      action: 'computer.action.approve',
      target: id,
      details: { scope: body.scope ?? 'once', action: pending ? describeAction(pending.action) : 'unknown' },
      ip: req.ip,
    });
    return { approved: true };
  });

  server.post('/api/computer/sessions/:id/deny', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { approvalId?: string };
    if (!body.approvalId) throw new MeridianError('invalid_request', 'approvalId is required');
    const denied = ownedLive(req, id).deny(body.approvalId);
    if (!denied) throw new MeridianError('invalid_request', 'That approval is no longer pending');
    return { denied: true };
  });
}
