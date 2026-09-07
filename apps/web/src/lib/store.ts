import { create } from 'zustand';
import type {
  AgentTask,
  FileChange,
  FileNode,
  GenerationJob,
  RoutingMode,
  TaskStep,
  UserPreferences,
  Workspace,
} from '@meridian/shared';
import { api, type ModelView, type PoolView, type ProviderView, type SystemInfo, type Vocabulary } from './api.js';
import { eventStream, type ConnectionState, type ServerEvent } from './events.js';

export type ScreenId =
  | 'home'
  | 'workspace'
  | 'chat'
  | 'tasks'
  | 'agents'
  | 'browser'
  | 'versioncontrol'
  | 'generations'
  | 'models'
  | 'providers'
  | 'pools'
  | 'mcp'
  | 'devops'
  | 'usage'
  | 'settings';

export interface Toast {
  id: string;
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  detail?: string;
}

/** Panel sizes and collapse state, persisted so a reload restores the layout. */
export interface LayoutState {
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  drawerOpen: boolean;
  columns: [number, number, number];
  drawerTab: 'terminal' | 'tasks' | 'logs' | 'git' | 'usage';
}

const DEFAULT_LAYOUT: LayoutState = {
  sidebarCollapsed: false,
  inspectorOpen: true,
  drawerOpen: false,
  columns: [0.2, 0.55, 0.25],
  drawerTab: 'terminal',
};

interface State {
  /* Bootstrap */
  ready: boolean;
  bootError: string | null;
  info: SystemInfo | null;
  vocabulary: Vocabulary | null;
  connection: ConnectionState;

  /* Preferences and layout */
  preferences: UserPreferences | null;
  theme: 'light' | 'dark' | 'system';
  reduceMotion: boolean;
  layout: LayoutState;

  /* Navigation */
  screen: ScreenId;
  paletteOpen: boolean;

  /* Domain data */
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  tree: FileNode | null;
  openFiles: { path: string; content: string; dirty: boolean }[];
  activeFile: string | null;
  changes: FileChange[];

  tasks: (AgentTask & { running?: boolean })[];
  activeTaskId: string | null;
  steps: Record<string, TaskStep[]>;
  liveText: Record<string, string>;

  models: ModelView[];
  providers: ProviderView[];
  pools: PoolView[];
  generations: GenerationJob[];

  /**
   * Today's usage, kept live for the header meter. Refreshed on boot and
   * incremented on every usage event, so the number the user sees is what was
   * actually spent — never an estimate.
   */
  liveUsage: {
    cost: number;
    requests: number;
    tokens: number;
    failures: number;
    lastModelId: string | null;
    lastProviderId: string | null;
    lastAt: number | null;
  };

  /* Composer */
  composerValue: string;
  routingMode: RoutingMode;

  toasts: Toast[];

  /* Actions */
  boot: () => Promise<void>;
  setScreen: (screen: ScreenId) => void;
  setPaletteOpen: (open: boolean) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setReduceMotion: (value: boolean) => void;
  patchLayout: (patch: Partial<LayoutState>) => void;
  setComposerValue: (value: string) => void;
  setRoutingMode: (mode: RoutingMode) => void;
  /** Merge a patch into the CURRENT preferences, update state, persist. */
  updatePreferences: (patch: Partial<UserPreferences>) => Promise<void>;

  refreshWorkspaces: () => Promise<void>;
  openWorkspace: (id: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  setActiveFile: (path: string) => void;
  updateFileContent: (path: string, content: string) => void;
  saveFile: (path: string) => Promise<void>;
  refreshChanges: () => Promise<void>;
  reviewChange: (action: 'accept' | 'reject', path?: string) => Promise<void>;

  refreshTasks: () => Promise<void>;
  openTask: (id: string) => Promise<void>;
  runTask: (request: string, opts?: { allowPaid?: boolean; budget?: number }) => Promise<string | null>;
  cancelTask: (id: string) => Promise<void>;

  refreshModels: (q?: { search?: string; free?: boolean }) => Promise<void>;
  refreshProviders: () => Promise<void>;
  refreshPools: () => Promise<void>;
  refreshGenerations: () => Promise<void>;
  refreshLiveUsage: () => Promise<void>;

  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  handleEvent: (event: ServerEvent) => void;
}

const LAYOUT_KEY = 'meridian.layout';

function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<LayoutState>) } : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function persistLayout(layout: LayoutState): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Private browsing: the layout simply will not persist.
  }
}

