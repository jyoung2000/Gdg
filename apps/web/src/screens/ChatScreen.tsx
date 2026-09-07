import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  ChatMessage,
  ChatMessageList,
  Composer,
  Dialog,
  EmptyState,
  Field,
  Input,
  ModePicker,
  Meter,
  Panel,
  RoutingExplanation,
  SegmentedControl,
  Select,
  Stack,
  StatusChip,
  TextArea,
  IconMessageSquare,
  IconMonitor,
  IconSparkle,
} from '@meridian/ui';
import { formatCost, type RoutingMode, type RoutingReason } from '@meridian/shared';
import { api, streamChat } from '../lib/api.js';
import { bestPicks } from '../lib/picks.js';
import { buildUserContent } from '../lib/attach.js';
import { useStore } from '../lib/store.js';
import { Screen } from './Screen.js';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  provider?: string;
  cost?: number;
  tokens?: number;
  routing?: RoutingReason;
  streaming?: boolean;
  error?: string;
}

/**
 * Direct chat, routed automatically.
 *
 * This is the simplest expression of the product's promise: type, send, and the
 * gateway decides which model answers. The routing explanation is one click
 * away rather than hidden, so "it chose for me" never means "I cannot find out
 * what it chose".
 */
export function ChatScreen(): React.JSX.Element {
  const routingMode = useStore((s) => s.routingMode);
  const setRoutingMode = useStore((s) => s.setRoutingMode);
  const vocabulary = useStore((s) => s.vocabulary);
  const info = useStore((s) => s.info);

  const [messages, setMessages] = useState<Message[]>([]);
  const [value, setValue] = useState('');
  const [running, setRunning] = useState(false);
  const [explaining, setExplaining] = useState<string | null>(null);
  /**
   * Normal AI unless the user says otherwise, on every visit.
   *
   * Deliberately not remembered: a mode that hands a model the pointer and
   * keyboard should be chosen deliberately each time, not inherited from a
   * decision made in some earlier session the user has forgotten about.
   */
  const [agentMode, setAgentMode] = useState<'chat' | 'computer'>('chat');
  const [handover, setHandover] = useState<string | null>(null);
  /** Files staged on the composer for the next message. */
  const [attachments, setAttachments] = useState<File[]>([]);
  /**
   * The active project — a workspace whose folder, files and standing
   * instructions become shared context for every message. Remembered, and
   * cleared to "none" if that workspace no longer exists.
   */
  const [projectId, setProjectId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('meridian.chat.project') || null;
    } catch {
      return null;
    }
  });
  const [managingProject, setManagingProject] = useState(false);
  const chooseProject = useCallback((next: string | null): void => {
    setProjectId(next);
    try {
      if (next) localStorage.setItem('meridian.chat.project', next);
      else localStorage.removeItem('meridian.chat.project');
    } catch {
      /* preference-only */
    }
  }, []);
  /**
   * Reasoning effort. Unlike the agent mode, this is remembered: it is a
   * harmless preference, and someone who wants their models to think hard
   * usually wants that to stick. `off` sends nothing and leaves the provider's
   * own default in place.
   */
  const [effort, setEffort] = useState<'off' | 'minimal' | 'low' | 'medium' | 'high'>(() => {
    try {
      const saved = localStorage.getItem('meridian.chat.effort');
      return saved === 'minimal' || saved === 'low' || saved === 'medium' || saved === 'high' ? saved : 'off';
    } catch {
      return 'off';
    }
  });
  const chooseEffort = useCallback((next: typeof effort): void => {
    setEffort(next);
    try {
      localStorage.setItem('meridian.chat.effort', next);
    } catch {
      // A browser that refuses storage still gets a working control this session.
    }
  }, []);
  /**
   * Which model answers. "auto" is the router's choice; anything else pins a
   * model from the curated menu. Remembered, but never trusted blindly: a
   * remembered model that discovery no longer lists falls back to auto rather
   * than pinning something that cannot answer.
   */
  const [modelChoice, setModelChoice] = useState<string>(() => {
    try {
      return localStorage.getItem('meridian.chat.model') ?? 'auto';
    } catch {
      return 'auto';
    }
  });
  const chooseModel = useCallback((next: string): void => {
    setModelChoice(next);
    try {
      localStorage.setItem('meridian.chat.model', next);
    } catch {
      // Storage refusal only costs the memory, not the control.
    }
  }, []);

  const models = useStore((s) => s.models);
  const pools = useStore((s) => s.pools);
  const workspaces = useStore((s) => s.workspaces);
  const activeProject = projectId && workspaces.some((w) => w.id === projectId) ? projectId : null;
  const refreshModels = useStore((s) => s.refreshModels);
  const refreshPools = useStore((s) => s.refreshPools);

  useEffect(() => {
    // The menu and the limit display both come from live data; fetch on entry
    // and let discovery events keep them fresh from then on.
    void refreshModels();
    void refreshPools();
  }, [refreshModels, refreshPools]);

  /** The best free and low-cost models, straight out of live discovery. */
  const picks = useMemo(() => bestPicks(models), [models]);

  // A pinned model that discovery no longer lists must not be pinned.
  const effectiveModel = modelChoice !== 'auto' && !models.some((m) => m.id === modelChoice) ? 'auto' : modelChoice;
  const abortRef = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const toast = useStore((s) => s.toast);
  const setScreen = useStore((s) => s.setScreen);

  const send = useCallback(async () => {
    const prompt = value.trim();
    if (!prompt || running) return;

    // Computer mode never starts from the composer alone. Pressing Enter is a
    // reflex; handing over the pointer and keyboard should not be.
    if (agentMode === 'computer') {
      setHandover(prompt);
      return;
    }

    // Fold attachments into the outgoing message: images become parts a vision
    // model sees, text files become fenced blocks. Anything unsupported is
    // reported rather than dropped in silence.
    const built = await buildUserContent(prompt, attachments);
    for (const s of built.skipped) toast({ level: 'warn', message: `Skipped ${s.name}`, detail: s.reason });

    const userId = `m${++seq.current}`;
    const assistantId = `m${++seq.current}`;
    const attachNote = attachments.length ? ` · ${attachments.length - built.skipped.length} attachment(s)` : '';
    setMessages((m) => [
      ...m,
      { id: userId, role: 'user', content: prompt + attachNote },
      { id: assistantId, role: 'assistant', content: '', streaming: true },
    ]);
    setValue('');
    setAttachments([]);
    setRunning(true);

    const ac = new AbortController();
    abortRef.current = ac;

    // Prior turns are plain strings; only the new message carries attachments.
    const history = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user' as const, content: built.content },
    ];

    const patch = (fn: (m: Message) => Message): void => {
      setMessages((all) => all.map((m) => (m.id === assistantId ? fn(m) : m)));
    };

    await streamChat(
      {
        messages: history,
        model: effectiveModel,
        meridian: { mode: routingMode, ...(activeProject ? { workspace_id: activeProject } : {}) },
        // Sent only when chosen; the gateway drops it for models that do not
        // reason, so a plain chat model is never handed a parameter it rejects.
        ...(effort !== 'off' ? { reasoning_effort: effort } : {}),
      },
      {
        onStart: (meta) => patch((m) => ({ ...m, model: meta.model, routing: meta.routing as RoutingReason })),
        onText: (delta) => patch((m) => ({ ...m, content: m.content + delta })),
        onUsage: (usage, cost) => patch((m) => ({ ...m, tokens: usage.total_tokens, cost })),
        onDone: () => patch((m) => ({ ...m, streaming: false })),
        onError: (message) => patch((m) => ({ ...m, streaming: false, error: message })),
      },
      ac.signal,
    );

    setRunning(false);
    abortRef.current = null;
  }, [activeProject, agentMode, attachments, effectiveModel, effort, messages, routingMode, running, toast, value]);

  const modes = vocabulary?.routingModes.filter((m) => m.primary) ?? [];

  return (
    <Screen
      title="Chat"
      subtitle="Ask anything. Meridian picks the model, and tells you why."
      actions={
        <Stack direction="row" gap={2} align="center">
          <Select
            size="sm"
            aria-label="Project — a folder of files and standing instructions that become shared context for the whole conversation."
            title="Project: a shared folder and instructions the AI can reference across the conversation."
            value={activeProject ?? 'none'}
            onChange={(e) => (e.target.value === '__manage' ? setManagingProject(true) : chooseProject(e.target.value === 'none' ? null : e.target.value))}
          >
            <option value="none">No project</option>
            {workspaces.length > 0 ? (
              <optgroup label="Projects">
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <option value="__manage">Manage projects…</option>
          </Select>
          <ModePicker
            value={routingMode}
            onChange={(m) => setRoutingMode(m as RoutingMode)}
            modes={modes.map((m) => ({ value: m.value, description: m.description }))}
            advanced={vocabulary?.routingModes.filter((m) => !m.primary).map((m) => ({ value: m.value, description: m.description })) ?? []}
          />
        </Stack>
      }
      padded={false}
    >
      <div className="chat">
        <ChatMessageList>
          {messages.length === 0 ? (
            <EmptyState
              icon={<IconMessageSquare />}
              title="Nothing yet"
              description={
                info && info.counts.models > 0
                  ? 'Ask a question. Meridian routes it to whichever model fits best under the current mode.'
                  : 'Connect a provider first — there are no models to route to yet.'
              }
            />
          ) : (
            messages.map((m) => (
              <ChatMessage
                key={m.id}
                role={m.role}
                content={m.error ? m.error : m.content}
                model={m.model}
                provider={m.provider}
                streaming={m.streaming}
                usage={m.tokens != null ? { totalTokens: m.tokens, cost: m.cost ?? 0 } : undefined}
                actions={
                  m.routing ? (
                    <button
                      className="chat__why mrd-focus-ring"
                      onClick={() => setExplaining(explaining === m.id ? null : m.id)}
                      aria-expanded={explaining === m.id}
                    >
                      Why this model?
                    </button>
                  ) : undefined
                }
              >
                {explaining === m.id && m.routing && (
                  <Panel elevation={1}>
                    <RoutingExplanation reason={m.routing} />
                  </Panel>
                )}
              </ChatMessage>
            ))
          )}
        </ChatMessageList>

        <div className="chat__composer">
          <Composer
            value={value}
            onChange={setValue}
            onSubmit={() => void send()}
            running={running}
            onStop={() => abortRef.current?.abort()}
            onAttach={() => undefined}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            placeholder="Ask anything, or attach images and files…"
            leftSlot={
              <Stack direction="row" gap={2} align="center">
                <SegmentedControl
                  label="What should handle this message"
                  size="sm"
                  value={agentMode}
                  onChange={(v) => setAgentMode(v)}
                  options={[
                    { value: 'chat', label: 'Normal AI', icon: <IconSparkle /> },
                    { value: 'computer', label: 'Computer agent', icon: <IconMonitor /> },
                  ]}
                />
                {agentMode === 'chat' ? (
                  <Select
                    size="sm"
                    aria-label="Which model answers. Auto lets Meridian route; the rest are the best free and low-cost models it has discovered."
                    title="Model. Auto routes; the list is the best free and low-cost models, kept up to date by discovery."
                    value={effectiveModel}
                    onChange={(e) => chooseModel(e.target.value)}
                  >
                    <option value="auto">Model: Auto</option>
                    {picks.length > 0 ? (
                      <optgroup label="Best free &amp; low-cost — found automatically">
                        {picks.map((p) => (
                          <option key={p.model.id} value={p.model.id}>
                            {p.model.displayName ?? p.model.providerModelId} · {p.priceLabel}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </Select>
                ) : null}
                {agentMode === 'chat' ? (
                  <Select
                    size="sm"
                    aria-label="Reasoning effort — how hard a thinking model should work. Ignored by models that do not reason."
                    title="Reasoning effort. Applies to reasoning-capable models; ignored by others."
                    value={effort}
                    onChange={(e) => chooseEffort(e.target.value as typeof effort)}
                  >
                    <option value="off">Effort: default</option>
                    <option value="minimal">Effort: minimal</option>
                    <option value="low">Effort: low</option>
                    <option value="medium">Effort: medium</option>
                    <option value="high">Effort: high</option>
                  </Select>
                ) : null}
              </Stack>
            }
            rightSlot={<UsagePill conversationCost={messages.reduce((sum, m) => sum + (m.cost ?? 0), 0)} />}
          />
        </div>
      </div>

      {/* Handing over the pointer and keyboard is a decision, so it is asked
          plainly and names exactly what the session will be allowed to do. */}
      <Dialog
        open={handover !== null}
        onOpenChange={(open) => {
          if (!open) setHandover(null);
        }}
        title="Let the agent control this computer?"
        description="This starts a computer session. You can watch it, pause it and stop it at any point."
        footer={
          <Stack direction="row" gap={2} justify="end">
            <Button variant="tertiary" onClick={() => setHandover(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                const task = handover;
                setHandover(null);
                if (!task) return;
                void api
                  .startComputerSession({ task, approvalMode: 'risky_actions', maxSteps: 20 })
                  .then((res) => {
                    setValue('');
                    setAgentMode('chat');
                    setScreen('computer');
                    toast({ level: 'info', message: 'The agent is now controlling this computer', detail: res.session.config.routingReason });
                  })
                  .catch((e: Error) => toast({ level: 'error', message: 'Could not start the session', detail: e.message }));
              }}
            >
              Start and hand over control
            </Button>
          </Stack>
        }
      >
        <Stack gap={2}>
          <strong>{handover}</strong>
          <span className="mrd-secondary">
            The agent will be able to see the screen, move the pointer, type and open applications. It will not be able to
            reach your files, run shell commands or use the network on its own.
          </span>
          <span className="mrd-caption">
            Anything risky stops and asks you first, and destructive actions always ask however the session is configured.
          </span>
          <span className="mrd-caption">Open the Computer screen to change what a session may do before starting it.</span>
        </Stack>
      </Dialog>

      <ProjectDialog
        open={managingProject}
        onClose={() => setManagingProject(false)}
        activeProject={activeProject}
        onActivate={(id) => {
          chooseProject(id);
          setManagingProject(false);
        }}
      />
    </Screen>
  );
}

/**
 * The composer's live usage and limit readout.
 *
 * Three numbers a person actually wants while chatting: what this conversation
 * has cost, what today has cost across the instance, and how close today is to
 * the routing pool's daily cap — the limit the router genuinely enforces, not a
 * decorative one. A pool without a budget is honestly unlimited and shown as
 * such. Clicking opens the full Usage screen.
 */
function UsagePill({ conversationCost }: { conversationCost: number }): React.JSX.Element {
  const usage = useStore((s) => s.liveUsage);
  const pools = useStore((s) => s.pools);
  const setScreen = useStore((s) => s.setScreen);

  const pool = pools[0] ?? null;
  const budget = pool?.budgetLimit ?? null;
  const spent = pool?.usage.spentToday ?? 0;
  const pct = budget && budget > 0 ? Math.min(100, (spent / budget) * 100) : null;

  const title = [
    `This conversation: ${formatCost(conversationCost)}`,
    `Today: ${formatCost(usage.cost)} · ${usage.requests} request(s) · ${usage.tokens.toLocaleString()} tokens`,
    budget ? `Daily cap (${pool?.name}): ${formatCost(spent)} of ${formatCost(budget)}` : 'No daily cap on the current pool',
    'Open Usage for the full breakdown',
  ].join('\n');

  return (
    <button
      type="button"
      className="chat__usage mrd-focus-ring"
      title={title}
      aria-label={title}
      onClick={() => setScreen('usage')}
    >
      <span className="mrd-caption mrd-numeric">{conversationCost > 0 ? formatCost(conversationCost) : 'Free so far'}</span>
      {pct !== null ? (
        <>
          <span className="chat__usage-meter">
            <Meter value={pct} max={100} threshold={80} label="Today against the daily cap" size="sm" />
          </span>
          <span className="mrd-caption mrd-numeric mrd-secondary">
            {formatCost(spent)}/{formatCost(budget!)}
          </span>
        </>
      ) : (
        <span className="mrd-caption mrd-secondary">no cap</span>
      )}
    </button>
  );
}

/**
 * Create and curate projects.
 *
 * A project is a workspace: a real folder on disk with files the AI can read
 * and a `MERIDIAN.md` at its root that holds the standing instructions. This
 * dialog is the human end of that — make one, write its instructions, add text
 * files to its folder, and see what is in it. Everything it does goes through
 * the ordinary workspace API, so a project made here is the same object the
 * Workspace screen edits and a task runs against.
 */
function ProjectDialog({
  open,
  onClose,
  activeProject,
  onActivate,
}: {
  open: boolean;
  onClose: () => void;
  activeProject: string | null;
  onActivate: (id: string | null) => void;
}): React.JSX.Element {
  const workspaces = useStore((s) => s.workspaces);
  const refreshWorkspaces = useStore((s) => s.refreshWorkspaces);
  const toast = useStore((s) => s.toast);

  const [selected, setSelected] = useState<string | null>(activeProject);
  const [instructions, setInstructions] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setSelected(activeProject ?? workspaces[0]?.id ?? null);
  }, [open, activeProject, workspaces]);

  // Load the selected project's instructions and file list.
  useEffect(() => {
    if (!open || !selected) {
      setInstructions('');
      setFiles([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const detail = await api.tree(selected, '', 6).catch(() => null);
      const flat: string[] = [];
      const walk = (n: { name: string; path: string; type: string; children?: unknown[] } | null): void => {
        if (!n) return;
        if (n.type === 'file') flat.push(n.path);
        for (const c of (n.children ?? []) as typeof flat extends never ? never : { name: string; path: string; type: string; children?: unknown[] }[]) walk(c);
      };
      walk(detail?.tree as never);
      const instr = await api.readFile(selected, 'MERIDIAN.md').then((r) => r.content).catch(() => '');
      if (!cancelled) {
        setFiles(flat.filter((f) => f !== 'MERIDIAN.md').sort());
        setInstructions(instr);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, selected]);

  const create = async (): Promise<void> => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const { workspace } = await api.createWorkspace({ name: newName.trim() });
      setNewName('');
      await refreshWorkspaces();
      setSelected(workspace.id);
      toast({ level: 'success', message: `Project "${workspace.name}" created` });
    } catch (e) {
      toast({ level: 'error', message: 'Could not create the project', detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const saveInstructions = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.writeFile(selected, 'MERIDIAN.md', instructions);
      toast({ level: 'success', message: 'Instructions saved to the project' });
    } catch (e) {
      toast({ level: 'error', message: 'Could not save instructions', detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const uploadText = async (fileList: FileList | null): Promise<void> => {
    if (!selected || !fileList?.length) return;
    setBusy(true);
    let added = 0;
    try {
      for (const file of [...fileList]) {
        if (file.size > 512 * 1024) {
          toast({ level: 'warn', message: `Skipped ${file.name}`, detail: 'larger than 512 KB' });
          continue;
        }
        const text = await file.text().catch(() => null);
        if (text == null) {
          toast({ level: 'warn', message: `Skipped ${file.name}`, detail: 'not a readable text file' });
          continue;
        }
        await api.writeFile(selected, file.name.replace(/[^A-Za-z0-9._-]/g, '_'), text);
        added += 1;
      }
      if (added) {
        const detail = await api.tree(selected, '', 6).catch(() => null);
        const flat: string[] = [];
        const walk = (n: { path: string; type: string; children?: unknown[] } | null): void => {
          if (!n) return;
          if (n.type === 'file') flat.push(n.path);
          for (const c of (n.children ?? []) as { path: string; type: string; children?: unknown[] }[]) walk(c);
        };
        walk(detail?.tree as never);
        setFiles(flat.filter((f) => f !== 'MERIDIAN.md').sort());
        toast({ level: 'success', message: `Added ${added} file(s) to the project` });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : onClose())} title="Projects" size="lg">
      <Stack direction="column" gap={4}>
        <Stack direction="column" gap={2}>
          <strong>Projects give the AI shared context</strong>
          <span className="mrd-secondary">
            A project is a folder of files plus standing instructions. Whichever project is active, every message in the
            conversation can reference its files, and its instructions always apply — the same idea as a project in other
            assistants, backed by a real workspace folder here.
          </span>
        </Stack>

        <Stack direction="row" gap={2} align="end" wrap>
          <Field label="New project" description="Creates a workspace folder you can fill with files.">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Q3 launch" />
          </Field>
          <Button variant="secondary" onClick={() => void create()} disabled={busy || !newName.trim()}>
            Create
          </Button>
        </Stack>

        {workspaces.length > 0 ? (
          <Field label="Project" description="The one whose files and instructions become context.">
            <Select value={selected ?? ''} onChange={(e) => setSelected(e.target.value || null)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <EmptyState title="No projects yet" description="Create one above to give the AI a folder of files to work from." />
        )}

        {selected ? (
          <>
            <Field
              label="Special instructions"
              description="Saved as MERIDIAN.md in the project. Prepended to every message while this project is active."
            >
              <TextArea rows={5} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="How should the AI work in this project? What should it always keep in mind?" />
            </Field>
            <Stack direction="row" gap={2} wrap>
              <Button variant="secondary" onClick={() => void saveInstructions()} disabled={busy}>
                Save instructions
              </Button>
              <label className="mrd-button mrd-button--secondary mrd-button--md" style={{ cursor: 'pointer' }}>
                Add files
                <input
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    void uploadText(e.target.files);
                    e.target.value = '';
                  }}
                />
              </label>
            </Stack>

            <Field label={`Files in this project (${files.length})`} description="Text files here are shared with the AI as project knowledge.">
              <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                {files.length ? (
                  <Stack direction="column" gap={1}>
                    {files.map((f) => (
                      <span key={f} className="mrd-caption mrd-numeric">
                        {f}
                      </span>
                    ))}
                  </Stack>
                ) : (
                  <span className="mrd-secondary">Empty. Add files above.</span>
                )}
              </div>
            </Field>
          </>
        ) : null}
      </Stack>
      <Stack direction="row" gap={2} justify="end" style={{ marginTop: 'var(--space-4)' }}>
        <Button variant="tertiary" onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" disabled={!selected} onClick={() => onActivate(selected)}>
          Use this project
        </Button>
      </Stack>
    </Dialog>
  );
}
