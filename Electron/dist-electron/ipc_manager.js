"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const net = require("node:net");
const path = require("node:path");
const node_events = require("node:events");
const node_worker_threads = require("node:worker_threads");
const log_manager = require("./log_manager.js");
const message = require("./message.js");
const thread_manager = require("./thread_manager.js");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const net__namespace = /* @__PURE__ */ _interopNamespaceDefault(net);
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
class TCPClient {
  /**
   * Create a TCPClient.
   * @param host Hostname or IP address to connect to.
   * @param port TCP port to connect to.
   * @param timeoutMs Max time to keep retrying connection (ms).
   * @param retryDelayMs Delay between connection retries (ms).
   */
  constructor(host, port, timeoutMs = 1e4, retryDelayMs = 500, handlers = {}) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.onFrame = handlers.onFrame;
    this.onConnect = handlers.onConnect;
    this.onClose = handlers.onClose;
    this.onError = handlers.onError;
    this.client.on("data", (data) => {
      let offset = 0;
      while (offset < data.length) {
        if (!this.frame) {
          const count2 = Math.min(message.PREFIX_SIZE - this.prefixBytes, data.length - offset);
          data.copy(this.prefixBuffer, this.prefixBytes, offset, offset + count2);
          this.prefixBytes += count2;
          offset += count2;
          if (this.prefixBytes < message.PREFIX_SIZE) break;
          let prefix;
          try {
            prefix = message.decodePrefix(this.prefixBuffer);
          } catch (err) {
            log_manager.electronError("Invalid message prefix: %s", err.message);
            this.client.destroy();
            return;
          }
          this.frame = Buffer.allocUnsafeSlow(message.PREFIX_SIZE + prefix.length);
          this.prefixBuffer.copy(this.frame);
          this.frameBytes = message.PREFIX_SIZE;
        }
        const count = Math.min(this.frame.length - this.frameBytes, data.length - offset);
        data.copy(this.frame, this.frameBytes, offset, offset + count);
        this.frameBytes += count;
        offset += count;
        if (this.frameBytes < this.frame.length) break;
        const frame = this.frame;
        this.frame = null;
        this.prefixBytes = 0;
        if (this.onFrame) this.onFrame(frame);
      }
    });
    this.client.on("close", () => {
      if (this.prefixBytes || this.frame)
        log_manager.electronError("Connection closed with an incomplete message frame.");
      this.connected = false;
      log_manager.electronInfo("Connection closed");
      if (!this.retryTimer) this.finish();
    });
    this.client.on("error", (err) => {
      if (err.code === "ECONNREFUSED" && !this.connected && !this.stopping) {
        if (Date.now() - this.startTime < this.timeoutMs) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.stopping) this.tryConnect();
          }, this.retryDelayMs);
        } else {
          log_manager.electronError(`TCP Client Error: Connection refused, timed out after ${this.timeoutMs}ms`);
          if (this.onError) this.onError(err.message);
          this.client.destroy();
        }
      } else {
        log_manager.electronError("TCP Client Error: %s", err.message);
        if (this.onError) this.onError(err.message);
        this.client.destroy();
      }
    });
    this.client.on("connect", () => {
      this.connected = true;
      log_manager.electronInfo(`Connected to TCP server on ${this.port}`);
      if (this.onConnect) this.onConnect();
    });
    this.tryConnect();
  }
  client = new net__namespace.Socket();
  connected = false;
  startTime = Date.now();
  prefixBuffer = Buffer.alloc(message.PREFIX_SIZE);
  prefixBytes = 0;
  frame = null;
  frameBytes = 0;
  onFrame;
  onConnect;
  onClose;
  onError;
  stopping = false;
  finished = false;
  retryTimer = null;
  /**
   * Attempt to connect to the configured host/port.
   * On success, marks the client as connected.
   */
  tryConnect() {
    this.client.connect(this.port, this.host);
  }
  /**
   * Send a complete Fray frame.
   */
  send(frame) {
    if (!this.connected) throw new Error("Cannot send: TCP client is not connected.");
    this.client.write(frame);
  }
  /**
   * Gracefully end the TCP connection.
   */
  close() {
    log_manager.electronInfo("Client connection ending.");
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.connected) this.client.end();
    else {
      this.client.destroy();
      this.finish();
    }
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.onClose) this.onClose();
  }
}
class IPCManager extends node_events.EventEmitter {
  constructor(host, port, threads = new thread_manager.ThreadManager()) {
    super();
    this.threads = threads;
    const { port1, port2 } = new node_worker_threads.MessageChannel();
    this.router = threads.spawn(
      "electron-messages",
      path__namespace.join(__dirname, "message_worker.js"),
      { port: port1 },
      [port1]
    );
    let heartbeat = 0;
    const beat = () => this.router.postMessage({ type: "heartbeat", heartbeat: ++heartbeat });
    beat();
    this.heartbeatTimer = setInterval(beat, 1e3);
    this.heartbeatTimer.unref();
    this.network = threads.spawn(
      "network",
      path__namespace.join(__dirname, "network_worker.js"),
      { host, port, routerPort: port2 },
      [port2]
    );
    this.network.on("message", (event) => {
      if (event.type === "connected") {
        this.connected = true;
        this.emit("connected");
      } else if (event.type === "closed") {
        this.connected = false;
        this.emit("disconnected");
      } else if (event.type === "error") {
        log_manager.electronError("Network thread: %s", event.message);
      }
    });
    this.router.on("message", (event) => {
      if (event.type === "message") {
        const frame = Buffer.from(event.frame);
        this.emit("message", {
          prefix: event.prefix,
          header: event.header,
          payload: frame.subarray(message.PREFIX_SIZE + event.prefix.headerLength)
        });
      } else if (event.type === "forward") {
        if (event.destination === "engine") {
          if (this.connected && !this.closing) this.network.postMessage({ type: "send", frame: Buffer.from(event.frame) });
          else log_manager.electronError("Cannot forward frame: TCP client is not connected.");
        } else {
          this.emit("renderer-frame", event.frame, event.broadcast === true);
        }
      } else if (event.type === "peer-ready") {
        this.emit("peer-ready", event.kind);
      } else if (event.type === "log") {
        if (event.level === "warn") log_manager.electronWarn("Message thread: %s", event.message);
        else log_manager.electronInfo("Message thread: %s", event.message);
      } else if (event.type === "error") {
        log_manager.electronError("Message thread: %s", event.message);
      }
    });
    const workers = [["network", this.network], ["electron-messages", this.router]];
    for (const [name, worker] of workers) {
      worker.on("exit", () => {
        if (!this.closing) {
          log_manager.electronWarn("Thread %s stopped; closing IPC.", name);
          this.close();
        }
      });
    }
  }
  connected = false;
  closing = false;
  closePromise = null;
  router;
  network;
  heartbeatTimer;
  /**
   * Hands a frame to the router thread and returns at once. The router sends it now if its destination is ready,
   * and otherwise holds it until the destination is ready or the header's ttlMs runs out. Nothing comes back.
   */
  send(frame) {
    if (this.closing) throw new Error("Cannot send: IPC is closing.");
    const bytes = Uint8Array.from(frame);
    this.router.postMessage({ type: "frame", source: "local", frame: bytes.buffer }, [bytes.buffer]);
  }
  /** Tells the router that a neighbor can no longer be reached, so messages for it wait in the queue again. */
  markNotReady(kind) {
    if (!this.closing) this.router.postMessage({ type: "not-ready", kind });
  }
  routeRendererFrame(frame) {
    if (this.closing) throw new Error("Cannot route frame: IPC is closing.");
    const bytes = Uint8Array.from(frame);
    this.router.postMessage({ type: "frame", frame: bytes.buffer }, [bytes.buffer]);
  }
  close(finalFrame = null) {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearInterval(this.heartbeatTimer);
    this.closePromise = this.stop(finalFrame);
    return this.closePromise;
  }
  async stop(finalFrame) {
    this.network.postMessage({ type: "shutdown", frame: this.connected ? finalFrame : null });
    if (!this.threads.runningNames().includes("network"))
      this.router.postMessage({ type: "shutdown" });
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 1e3);
    });
    const names = ["network", "electron-messages"];
    const stopped = await Promise.race([this.threads.wait(names).then(() => true), timeout]);
    clearTimeout(timer);
    if (!stopped) {
      log_manager.electronWarn(
        "Waiting on threads: %s; terminating.",
        this.threads.runningNames().filter((name) => names.includes(name)).join(", ")
      );
      await this.threads.terminate(names);
    }
    this.connected = false;
  }
}
exports.IPCManager = IPCManager;
exports.TCPClient = TCPClient;
//# sourceMappingURL=ipc_manager.js.map
