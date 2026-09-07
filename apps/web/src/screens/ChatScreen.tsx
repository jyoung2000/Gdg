import { useCallback, useRef, useState } from 'react';
import {
  Button,
  ChatMessage,
  ChatMessageList,
  Composer,
  Dialog,
  EmptyState,
  ModePicker,
  Panel,
  RoutingExplanation,
  SegmentedControl,
  Stack,
  StatusChip,
  IconMessageSquare,
  IconMonitor,
  IconSparkle,
} from '@meridian/ui';
import { formatCost, type RoutingMode, type RoutingReason } from '@meridian/shared';
import { api, streamChat } from '../lib/api.js';
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

    const userId = `m${++seq.current}`;
    const assistantId = `m${++seq.current}`;
    setMessages((m) => [
      ...m,
      { id: userId, role: 'user', content: prompt },
      { id: assistantId, role: 'assistant', content: '', streaming: true },
    ]);
    setValue('');
    setRunning(true);

    const ac = new AbortController();
    abortRef.current = ac;

    const history = [...messages, { id: userId, role: 'user' as const, content: prompt }].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const patch = (fn: (m: Message) => Message): void => {
      setMessages((all) => all.map((m) => (m.id === assistantId ? fn(m) : m)));
    };

    await streamChat(
      { messages: history, meridian: { mode: routingMode } },
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
  }, [agentMode, messages, routingMode, running, value]);

  const modes = vocabulary?.routingModes.filter((m) => m.primary) ?? [];

  return (
    <Screen
      title="Chat"
      subtitle="Ask anything. Meridian picks the model, and tells you why."
      actions={
        <ModePicker
          value={routingMode}
          onChange={(m) => setRoutingMode(m as RoutingMode)}
          modes={modes.map((m) => ({ value: m.value, description: m.description }))}
          advanced={vocabulary?.routingModes.filter((m) => !m.primary).map((m) => ({ value: m.value, description: m.description })) ?? []}
        />
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
            placeholder="Ask anything…"
            leftSlot={
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
            }
            rightSlot={
              <Stack direction="row" gap={2} align="center">
                <StatusChip status="unknown" label={routingMode} size="sm" />
                {messages.some((m) => m.cost) && (
                  <span className="mrd-caption mrd-numeric">
                    {formatCost(messages.reduce((sum, m) => sum + (m.cost ?? 0), 0))}
                  </span>
                )}
              </Stack>
            }
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
    </Screen>
  );
}
