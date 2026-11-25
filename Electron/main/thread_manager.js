/* thread_manager.js */
const { Worker } = require('node:worker_threads');
const log = require('./log_manager');

class ThreadManager {
    constructor() {
        this.threads = new Map();
    }

    spawn(name, filename, workerData, transferList = []) {
        if (this.threads.has(name)) throw new Error(`Thread already registered: ${name}`);
        const worker = new Worker(filename, { workerData, transferList });
        const entry = { worker, exit: null };
        entry.exit = new Promise((resolve) => {
            worker.on('error', (err) => log.electronError('Thread %s failed: %s', name, err.message));
            worker.once('exit', (code) => {
                this.threads.delete(name);
                if (code !== 0) log.electronError('Thread %s exited with code %d.', name, code);
                resolve(code);
            });
        });
        this.threads.set(name, entry);
        return worker;
    }

    runningNames() {
        return [...this.threads.keys()];
    }

    async wait(names) {
        await Promise.all(names.map((name) => this.threads.get(name)?.exit));
    }

    async terminate(names) {
        await Promise.all(names.map((name) => this.threads.get(name)?.worker.terminate()));
    }
}

module.exports = { ThreadManager };