function readStored(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function applyTheme(theme: 'light' | 'dark' | 'system'): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    localStorage.setItem('meridian.theme', theme);
  } catch {
    /* ignore */
  }
}

let toastSeq = 0;

export const useStore = create<State>((set, get) => ({
  ready: false,
  bootError: null,
  info: null,
  vocabulary: null,
  connection: 'closed',

  preferences: null,
  theme: readStored('meridian.theme', 'system') as 'light' | 'dark' | 'system',
  reduceMotion: readStored('meridian.reduceMotion', 'false') === 'true',
  layout: loadLayout(),

  screen: 'home',
  paletteOpen: false,

  workspaces: [],
  activeWorkspaceId: null,
  tree: null,
  openFiles: [],
  activeFile: null,
  changes: [],

  tasks: [],
  activeTaskId: null,
  steps: {},
  liveText: {},

  models: [],
  providers: [],
  pools: [],
  generations: [],
  liveUsage: { cost: 0, requests: 0, tokens: 0, failures: 0, lastModelId: null, lastProviderId: null, lastAt: null },

  composerValue: '',
  routingMode: 'AUTO',

  toasts: [],

  /* ---------------------------------------------------------------- */

  async boot() {
    try {
      // These four are independent, so one slow call should not delay the rest.
      const [info, vocabulary, preferences, workspaces] = await Promise.all([
        api.info(),
        api.vocabulary(),
        api.preferences().catch(() => null),
        api.workspaces().then((r) => r.workspaces).catch(() => []),
      ]);

      const theme = preferences?.theme ?? get().theme;
      applyTheme(theme);
      const reduceMotion = preferences?.reduceMotion ?? get().reduceMotion;
      document.documentElement.setAttribute('data-reduce-motion', String(reduceMotion));

      set({
        info,
        vocabulary,
        preferences,
        workspaces,
        theme,
        reduceMotion,
        routingMode: preferences?.routingMode ?? info.defaultRoutingMode,
        ready: true,
      });

      eventStream.onStateChange((connection) => set({ connection }));
      eventStream.onEvent((e) => get().handleEvent(e));
      eventStream.connect();

      void get().refreshLiveUsage();

      // The most recently opened workspace is almost always the one wanted.
      const recent = workspaces[0];
      if (recent) void get().openWorkspace(recent.id);

      for (const w of info.warnings) {
        if (w.level === 'warn') get().toast({ level: 'warn', message: w.message });
      }
    } catch (e) {
      set({ bootError: e instanceof Error ? e.message : String(e), ready: true });
    }
  },

  setScreen: (screen) => set({ screen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  /**
   * Every preference write goes through here. The old pattern — each setter
   * spreading its own captured copy of `preferences` — meant each save PUT a
   * boot-time snapshot: whichever section you touched last silently reverted
   * everything saved since the page loaded.
   */
  async updatePreferences(patch) {
    const prefs = get().preferences;
    if (!prefs) return;
    const next = { ...prefs, ...patch };
    // Optimistic, so a toggled switch holds instead of snapping back while the
    // request is in flight; the server's normalised copy then replaces it.
    set({ preferences: next });
    try {
      const saved = await api.savePreferences(next);
      set({ preferences: saved });
    } catch {
      set({ preferences: prefs });
      get().toast({ level: 'error', message: 'Could not save preferences' });
    }
  },

  setTheme(theme) {
    applyTheme(theme);
    set({ theme });
    void get().updatePreferences({ theme });
  },

  setReduceMotion(value) {
    document.documentElement.setAttribute('data-reduce-motion', String(value));
    try {
      localStorage.setItem('meridian.reduceMotion', String(value));
    } catch {
      /* ignore */
    }
    set({ reduceMotion: value });
    void get().updatePreferences({ reduceMotion: value });
  },

  patchLayout(patch) {
    const layout = { ...get().layout, ...patch };
    persistLayout(layout);
    set({ layout });
  },

  setComposerValue: (composerValue) => set({ composerValue }),

  setRoutingMode(routingMode) {
    set({ routingMode });
    void get().updatePreferences({ routingMode });
  },

  /* ---------------------------------------------------------------- */

  async refreshWorkspaces() {
    const { workspaces } = await api.workspaces();
    set({ workspaces });
  },

  async openWorkspace(id) {
    try {
      const { workspace, tree, changes } = await api.workspace(id);
      set({ activeWorkspaceId: workspace.id, tree, changes, openFiles: [], activeFile: null });
      void get().refreshTasks();
    } catch (e) {
      get().toast({ level: 'error', message: 'Could not open the workspace', detail: e instanceof Error ? e.message : undefined });
    }
  },

  async openFile(path) {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) return;
    const already = get().openFiles.find((f) => f.path === path);
    if (already) {
      set({ activeFile: path });
      return;
    }
    try {
      const { content } = await api.readFile(workspaceId, path);
      set((s) => ({ openFiles: [...s.openFiles, { path, content, dirty: false }], activeFile: path }));
    } catch (e) {
      get().toast({ level: 'error', message: `Could not open ${path}`, detail: e instanceof Error ? e.message : undefined });
    }
  },

  closeFile(path) {
    set((s) => {
      const openFiles = s.openFiles.filter((f) => f.path !== path);
      const activeFile = s.activeFile === path ? (openFiles[openFiles.length - 1]?.path ?? null) : s.activeFile;
      return { openFiles, activeFile };
    });
  },

  setActiveFile: (activeFile) => set({ activeFile }),

  updateFileContent(path, content) {
    set((s) => ({ openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, content, dirty: true } : f)) }));
  },

  async saveFile(path) {
    const { activeWorkspaceId, openFiles } = get();
    const file = openFiles.find((f) => f.path === path);
    if (!activeWorkspaceId || !file) return;
    await api.writeFile(activeWorkspaceId, path, file.content);
    set((s) => ({ openFiles: s.openFiles.map((f) => (f.path === path ? { ...f, dirty: false } : f)) }));
    void get().refreshChanges();
  },

  async refreshChanges() {
    const id = get().activeWorkspaceId;
    if (!id) return;
    const { changes } = await api.changes(id);
    set({ changes });
  },

  async reviewChange(action, path) {
    const id = get().activeWorkspaceId;
    if (!id) return;
    await api.reviewChange(id, action, path);
    await get().refreshChanges();
    // Rejecting restores the file on disk, so any open copy is now stale.
    if (action === 'reject') {
      const open = get().openFiles;
      for (const f of open) {
        if (!path || f.path === path) {
          const { content } = await api.readFile(id, f.path).catch(() => ({ content: f.content }));
          set((s) => ({ openFiles: s.openFiles.map((x) => (x.path === f.path ? { ...x, content, dirty: false } : x)) }));
        }
      }
    }
    get().toast({ level: 'success', message: action === 'accept' ? 'Changes accepted' : 'Changes reverted' });
  },

  /* ---------------------------------------------------------------- */

  async refreshTasks() {
    const workspaceId = get().activeWorkspaceId ?? undefined;
    const { tasks } = await api.tasks(workspaceId);
    set({ tasks });
  },

  async openTask(id) {
    const detail = await api.task(id);
    set((s) => ({ activeTaskId: id, steps: { ...s.steps, [id]: detail.steps } }));
  },

  async runTask(request, opts = {}) {
    const workspaceId = get().activeWorkspaceId;
    if (!workspaceId) {
      get().toast({ level: 'warn', message: 'Open a workspace first' });
      return null;
    }
    try {
      const { task } = await api.createTask({ workspaceId, request, mode: get().routingMode, ...opts });
      set((s) => ({ tasks: [{ ...task, running: true }, ...s.tasks], activeTaskId: task.id, composerValue: '' }));
      return task.id;
    } catch (e) {
      get().toast({ level: 'error', message: 'Could not start the task', detail: e instanceof Error ? e.message : undefined });
      return null;
    }
  },

  async cancelTask(id) {
    await api.cancelTask(id);
    get().toast({ level: 'info', message: 'Task cancelled' });
  },

  /* ---------------------------------------------------------------- */

  async refreshModels(q = {}) {
    const { models } = await api.models({ ...q, limit: 500 });
    set({ models });
  },

  async refreshProviders() {
    const { providers } = await api.providers();
    set({ providers });
  },

  async refreshPools() {
    const { pools } = await api.pools();
    set({ pools });
  },

  async refreshGenerations() {
    const { jobs } = await api.generations();
    set({ generations: jobs });
  },

  /* ---------------------------------------------------------------- */

  toast(t) {
    const id = `toast-${++toastSeq}`;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    // Errors stay until dismissed; everything else clears itself.
    if (t.level !== 'error') {
      setTimeout(() => get().dismissToast(id), 6000);
    }
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  /**
   * Fold a server event into local state.
   *
   * Every live surface in the app is driven from here rather than from
   * polling, which is what lets a task's timeline update in place while the
   * user is looking at a different screen.
   */
  async refreshLiveUsage() {
    try {
      const { summary, recent } = await api.usage(1);
      const last = recent[0] ?? null;
      set({
        liveUsage: {
          cost: summary.totals.cost,
          requests: summary.totals.requests,
          tokens: summary.totals.tokens,
          failures: summary.totals.failures,
          lastModelId: last?.modelId ?? null,
          lastProviderId: last?.providerId ?? null,
          lastAt: last?.at ?? null,
        },
      });
    } catch {
      // A usage read failing must not break the shell; the meter just stays put.
    }
  },

  handleEvent(event) {
    switch (event.type) {
      case 'usage': {
        const r = event.record;
        set((s) => ({
          liveUsage: {
            cost: s.liveUsage.cost + (r.cost ?? 0),
            requests: s.liveUsage.requests + 1,
            tokens: s.liveUsage.tokens + (r.promptTokens ?? 0) + (r.completionTokens ?? 0),
            failures: s.liveUsage.failures + (r.success ? 0 : 1),
            lastModelId: r.modelId ?? s.liveUsage.lastModelId,
            lastProviderId: r.providerId ?? s.liveUsage.lastProviderId,
            lastAt: r.at ?? Date.now(),
          },
        }));
        break;
      }
      case 'task': {
        const inner = event.event;
        if (inner.type === 'task-update') {
          set((s) => ({
            tasks: s.tasks.some((t) => t.id === inner.task.id)
              ? s.tasks.map((t) => (t.id === inner.task.id ? { ...inner.task, running: inner.task.status === 'running' } : t))
              : [{ ...inner.task, running: inner.task.status === 'running' }, ...s.tasks],
          }));
          if (inner.task.status === 'completed') {
            void get().refreshChanges();
            get().toast({ level: 'success', message: `${inner.task.title} finished` });
          } else if (inner.task.status === 'failed') {
            get().toast({ level: 'error', message: `${inner.task.title} failed`, detail: inner.task.error ?? undefined });
          }
        } else if (inner.type === 'step-update') {
          set((s) => {
            const existing = s.steps[inner.step.taskId] ?? [];
            const next = existing.some((x) => x.id === inner.step.id)
              ? existing.map((x) => (x.id === inner.step.id ? inner.step : x))
              : [...existing, inner.step].sort((a, b) => a.order - b.order);
            return { steps: { ...s.steps, [inner.step.taskId]: next } };
          });
        } else if (inner.type === 'agent' && inner.event.type === 'text') {
          const { stepId, delta } = inner.event;
          set((s) => ({ liveText: { ...s.liveText, [stepId]: (s.liveText[stepId] ?? '') + delta } }));
        } else if (inner.type === 'diff') {
          set({ changes: inner.changes });
        }
        break;
      }
      case 'fallback':
        get().toast({
          level: 'info',
          message: event.event.message,
          detail: `${event.event.fromProvider} → ${event.event.toProvider ?? 'none'}`,
        });
        break;
      case 'generation':
        set((s) => ({
          generations: s.generations.some((g) => g.id === event.job.id)
            ? s.generations.map((g) => (g.id === event.job.id ? event.job : g))
            : [event.job, ...s.generations],
        }));
        break;
      case 'health':
        set((s) => ({
          providers: s.providers.map((p) => (p.id === event.health.providerId ? { ...p, health: event.health } : p)),
        }));
        break;
      case 'notice':
        get().toast({ level: event.level === 'error' ? 'error' : event.level, message: event.message });
        break;
      default:
        break;
    }
  },
}));
