import type { HealthReport } from './neighbor_monitor';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uint64(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

export function parseHealthReport(value: unknown): HealthReport {
  if (!record(value) || !uint64(value.processedCount) || !uint64(value.progressAgeMs) ||
      !uint64(value.heartbeat) || !Array.isArray(value.queues))
    throw new Error('Invalid health report.');
  const queues = value.queues.map((queue: unknown) => {
    if (!record(queue) || typeof queue.destination !== 'number' || !Number.isInteger(queue.destination) ||
        !uint64(queue.depth) || !uint64(queue.oldestAgeMs))
      throw new Error('Invalid health queue.');
    return { destination: queue.destination, depth: queue.depth, oldestAgeMs: queue.oldestAgeMs };
  });
  return { processedCount: value.processedCount, progressAgeMs: value.progressAgeMs,
    heartbeat: value.heartbeat, queues };
}
