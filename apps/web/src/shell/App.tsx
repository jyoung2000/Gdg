import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  IconButton,
  Kbd,
  Sidebar,
  SidebarItem,
  SidebarSection,
  StatusBar,
  StatusChip,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  Tooltip,
  ToastProvider,
  CommandPalette,
  useCommandPalette,
  type Command,
  IconActivity,
  IconBarChart,
  IconCommand,
  IconCpu,
  IconFolder,
  IconHome,
  IconImage,
  IconLayers,
  IconMenu,
  IconMessageSquare,
  IconPanelBottom,
  IconPanelRight,
  IconRefresh,
  IconRobot,
  IconServer,
  IconSettings,
  IconSidebar,
  IconTerminal,
} from '@meridian/ui';
import { api } from '../lib/api.js';
import { BREAKPOINT, useMediaQuery } from '../lib/media.js';
import { useStore, type ScreenId } from '../lib/store.js';
import { Toasts } from './Toasts.js';
import { Inspector } from './Inspector.js';
import { Drawer } from './Drawer.js';
import { HomeScreen } from '../screens/HomeScreen.js';
import { WorkspaceScreen } from '../screens/WorkspaceScreen.js';
import { ChatScreen } from '../screens/ChatScreen.js';
import { TasksScreen } from '../screens/TasksScreen.js';
import { AgentsScreen } from '../screens/AgentsScreen.js';
import { ModelsScreen } from '../screens/ModelsScreen.js';
import { ProvidersScreen } from '../screens/ProvidersScreen.js';
import { PoolsScreen } from '../screens/PoolsScreen.js';
import { GenerationsScreen } from '../screens/GenerationsScreen.js';
import { UsageScreen } from '../screens/UsageScreen.js';
import { SettingsScreen } from '../screens/SettingsScreen.js';

/** The identity mark: a meridian line crossing a circle. */
function Mark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" fill="none">
      <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="2.2" />
      <path d="M16 3v26" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
      <path d="M4.5 11h23M4.5 21h23" stroke="currentColor" strokeWidth="1.4" opacity="0.35" />
    </svg>
  );
}

const NAV: { id: ScreenId; label: string; icon: React.JSX.Element; section: 'work' | 'infrastructure' }[] = [
  { id: 'home', label: 'Home', icon: <IconHome />, section: 'work' },
  { id: 'workspace', label: 'Workspace', icon: <IconFolder />, section: 'work' },
  { id: 'chat', label: 'Chat', icon: <IconMessageSquare />, section: 'work' },
  { id: 'tasks', label: 'Tasks', icon: <IconActivity />, section: 'work' },
  { id: 'agents', label: 'Agents', icon: <IconRobot />, section: 'work' },
  { id: 'generations', label: 'Generations', icon: <IconImage />, section: 'work' },
  { id: 'models', label: 'Models', icon: <IconCpu />, section: 'infrastructure' },
  { id: 'providers', label: 'Providers', icon: <IconServer />, section: 'infrastructure' },
  { id: 'pools', label: 'Pools', icon: <IconLayers />, section: 'infrastructure' },
  { id: 'usage', label: 'Usage', icon: <IconBarChart />, section: 'infrastructure' },
  { id: 'settings', label: 'Settings', icon: <IconSettings />, section: 'infrastructure' },
];

const SCREENS: Record<ScreenId, () => React.JSX.Element> = {
  home: HomeScreen,
  workspace: WorkspaceScreen,
  chat: ChatScreen,
  tasks: TasksScreen,
  agents: AgentsScreen,
  models: ModelsScreen,
  providers: ProvidersScreen,
  pools: PoolsScreen,
  generations: GenerationsScreen,
  usage: UsageScreen,
  settings: SettingsScreen,
};

