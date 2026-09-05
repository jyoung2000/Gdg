/** Exponential backoff with full jitter, capped. Deterministic when `rand` is supplied. */
export function backoffMs(attempt: number, baseMs = 250, capMs = 20_000, rand: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(rand() * exp);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Rejects with an AbortError-like message when the deadline passes. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** An AbortSignal that fires after `ms`, linked to an optional parent. */
export function timeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`timed out after ${ms}ms`)), ms);
  if (typeof t.unref === 'function') t.unref();
  parent?.addEventListener('abort', () => {
    clearTimeout(t);
    ac.abort(parent.reason);
  }, { once: true });
  return ac.signal;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatRelative(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}
