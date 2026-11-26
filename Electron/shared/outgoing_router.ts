/* The router thread's single source of truth about which neighbors are ready, plus the messages waiting for them.
 * Only the router thread may touch it, and nothing here waits on a neighbor. A message for a neighbor that is not
 * ready stays in its queue until the neighbor says it is ready, its time to live runs out, or the neighbor is declared
 * down and its queue is discarded. Mirrors Engine/fray/outgoing_router.hpp. */

interface Entry<TFrame> {
  frame: TFrame;
  queuedAt: number;
  /** Monotonic deadline in milliseconds, or null when the message never expires. */
  expires: number | null;
}

export type NeighborState = 'unknown' | 'probing' | 'ready' | 'suspect' | 'degraded' | 'down' | 'unreachable';

export interface QueueHealth {
  destination: number;
  depth: number;
  oldestAgeMs: number;
}

export class OutgoingRouter<TFrame> {
  private readonly states = new Map<number, NeighborState>();
  private readonly queues = new Map<number, Entry<TFrame>[]>();

  constructor(
    private readonly deliver: (neighbor: number, frame: TFrame) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  isReady(neighbor: number): boolean {
    return this.state(neighbor) === 'ready';
  }

  state(neighbor: number): NeighborState {
    return this.states.get(neighbor) ?? 'unknown';
  }

  setState(neighbor: number, state: NeighborState): boolean {
    if (state === 'ready') return this.markReady(neighbor);
    if (this.state(neighbor) === state) return false;
    this.states.set(neighbor, state);
    return true;
  }

  /** Number of messages still waiting for the neighbor. */
  queued(neighbor: number): number {
    return this.queues.get(neighbor)?.length ?? 0;
  }

  queueHealth(): QueueHealth[] {
    const now = this.now();
    return [...this.queues].map(([destination, queue]) => ({
      destination, depth: queue.length, oldestAgeMs: Math.max(0, Math.floor(now - queue[0].queuedAt)),
    }));
  }

  /**
   * Marks the neighbor ready and delivers its waiting messages in order, skipping any that expired.
   * Returns true only when the neighbor was not ready before, so callers act once per transition.
   */
  markReady(neighbor: number): boolean {
    if (this.isReady(neighbor)) return false;
    this.states.set(neighbor, 'ready');
    const waiting = this.queues.get(neighbor);
    this.queues.delete(neighbor);
    const now = this.now();
    for (const entry of waiting ?? [])
      if (entry.expires === null || entry.expires > now) this.deliver(neighbor, entry.frame);
    return true;
  }

  /** The neighbor can no longer be reached for now. Messages sent to it wait in its queue again. */
  markNotReady(neighbor: number): boolean {
    const wasReady = this.isReady(neighbor);
    this.states.delete(neighbor);
    return wasReady;
  }

  /**
   * For a neighbor declared down or unreachable: what was waiting for it may no longer make sense, so it is dropped.
   * Returns how many messages were dropped.
   */
  discardQueue(neighbor: number): number {
    const discarded = this.queued(neighbor);
    this.queues.delete(neighbor);
    return discarded;
  }

  /**
   * Delivers now if the neighbor is ready, otherwise queues. A ttlMs of 0 means the message never expires.
   * Returns true when the message was delivered immediately.
   */
  send(neighbor: number, frame: TFrame, ttlMs: number): boolean {
    if (this.isReady(neighbor)) {
      this.deliver(neighbor, frame);
      return true;
    }
    this.sweep();
    const queue = this.queues.get(neighbor) ?? [];
    const queuedAt = this.now();
    queue.push({ frame, queuedAt, expires: ttlMs > 0 ? queuedAt + ttlMs : null });
    this.queues.set(neighbor, queue);
    return false;
  }

  /** Drops every queued message whose time to live has run out. Returns how many were dropped. */
  sweep(): number {
    const now = this.now();
    let dropped = 0;
    for (const [neighbor, queue] of this.queues) {
      const kept = queue.filter((entry) => entry.expires === null || entry.expires > now);
      dropped += queue.length - kept.length;
      if (kept.length) this.queues.set(neighbor, kept);
      else this.queues.delete(neighbor);
    }
    return dropped;
  }
}