export function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready);
  const bootError = useStore((s) => s.bootError);
  const boot = useStore((s) => s.boot);

  useEffect(() => {
    void boot();
  }, [boot]);

  if (!ready) {
    return (
      <div className="app__boot">
        <div className="app__boot-inner">
          <Mark className="app__mark" />
          <div className="mrd-secondary">Starting Meridian…</div>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="app__boot">
        <div className="app__boot-inner">
          <Mark className="app__mark" />
          <h1 className="mrd-title">Meridian could not start</h1>
          <p className="mrd-secondary">{bootError}</p>
          <p className="mrd-caption">
            Check that the gateway is running and reachable, then reload. It listens on port 4639 by default.
          </p>
          <Button variant="primary" onClick={() => location.reload()}>
            Reload
          </Button>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell(): React.JSX.Element {
  const screen = useStore((s) => s.screen);
  const setScreen = useStore((s) => s.setScreen);
  const layout = useStore((s) => s.layout);
  const patchLayout = useStore((s) => s.patchLayout);
  const info = useStore((s) => s.info);
  const connection = useStore((s) => s.connection);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const openWorkspace = useStore((s) => s.openWorkspace);
  const tasks = useStore((s) => s.tasks);
  const models = useStore((s) => s.models);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Below this width the assistant is an overlay, not a third column. The
  // overlay has its own state and starts closed: carrying the desktop
  // preference over would cover the whole screen on arrival.
  const narrow = useMediaQuery(BREAKPOINT.narrow);
  const [assistantOverlay, setAssistantOverlay] = useState(false);
  const assistantVisible = narrow ? assistantOverlay : layout.inspectorOpen;

  useEffect(() => {
    if (!narrow) setAssistantOverlay(false);
  }, [narrow]);
  const mainRef = useRef<HTMLDivElement>(null);

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const runningTasks = tasks.filter((t) => t.running || t.status === 'running');

  const commands = useMemo<Command[]>(() => {
    const navCommands: Command[] = NAV.map((n) => ({
      id: `go.${n.id}`,
      label: `Go to ${n.label}`,
      group: 'Navigate',
      icon: n.icon,
      keywords: [n.id, n.label],
      run: () => setScreen(n.id),
    }));

    const workspaceCommands: Command[] = workspaces.slice(0, 12).map((w) => ({
      id: `ws.${w.id}`,
      label: `Open ${w.name}`,
      group: 'Workspaces',
      icon: <IconFolder />,
      keywords: [w.name, 'workspace', 'project'],
      run: () => {
        void openWorkspace(w.id);
        setScreen('workspace');
      },
    }));

    const actions: Command[] = [
      {
        id: 'action.newTask',
        label: 'New task',
        group: 'Actions',
        shortcut: 'mod+n',
        icon: <IconActivity />,
        keywords: ['run', 'agent', 'build'],
        run: () => setScreen('workspace'),
      },
      {
        id: 'action.terminal',
        label: 'Toggle terminal',
        group: 'Actions',
        shortcut: 'mod+j',
        icon: <IconTerminal />,
        run: () => patchLayout({ drawerOpen: !layout.drawerOpen, drawerTab: 'terminal' }),
      },
      {
        id: 'action.inspector',
        label: layout.inspectorOpen ? 'Hide assistant panel' : 'Show assistant panel',
        group: 'Actions',
        shortcut: 'mod+i',
        icon: <IconPanelRight />,
        run: () => patchLayout({ inspectorOpen: !layout.inspectorOpen }),
      },
      {
        id: 'action.sidebar',
        label: layout.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
        group: 'Actions',
        shortcut: 'mod+b',
        icon: <IconSidebar />,
        run: () => patchLayout({ sidebarCollapsed: !layout.sidebarCollapsed }),
      },
      {
        id: 'action.discover',
        label: 'Discover providers and models',
        group: 'Actions',
        icon: <IconRefresh />,
        keywords: ['refresh', 'scan', 'find'],
        run: async () => {
          await api.discover();
          await useStore.getState().refreshModels();
          await useStore.getState().refreshProviders();
        },
      },
      {
        id: 'action.theme',
        label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} appearance`,
        group: 'Appearance',
        keywords: ['dark', 'light', 'theme'],
        run: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'action.compare',
        label: 'Compare models',
        group: 'Actions',
        icon: <IconCpu />,
        run: () => setScreen('models'),
      },
      {
        id: 'action.usage',
        label: 'View usage and cost',
        group: 'Actions',
        icon: <IconBarChart />,
        run: () => setScreen('usage'),
      },
    ];

    const modelCommands: Command[] = models.slice(0, 40).map((m) => ({
      id: `model.${m.id}`,
      label: m.displayName,
      description: `${m.providerId} · ${m.free ? 'free' : m.pricing.kind.toLowerCase()}`,
      group: 'Models',
      keywords: [m.providerId, m.providerModelId, ...m.tags],
      run: () => setScreen('models'),
    }));

    return [...actions, ...navCommands, ...workspaceCommands, ...modelCommands];
  }, [layout, models, openWorkspace, patchLayout, setScreen, setTheme, theme, workspaces]);

  const palette = useCommandPalette(commands);

  // Application-level shortcuts. Anything that is also a command lives in the
  // palette too, so there is one place to discover it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        patchLayout({ sidebarCollapsed: !layout.sidebarCollapsed });
      } else if (key === 'j') {
        e.preventDefault();
        patchLayout({ drawerOpen: !layout.drawerOpen });
      } else if (key === 'i') {
        e.preventDefault();
        patchLayout({ inspectorOpen: !layout.inspectorOpen });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layout, patchLayout]);

  const Screen = SCREENS[screen];
  const sections: { key: 'work' | 'infrastructure'; title: string }[] = [
    { key: 'work', title: 'Workspace' },
    { key: 'infrastructure', title: 'Infrastructure' },
  ];

  return (
    <div className="app">
      <a className="mrd-skip-link" href="#main">
        Skip to content
      </a>

      <Toolbar>
        <div className="app__brand">
          <IconButton
            className="app__nav-toggle"
            label="Show navigation"
            icon={<IconMenu />}
            size="sm"
            onClick={() => setMobileNavOpen((v) => !v)}
          />
          <Mark className="app__brand-mark" />
          <span className="app__brand-name">Meridian</span>
        </div>

        <ToolbarSeparator />

        <ToolbarGroup className="app__toolbar-context">
          {activeWorkspace ? (
            <>
              <IconFolder />
              <span className="mrd-truncate">{activeWorkspace.name}</span>
              <StatusChip status={activeWorkspace.privacyMode === 'STRICT_LOCAL' ? 'ready' : 'unknown'} label={privacyLabel(activeWorkspace.privacyMode)} size="sm" />
            </>
          ) : (
            <span className="mrd-secondary">No workspace open</span>
          )}
        </ToolbarGroup>

        <div className="mrd-spacer" />

        <ToolbarGroup className="app__toolbar-actions">
          {runningTasks.length > 0 && (
            <StatusChip status="busy" label={`${runningTasks.length} running`} size="sm" />
          )}
          <Tooltip content={<span>Command palette <Kbd shortcut="mod+k" /></span>}>
            <Button className="app__search" variant="secondary" size="sm" icon={<IconCommand />} onClick={() => palette.setOpen(true)}>
              Search
            </Button>
          </Tooltip>
          <ToolbarSeparator className="app__panel-toggles" />
          <IconButton
            label={assistantVisible ? 'Hide assistant' : 'Show assistant'}
            icon={<IconPanelRight />}
            size="sm"
            pressed={assistantVisible}
            onClick={() => (narrow ? setAssistantOverlay((v) => !v) : patchLayout({ inspectorOpen: !layout.inspectorOpen }))}
          />
          <IconButton
            className="app__panel-toggles"
            label={layout.drawerOpen ? 'Hide terminal' : 'Show terminal'}
            icon={<IconPanelBottom />}
            size="sm"
            pressed={layout.drawerOpen}
            onClick={() => patchLayout({ drawerOpen: !layout.drawerOpen })}
          />
        </ToolbarGroup>
      </Toolbar>

      <div className="app__body">
        <Sidebar
          collapsed={layout.sidebarCollapsed}
          className={`app__sidebar${mobileNavOpen ? ' app__sidebar--open' : ''}`}
          onToggle={() => patchLayout({ sidebarCollapsed: !layout.sidebarCollapsed })}
        >
          {sections.map((section) => (
            <SidebarSection key={section.key} title={section.title}>
              {NAV.filter((n) => n.section === section.key).map((n) => (
                <SidebarItem
                  key={n.id}
                  icon={n.icon}
                  label={n.label}
                  active={screen === n.id}
                  onClick={() => {
                    setScreen(n.id);
                    setMobileNavOpen(false);
                  }}
                  badge={n.id === 'tasks' && runningTasks.length ? String(runningTasks.length) : undefined}
                />
              ))}
            </SidebarSection>
          ))}
        </Sidebar>

        <main className="app__main" id="main" ref={mainRef} tabIndex={-1}>
          <div className="app__stage">
            <div className="app__content">
              <Screen />
            </div>
            {layout.inspectorOpen && !narrow && <Inspector />}
          </div>
          {layout.drawerOpen && <Drawer />}
        </main>
      </div>

      <StatusBar
        left={
          <>
            <StatusChip
              status={connection === 'open' ? 'ready' : connection === 'connecting' ? 'busy' : 'offline'}
              label={connection === 'open' ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Offline'}
              size="sm"
            />
            {info && (
              <span className="mrd-caption app__statusline mrd-truncate">
                {info.counts.models} models · {info.counts.providersConfigured} providers
              </span>
            )}
          </>
        }
        right={
          <>
            {info?.sandbox.degradedReason && <StatusChip status="degraded" label="Sandbox degraded" size="sm" />}
            {info && !info.allowPaid && <span className="mrd-caption app__statusline">Paid routing off</span>}
            <span className="mrd-caption">:{info?.port ?? 4639}</span>
          </>
        }
      />

      {assistantOverlay && narrow && (
        <>
          <div className="app__scrim" onClick={() => setAssistantOverlay(false)} aria-hidden="true" />
          <div className="app__inspector-overlay">
            <Inspector />
          </div>
        </>
      )}

      {mobileNavOpen && <div className="app__scrim" onClick={() => setMobileNavOpen(false)} aria-hidden="true" />}

      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} commands={commands} />
      <Toasts />
    </div>
  );
}

function privacyLabel(mode: string): string {
  switch (mode) {
    case 'STRICT_LOCAL':
      return 'Local only';
    case 'TRUSTED_ONLY':
      return 'Trusted providers';
    case 'FREE_PROVIDERS':
      return 'Free providers';
    default:
      return 'Any provider';
  }
}
