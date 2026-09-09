import type {
  FallbackEvent,
  GenerationJob,
  Logger,
  ProviderHealth,
  UsageRecord,
} from '@meridian/shared';
import type { TaskEvent } from '@meridian/agent-sdk';

/** Everything the gateway pushes to connected clients. */
export type ServerEvent =
  | { type: 'task'; event: TaskEvent }
  | { type: 'usage'; record: UsageRecord }
  | { type: 'fallback'; event: FallbackEvent }
  | { type: 'health'; health: ProviderHealth }
  | { type: 'generation'; job: GenerationJob }
  | { type: 'discovery'; providerId: string; added: number; removed: number; total: number }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'browser'; sessionId: string; entry: { at: number; kind: string; message: string } }
  | { type: 'model-change'; change: Omit<import('@meridian/shared').ModelChange, 'id'> }
  | { type: 'control-plane'; kind: 'skill' | 'assignment' | 'profile'; detail: string }
  | { type: 'computer'; event: import('@meridian/computer-sdk').AgentEvent };

export type Subscriber = (event: ServerEvent) => void;

/**
 * Whose work an event is about.
 *
 * `null` means the instance itself — a provider going down, a catalogue
 * refresh, a model retirement — and reaches everyone. Anything else names the
 * one person whose prompt, output, spend or screen the event carries.
 */
export interface EventAudience {
  userId: string | null;
}

/** Who is listening, and therefore what they may be shown. */
export interface EventViewer {
  userId: string | null;
  /** An administrator sees the whole instance, which is the job. */
  admin: boolean;
}

const EVERYONE: EventAudience = { userId: null };

/** Whether this viewer may see an event addressed to this audience. */
export function visibleTo(audience: EventAudience, viewer: EventViewer): boolean {
  if (audience.userId === null) return true;
  if (viewer.admin) return true;
  return viewer.userId != null && viewer.userId === audience.userId;
}

/**
 * A small in-process pub/sub for live UI updates.
 *
 * The gateway is a single node by design, so a broker would be infrastructure
 * without a purpose. A slow or broken subscriber is dropped rather than allowed
 * to block the publisher — a stalled WebSocket must never stall a task.
 */
export class EventBus {
  private readonly subscribers = new Set<{ fn: Subscriber; viewer: EventViewer }>();
  private readonly logger: Logger;
  /** The last few events, so a client that connects mid-task catches up. */
  private readonly recent: { event: ServerEvent; audience: EventAudience }[] = [];
  private static readonly RECENT_LIMIT = 50;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Listen as someone.
   *
   * The viewer is required rather than optional because the default used to be
   * "everything": one live stream carried every user's task prompts, outputs
   * and spend to anyone holding any API key on the instance.
   */
  subscribe(fn: Subscriber, viewer: EventViewer): () => void {
    const entry = { fn, viewer };
    this.subscribers.add(entry);
    return () => this.subscribers.delete(entry);
  }

  /**
   * `audience` defaults to the whole instance, so anything carrying one
   * person's content has to say so explicitly. The default is the safe one
   * only for events that are genuinely about the instance; the call sites that
   * carry user content name their owner, and the type makes that a decision
   * rather than an omission.
   */
  publish(event: ServerEvent, audience: EventAudience = EVERYONE): void {
    this.recent.push({ event, audience });
    if (this.recent.length > EventBus.RECENT_LIMIT) this.recent.shift();
    for (const entry of this.subscribers) {
      if (!visibleTo(audience, entry.viewer)) continue;
      try {
        entry.fn(event);
      } catch (e) {
        this.subscribers.delete(entry);
        this.logger.debug('dropped a failing event subscriber', { errorCode: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  /** The recent backlog this viewer is allowed to see. */
  replay(viewer: EventViewer): ServerEvent[] {
    return this.recent.filter((r) => visibleTo(r.audience, viewer)).map((r) => r.event);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  close(): void {
    this.subscribers.clear();
  }
}
