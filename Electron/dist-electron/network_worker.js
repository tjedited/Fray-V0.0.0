"use strict";
const node_worker_threads = require("node:worker_threads");
const ipc_manager = require("./ipc_manager.js");
const parent = node_worker_threads.parentPort;
const routerPort = node_worker_threads.workerData.routerPort;
const client = new ipc_manager.TCPClient(node_worker_threads.workerData.host, node_worker_threads.workerData.port, 1e4, 500, {
  onConnect: () => parent.postMessage({ type: "connected" }),
  onFrame: (frame) => routerPort.postMessage({ type: "frame", frame: frame.buffer }, [frame.buffer]),
  onError: (error) => parent.postMessage({ type: "error", message: error }),
  onClose: () => {
    parent.postMessage({ type: "closed" });
    routerPort.postMessage({ type: "end" });
    routerPort.close();
    parent.close();
  }
});
routerPort.on("message", (event) => {
  if (event.type === "invalid") client.client.destroy();
});
parent.on("message", (event) => {
  if (event.type === "send" || event.type === "shutdown") {
    if (event.frame) {
      if (client.connected) client.send(Buffer.from(event.frame));
      else parent.postMessage({ type: "error", message: "Cannot send: TCP client is not connected." });
    }
    if (event.type === "shutdown") client.close();
  }
});
//# sourceMappingURL=network_worker.js.map
