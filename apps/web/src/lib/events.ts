import type { FallbackEvent, GenerationJob, ProviderHealth, UsageRecord } from '@meridian/shared';

/** Mirrors the gateway's ServerEvent union. */
export type ServerEvent =
  | { type: 'task'; event: TaskEvent }
  | { type: 'usage'; record: UsageRecord }
  | { type: 'fallback'; event: FallbackEvent }
  | { type: 'health'; health: ProviderHealth }
  | { type: 'generation'; job: GenerationJob }
  | { type: 'discovery'; providerId: string; added: number; removed: number; total: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'model-change'; change: { modelId: string; kind: string } };

export type TaskEvent =
  | { type: 'task-update'; task: import('@meridian/shared').AgentTask }
  | { type: 'step-update'; step: import('@meridian/shared').TaskStep }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'diff'; changes: import('@meridian/shared').FileChange[] };

export type AgentEvent =
  | { type: 'step-start'; stepId: string; role: string; label: string }
  | { type: 'model-start'; stepId: string; modelId: string; providerId: string }
  | { type: 'text'; stepId: string; delta: string }
  | { type: 'tool-start'; stepId: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool-end'; stepId: string; record: import('@meridian/shared').ToolCallRecord }
  | { type: 'fallback'; stepId: string; event: FallbackEvent }
  | { type: 'step-end'; stepId: string; summary: string; usage: import('@meridian/shared').Usage };

export type ConnectionState = 'connecting' | 'open' | 'closed';

/**
 * The live connection to the gateway.
 *
 * WebSocket first, because it is bidirectional-capable and cheap; SSE as the
 * fallback for proxies that will not upgrade. Reconnection uses exponential
 * backoff with jitter so a gateway restart does not produce a thundering herd
 * from every open tab.
 */
export class EventStream {
  private socket: WebSocket | null = null;
  private source: EventSource | null = null;
  private readonly listeners = new Set<(e: ServerEvent) => void>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private state: ConnectionState = 'closed';

  connect(): void {
    this.closed = false;
    this.openSocket();
  }

  onEvent(fn: (e: ServerEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStateChange(fn: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(fn);
    fn(this.state);
    return () => this.stateListeners.delete(fn);
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    for (const fn of this.stateListeners) fn(s);
  }

  private emit(raw: string): void {
    let evt: ServerEvent;
    try {
      evt = JSON.parse(raw) as ServerEvent;
    } catch {
      return;
    }
    for (const fn of this.listeners) fn(evt);
  }

  private openSocket(): void {
    if (this.closed) return;
    this.setState('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      const socket = new WebSocket(`${proto}//${location.host}/api/events/ws`);
      this.socket = socket;
      socket.onopen = () => {
        this.attempts = 0;
        this.setState('open');
      };
      socket.onmessage = (e: MessageEvent<string>) => this.emit(e.data);
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        this.socket = null;
        this.setState('closed');
        // A socket that never opened suggests the upgrade is being blocked, so
        // the next attempt goes to SSE rather than retrying the same wall.
        if (this.attempts === 0) this.openEventSource();
        else this.scheduleReconnect();
      };
    } catch {
      this.openEventSource();
    }
  }

  private openEventSource(): void {
    if (this.closed) return;
    this.setState('connecting');
    try {
      const source = new EventSource('/api/events');
      this.source = source;
      source.onopen = () => {
        this.attempts = 0;
        this.setState('open');
      };
      source.onmessage = (e: MessageEvent<string>) => this.emit(e.data);
      source.onerror = () => {
        source.close();
        this.source = null;
        this.setState('closed');
        this.scheduleReconnect();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return;
    this.attempts += 1;
    const base = Math.min(30_000, 500 * 2 ** Math.min(this.attempts, 6));
    const delay = base / 2 + Math.random() * (base / 2);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.openSocket();
    }, delay);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.source?.close();
    this.socket = null;
    this.source = null;
    this.setState('closed');
  }
}

export const eventStream = new EventStream();
