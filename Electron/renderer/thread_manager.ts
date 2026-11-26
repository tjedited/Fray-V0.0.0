interface ThreadEntry {
  worker: Worker;
  stopping: Promise<void> | null;
  reject?: (error: Error) => void;
}

export class ThreadManager {
  private readonly threads = new Map<string, ThreadEntry>();
  private closing = false;
  private readonly failures: Error[] = [];

  constructor(private readonly onChange: (names: string[]) => void) {}

  spawn(name: string, worker: Worker): Worker {
    if (this.closing) throw new Error('Cannot spawn a thread while shutting down.');
    if (this.threads.has(name)) throw new Error(`Thread already registered: ${name}`);
    const entry: ThreadEntry = { worker, stopping: null };
    this.threads.set(name, entry);
    this.onChange(this.runningNames());
    worker.addEventListener('error', (event) => {
      const error = new Error(`Thread ${name} failed: ${event.message}`);
      this.failures.push(error);
      console.error(error.message);
      if (entry.reject) entry.reject(error);
      worker.terminate();
      this.threads.delete(name);
      this.onChange(this.runningNames());
    });
    return worker;
  }

  runningNames(): string[] {
    return [...this.threads.keys()];
  }

  stop(name: string): Promise<void> {
    const entry = this.threads.get(name);
    if (!entry) return Promise.resolve();
    if (entry.stopping) return entry.stopping;
    entry.stopping = new Promise<void>((resolve, reject) => {
      entry.reject = reject;
      entry.worker.addEventListener('message', function stopped({ data }: MessageEvent) {
        if (data.type !== 'stopped') return;
        entry.worker.removeEventListener('message', stopped);
        entry.worker.terminate();
        resolve();
      });
      entry.worker.postMessage({ type: 'shutdown' });
    }).then(() => {
      this.threads.delete(name);
      this.onChange(this.runningNames());
    });
    return entry.stopping;
  }

  async stopAll(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled(this.runningNames().map((name) => this.stop(name)));
    for (const result of results) {
      if (result.status === 'rejected' && !this.failures.includes(result.reason))
        this.failures.push(result.reason as Error);
    }
    if (this.failures.length) throw new AggregateError(this.failures, 'Renderer threads did not all stop cleanly.');
  }
}
