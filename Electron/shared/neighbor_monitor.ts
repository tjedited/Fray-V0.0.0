import type { NeighborState } from './outgoing_router';

export interface HealthReport {
  processedCount: string;
  progressAgeMs: string;
  heartbeat: string;
  queues: { destination: number; depth: string; oldestAgeMs: string }[];
}

interface Neighbor {
  since: number;
  lastHeard: number;
  healthExpectedSince: number | null;
  health: HealthReport | null;
  healthReceived: number;
  heartbeatChanged: number;
  queueProgress: number;
}

/** Router-thread-only local state. Times are monotonic milliseconds. */
export class NeighborMonitor {
  private readonly neighbors = new Map<number, Neighbor>();

  constructor(
    private readonly send: (neighbor: number, command: 'probe' | 'ping') => void,
    private readonly state: (neighbor: number) => NeighborState,
    private readonly changed: (neighbor: number, state: NeighborState) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(neighbor: number): void {
    const now = this.now();
    this.neighbors.set(neighbor, { since: now, lastHeard: now, healthExpectedSince: null,
      health: null, healthReceived: now, heartbeatChanged: now, queueProgress: now });
    this.setState(neighbor, 'probing');
  }

  observe(neighbor: number, ready: boolean): void {
    const entry = this.neighbors.get(neighbor);
    if (!entry) return;
    entry.lastHeard = this.now();
    if (ready && entry.healthExpectedSince === null) entry.healthExpectedSince = entry.lastHeard;
    // A request sent during startup is not itself a declaration of readiness.
    const state = this.state(neighbor);
    if (state !== 'degraded' && (ready || state === 'suspect' || state === 'down'))
      this.setState(neighbor, this.isDegraded(entry, entry.lastHeard) ? 'degraded' : 'ready');
  }

  report(neighbor: number, health: HealthReport): void {
    const entry = this.neighbors.get(neighbor);
    if (!entry) return;
    const now = this.now();
    const previous = entry.health;
    if (!previous || previous.heartbeat !== health.heartbeat) entry.heartbeatChanged = now;
    const queued = health.queues.some((queue) => queue.depth !== '0');
    const wasQueued = previous?.queues.some((queue) => queue.depth !== '0') ?? false;
    if (!queued || !wasQueued || previous?.processedCount !== health.processedCount) entry.queueProgress = now;
    entry.health = health;
    entry.healthReceived = now;
  }

  tick(): void {
    const now = this.now();
    for (const [neighbor, entry] of this.neighbors) {
      const state = this.state(neighbor);
      if (state === 'probing') {
        if (now - entry.since >= 10000) this.setState(neighbor, 'unreachable');
        else this.send(neighbor, 'probe');
      } else if (state === 'ready' || state === 'suspect' || state === 'degraded' || state === 'down') {
        const silence = now - entry.lastHeard;
        if (silence >= 10000) this.setState(neighbor, 'down');
        else if (silence >= 3000) this.setState(neighbor, 'suspect');
        else if (this.isDegraded(entry, now)) this.setState(neighbor, 'degraded');
        else if (state === 'degraded') this.setState(neighbor, 'ready');
        this.send(neighbor, 'ping');
      }
    }
  }

  private isDegraded(entry: Neighbor, now: number): boolean {
    if (!entry.health) return entry.healthExpectedSince !== null && now - entry.healthExpectedSince >= 3000;
    return now - entry.healthReceived >= 3000 || now - entry.heartbeatChanged >= 3000 ||
      (entry.health.queues.some((queue) => queue.depth !== '0') && now - entry.queueProgress >= 3000);
  }

  private setState(neighbor: number, state: NeighborState): void {
    if (this.state(neighbor) !== state) this.changed(neighbor, state);
  }
}
