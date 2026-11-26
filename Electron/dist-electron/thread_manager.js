"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const node_worker_threads = require("node:worker_threads");
const log_manager = require("./log_manager.js");
class ThreadManager {
  constructor() {
    this.threads = /* @__PURE__ */ new Map();
  }
  spawn(name, filename, workerData, transferList = []) {
    if (this.threads.has(name)) throw new Error(`Thread already registered: ${name}`);
    const worker = new node_worker_threads.Worker(filename, { workerData, transferList });
    const exit = new Promise((resolve) => {
      worker.on("error", (err) => log_manager.electronError("Thread %s failed: %s", name, err.message));
      worker.once("exit", (code) => {
        this.threads.delete(name);
        if (code !== 0) log_manager.electronError("Thread %s exited with code %d.", name, code);
        resolve(code);
      });
    });
    this.threads.set(name, { worker, exit });
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
exports.ThreadManager = ThreadManager;
//# sourceMappingURL=thread_manager.js.map
