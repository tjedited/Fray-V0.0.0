"use strict";
const node_worker_threads = require("node:worker_threads");
const message = require("./message.js");
const message_router = require("./message_router.js");
const parent = node_worker_threads.parentPort;
const networkPort = node_worker_threads.workerData.port;
let invalid = false;
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
  targets.forEach((target, index) => {
    const bytesToSend = index === targets.length - 1 ? bytes : bytes.slice(0);
    if (target === "electron-main") {
      parent.postMessage({
        type: "message",
        prefix: incoming.prefix,
        header: incoming.header,
        frame: bytesToSend
      }, [bytesToSend]);
    } else {
      parent.postMessage({ type: "forward", destination: target, frame: bytesToSend }, [bytesToSend]);
    }
  });
}
networkPort.on("message", (event) => {
  if (event.type === "end") {
    networkPort.close();
    parent.close();
    return;
  }
  if (event.type === "frame" && !invalid) routeFrame(event.frame, "network");
});
parent.on("message", (event) => {
  if (event.type === "frame") {
    routeFrame(event.frame, "renderer");
  } else if (event.type === "shutdown") {
    networkPort.close();
    parent.close();
  }
});
//# sourceMappingURL=message_worker.js.map
