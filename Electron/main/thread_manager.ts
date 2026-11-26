/* thread_manager.js */
import { Worker, type WorkerOptions } from 'node:worker_threads';
import * as log from './log_manager';

interface ThreadEntry {
    worker: Worker;
    exit: Promise<number>;
}

export class ThreadManager {
    private readonly threads = new Map<string, ThreadEntry>();

    spawn(name: string, filename: string, workerData?: unknown, transferList: WorkerOptions['transferList'] = []): Worker {
        if (this.threads.has(name)) throw new Error(`Thread already registered: ${name}`);
        const worker = new Worker(filename, { workerData, transferList });
        const exit = new Promise<number>((resolve) => {
            worker.on('error', (err: Error) => log.electronError('Thread %s failed: %s', name, err.message));
            worker.once('exit', (code) => {
                this.threads.delete(name);
                if (code !== 0) log.electronError('Thread %s exited with code %d.', name, code);
                resolve(code);
            });
        });
        this.threads.set(name, { worker, exit });
        return worker;
    }

    runningNames(): string[] {
        return [...this.threads.keys()];
    }

    async wait(names: string[]): Promise<void> {
        await Promise.all(names.map((name) => this.threads.get(name)?.exit));
    }

    async terminate(names: string[]): Promise<void> {
        await Promise.all(names.map((name) => this.threads.get(name)?.worker.terminate()));
    }
}
