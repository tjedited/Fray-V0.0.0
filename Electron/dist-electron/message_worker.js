"use strict";
const node_worker_threads = require("node:worker_threads");
const message = require("./message.js");
const message_router = require("./message_router.js");
const outgoing_router = require("./outgoing_router.js");
const neighbor_monitor = require("./shared/neighbor_monitor.js");
const health = require("./shared/health.js");
const frame_builder = require("./shared/frame_builder.js");
const { ProcessKind, Command } = message;
const SELF = ProcessKind.PROCESS_KIND_ELECTRON_MAIN;
const parent = node_worker_threads.parentPort;
const networkPort = node_worker_threads.workerData.port;
let invalid = false;
let monitorTimer;
const frames = frame_builder.createFrameBuilder(SELF, 2, message.buildFrame, message.processName);
let heartbeat = 0;
let processedCount = 0;
let lastProgress = performance.now();
const TARGET_KINDS = {
  engine: ProcessKind.PROCESS_KIND_ENGINE,
  "electron-renderer": ProcessKind.PROCESS_KIND_ELECTRON_RENDERER
};
const outgoing = new outgoing_router.OutgoingRouter((kind, bytes) => forward(kind === ProcessKind.PROCESS_KIND_ENGINE ? "engine" : "electron-renderer", bytes, false));
function control(kind, commandId, destinationId = 0, payload = new Uint8Array()) {
  const bytes = Uint8Array.from(frames.build({
    destination: kind,
    destinationId,
    command: commandId,
    payload,
    payloadType: commandId === Command.COMMAND_PONG ? message.PayloadType.PAYLOAD_TYPE_PROTOBUF : message.PayloadType.PAYLOAD_TYPE_NONE,
    messageType: commandId === Command.COMMAND_PONG ? message.MessageType.MESSAGE_TYPE_HEALTH_REPORT : message.MessageType.MESSAGE_TYPE_NONE
  }));
  routeFrame(bytes.buffer, "local");
}
function healthPayload() {
  outgoing.sweep();
  return message.HealthReport.encode(message.HealthReport.fromObject({
    processedCount,
    heartbeat,
    progressAgeMs: Math.floor(performance.now() - lastProgress),
    queues: outgoing.queueHealth()
  })).finish();
}
const monitor = new neighbor_monitor.NeighborMonitor(
  (kind, command) => {
    if (command === "probe") log("info", `Sending readiness probe to ${message.processName(kind)}.`);
    control(kind, command === "probe" ? Command.COMMAND_REQUEST_READY : Command.COMMAND_PING);
  },
  (kind) => outgoing.state(kind),
  (kind, state) => {
    if (state === "ready") {
      if (outgoing.markReady(kind)) parent.postMessage({ type: "peer-ready", kind });
    } else {
      outgoing.setState(kind, state);
      if (state === "down" || state === "unreachable") {
        outgoing.discardQueue(kind);
        parent.postMessage({ type: "peer-unavailable", kind });
      }
      if (state !== "probing") log("warn", `${message.processName(kind)} is ${state.toUpperCase()}.`);
    }
  }
);
function forward(destination, bytes, broadcast) {
  parent.postMessage({ type: "forward", destination, frame: bytes, broadcast }, [bytes]);
}
function log(level, text) {
  parent.postMessage({ type: "log", level, message: text });
}
function timeToLive(frame) {
  try {
    return message.parseFrame(frame).header.ttlMs;
  } catch {
    return 0;
  }
}
function noteReadiness(prefix, source) {
  const sender = prefix.senderKind;
  if (source === "local" || prefix.commandId !== Command.COMMAND_READY || sender === SELF || sender === ProcessKind.PROCESS_KIND_BROADCAST) return;
  if (outgoing.state(sender) !== "degraded" && outgoing.markReady(sender))
    parent.postMessage({ type: "peer-ready", kind: sender });
}
function routeFrame(bytes, source) {
  let frame;
  let prefix;
  try {
    frame = Buffer.from(bytes);
    prefix = message.decodePrefix(frame);
    if (frame.length !== message.PREFIX_SIZE + prefix.length)
      throw new Error("Message length does not match its prefix.");
  } catch (error) {
    parent.postMessage({ type: "error", message: `Invalid message frame: ${error.message}` });
    if (source === "network") {
      invalid = true;
      networkPort.postMessage({ type: "invalid" });
    }
    return;
  }
  const targets = message_router.routeMessage(prefix).filter((target) => !(target === "engine" && source === "network"));
  if (targets.length === 0) {
    parent.postMessage({
      type: "error",
      message: `Cannot route message: unsupported destination kind=${prefix.destinationKind} id=${prefix.destinationId}.`
    });
    return;
  }
  const broadcast = prefix.destinationKind === ProcessKind.PROCESS_KIND_BROADCAST;
  const queued = !broadcast && prefix.commandId !== Command.COMMAND_READY && prefix.commandId !== Command.COMMAND_REQUEST_READY && prefix.commandId !== Command.COMMAND_PING && prefix.commandId !== Command.COMMAND_PONG;
  let incoming = null;
  if (targets.includes("electron-main")) {
    try {
      incoming = message.parseFrame(frame);
    } catch (error) {
      parent.postMessage({ type: "error", message: `Invalid message header: ${error.message}` });
      if (source === "network") {
        invalid = true;
        networkPort.postMessage({ type: "invalid" });
      }
      return;
    }
  }
  if (queued || broadcast && prefix.commandId !== Command.COMMAND_READY && prefix.commandId !== Command.COMMAND_REQUEST_READY && prefix.commandId !== Command.COMMAND_PING && prefix.commandId !== Command.COMMAND_PONG) {
    processedCount++;
    lastProgress = performance.now();
  }
  if (source !== "local") {
    if (incoming && prefix.commandId === Command.COMMAND_PONG) {
      try {
        if (incoming.header.payloadType !== message.PayloadType.PAYLOAD_TYPE_PROTOBUF || incoming.header.messageType !== message.MessageType.MESSAGE_TYPE_HEALTH_REPORT)
          throw new Error("Unexpected health report type.");
        const decoded = message.HealthReport.decode(incoming.payload);
        monitor.report(prefix.senderKind, health.parseHealthReport(message.HealthReport.toObject(
          decoded,
          { defaults: true, longs: String }
        )));
      } catch (error) {
        parent.postMessage({ type: "error", message: `Invalid health report: ${error.message}` });
      }
    }
    if (incoming || prefix.commandId === Command.COMMAND_READY)
      monitor.observe(prefix.senderKind, prefix.commandId === Command.COMMAND_READY);
    noteReadiness(prefix, source);
    if (incoming && prefix.commandId === Command.COMMAND_PING)
      control(prefix.senderKind, Command.COMMAND_PONG, prefix.senderId, healthPayload());
  }
  targets.forEach((target, index) => {
    const bytesToSend = index === targets.length - 1 ? bytes : bytes.slice(0);
    if (target === "electron-main") {
      parent.postMessage({
        type: "message",
        prefix: incoming.prefix,
        header: incoming.header,
        frame: bytesToSend
      }, [bytesToSend]);
    } else if (queued) {
      if (!outgoing.send(TARGET_KINDS[target], bytesToSend, incoming ? incoming.header.ttlMs : timeToLive(frame)))
        log("info", `${message.processName(TARGET_KINDS[target])} is not ready; the message is waiting.`);
    } else {
      forward(target, bytesToSend, broadcast);
    }
  });
}
networkPort.on("message", (event) => {
  if (event.type === "connected") {
    monitor.start(ProcessKind.PROCESS_KIND_ENGINE);
    monitor.start(ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
    monitorTimer = setInterval(() => {
      outgoing.sweep();
      monitor.tick();
    }, 1e3);
    monitorTimer.unref();
    return;
  }
  if (event.type === "end") {
    clearInterval(monitorTimer);
    outgoing.markNotReady(ProcessKind.PROCESS_KIND_ENGINE);
    networkPort.close();
    parent.close();
    return;
  }
  if (event.type === "frame" && !invalid) routeFrame(event.frame, "network");
});
parent.on("message", (event) => {
  if (event.type === "frame") {
    routeFrame(event.frame, event.source ?? "renderer");
  } else if (event.type === "heartbeat") {
    heartbeat = event.heartbeat;
  } else if (event.type === "not-ready") {
    outgoing.markNotReady(event.kind);
    if (event.kind === ProcessKind.PROCESS_KIND_ELECTRON_RENDERER && monitorTimer)
      monitor.start(event.kind);
  } else if (event.type === "shutdown") {
    clearInterval(monitorTimer);
    networkPort.close();
    parent.close();
  }
});
//# sourceMappingURL=message_worker.js.map
