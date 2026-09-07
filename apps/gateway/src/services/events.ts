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
  | { type: 'control-plane'; kind: 'skill' | 'assignment' | 'profile'; detail: string };

export type Subscriber = (event: ServerEvent) => void;

/**
 * A small in-process pub/sub for live UI updates.
 *
 * The gateway is a single node by design, so a broker would be infrastructure
 * without a purpose. A slow or broken subscriber is dropped rather than allowed
 * to block the publisher — a stalled WebSocket must never stall a task.
 */
export class EventBus {
  private readonly subscribers = new Set<Subscriber>();
  private readonly logger: Logger;
  /** The last few events, so a client that connects mid-task catches up. */
  private readonly recent: ServerEvent[] = [];
  private static readonly RECENT_LIMIT = 50;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  publish(event: ServerEvent): void {
    this.recent.push(event);
    if (this.recent.length > EventBus.RECENT_LIMIT) this.recent.shift();
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (e) {
        this.subscribers.delete(fn);
        this.logger.debug('dropped a failing event subscriber', { errorCode: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  replay(): ServerEvent[] {
    return [...this.recent];
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  close(): void {
    this.subscribers.clear();
  }
}
