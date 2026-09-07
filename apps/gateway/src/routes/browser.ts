import type { FastifyInstance } from 'fastify';
import { MeridianError } from '@meridian/shared';
import type { BrowserEngineId, DomainPolicy, ExtractField } from '@meridian/browser-sdk';
import type { App } from '../services/app.js';
import { requireAdmin, requireScope } from './authz.js';

/**
 * The browser control surface.
 *
 * Sessions are observable and terminable by design: everything a session does
 * lands in its log, every operation can be cancelled, and closing a session is
 * always available. Arbitrary JS evaluation is the one privileged action and
 * is gated to administrators.
 */
export async function registerBrowserRoutes(server: FastifyInstance, app: App): Promise<void> {
  const browser = app.control.browser;
  const research = app.control.research;

  server.get('/api/browser/engines', async (req) => {
    requireScope(req, 'workspaces');
    return { engines: await browser.engines(), configured: app.control.browserEngines };
  });

  server.post('/api/browser/sessions', async (req, reply) => {
    requireScope(req, 'workspaces');
    const body = (req.body ?? {}) as {
      engine?: BrowserEngineId | 'fast' | 'compat' | 'auto';
      profile?: string;
      task?: string;
      idleTimeoutMs?: number;
      policy?: Partial<DomainPolicy>;
    };
    const info = await browser.createSession(body);
    reply.code(201);
    return { session: info };
  });

  server.get('/api/browser/sessions', async (req) => {
    requireScope(req, 'workspaces');
    return { sessions: browser.listSessions() };
  });

  server.get('/api/browser/sessions/:id', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    return { session: await browser.sessionInfo(id), log: browser.logsOf(id, 100) };
  });

  server.delete('/api/browser/sessions/:id', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const { saveProfile } = (req.query ?? {}) as { saveProfile?: string };
    await browser.closeSession(id, { saveProfile: saveProfile === 'true' });
    return { closed: true };
  });

  server.post('/api/browser/sessions/:id/cancel', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    return { cancelled: browser.cancel(id) };
  });

  /** One action endpoint; the kind field selects the verb, the log records it. */
  server.post('/api/browser/sessions/:id/actions', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown> & { kind?: string };
    switch (body.kind) {
      case 'navigate':
        return { snapshot: await browser.navigate(id, String(body.url ?? ''), num(body.timeoutMs)) };
      case 'back':
        return { snapshot: await browser.back(id) };
      case 'forward':
        return { snapshot: await browser.forward(id) };
      case 'reload':
        return { snapshot: await browser.reload(id) };
      case 'click':
        return { snapshot: await browser.click(id, { ref: String(body.ref ?? '') }) };
      case 'fill':
        return { snapshot: await browser.fill(id, { ref: String(body.ref ?? ''), text: String(body.text ?? ''), submit: body.submit === true }) };
      case 'select':
        return { snapshot: await browser.select(id, { ref: String(body.ref ?? ''), value: String(body.value ?? '') }) };
      case 'hover':
        return { snapshot: await browser.hover(id, String(body.ref ?? '')) };
      case 'press':
        return { snapshot: await browser.press(id, String(body.key ?? '')) };
      case 'scroll':
        return { snapshot: await browser.scroll(id, body.direction === 'up' ? 'up' : 'down') };
      case 'wait':
        return {
          snapshot: await browser.wait(id, {
            ms: num(body.ms),
            forText: typeof body.forText === 'string' ? body.forText : undefined,
            forNavigation: body.forNavigation === true,
          }),
        };
      case 'evaluate':
        // Arbitrary JS in the page: administrator only, and audited.
        requireAdmin(req);
        app.store.audit({
          actor: req.auth.userId ?? 'anonymous',
          action: 'browser.evaluate',
          target: id,
          details: { expressionLength: String(body.expression ?? '').length },
          ip: req.ip,
        });
        return { result: await browser.evaluate(id, String(body.expression ?? '')) };
      default:
        throw new MeridianError('invalid_request', `Unknown browser action "${String(body.kind)}"`);
    }
  });

  server.get('/api/browser/sessions/:id/snapshot', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    return { snapshot: await browser.snapshot(id) };
  });

  server.get('/api/browser/sessions/:id/screenshot', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    return await browser.screenshot(id);
  });

  server.get('/api/browser/sessions/:id/tabs', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    return { tabs: await browser.listTabs(id) };
  });

  server.post('/api/browser/sessions/:id/tabs', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { url?: string };
    return { index: await browser.openTab(id, body.url ?? null) };
  });

  server.post('/api/browser/sessions/:id/tabs/:index/activate', async (req) => {
    requireScope(req, 'workspaces');
    const { id, index } = req.params as { id: string; index: string };
    await browser.switchTab(id, Number(index));
    return { active: Number(index) };
  });

  server.delete('/api/browser/sessions/:id/tabs/:index', async (req) => {
    requireScope(req, 'workspaces');
    const { id, index } = req.params as { id: string; index: string };
    await browser.closeTab(id, Number(index));
    return { closed: true };
  });

  server.post('/api/browser/sessions/:id/profile', async (req) => {
    requireScope(req, 'workspaces');
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { name?: string };
    await browser.saveProfile(id, body.name);
    return { saved: true };
  });

  server.get('/api/browser/profiles', async (req) => {
    requireScope(req, 'workspaces');
    return { profiles: await browser.listProfiles() };
  });

  server.delete('/api/browser/profiles/:name', async (req) => {
    requireScope(req, 'workspaces');
    const { name } = req.params as { name: string };
    await browser.deleteProfile(name);
    return { deleted: true };
  });

  /* ---- Research ---------------------------------------------------- */

  server.post('/api/research/scrape', async (req) => {
    requireScope(req, 'workspaces');
    const body = (req.body ?? {}) as { url?: string; sessionId?: string; engine?: BrowserEngineId | 'fast' | 'compat' | 'auto'; fresh?: boolean };
    if (!body.url) throw new MeridianError('invalid_request', 'url is required');
    const { snapshot, fromCache, robots } = await research.scrape({
      url: body.url,
      sessionId: body.sessionId,
      engine: body.engine,
      fresh: body.fresh,
    });
    return { snapshot, fromCache, robots };
  });

  server.post('/api/research/extract', async (req) => {
    requireScope(req, 'workspaces');
    const body = (req.body ?? {}) as {
      url?: string;
      objective?: string;
      fields?: ExtractField[];
      sessionId?: string;
      engine?: BrowserEngineId | 'fast' | 'compat' | 'auto';
      fresh?: boolean;
      noLlm?: boolean;
    };
    if (!body.url) throw new MeridianError('invalid_request', 'url is required');
    if (!Array.isArray(body.fields) || body.fields.length === 0) {
      throw new MeridianError('invalid_request', 'fields is required: [{name, description}]');
    }
    const record = await research.extract({
      url: body.url,
      objective: body.objective ?? 'extract the requested fields',
      fields: body.fields.slice(0, 30),
      sessionId: body.sessionId,
      engine: body.engine,
      fresh: body.fresh,
      noLlm: body.noLlm,
    });
    return { record };
  });

  server.get('/api/research/records', async (req) => {
    requireScope(req, 'workspaces');
    const { limit } = (req.query ?? {}) as { limit?: string };
    return { records: app.store.listResearchRecords(limit ? Number(limit) : 100) };
  });
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
