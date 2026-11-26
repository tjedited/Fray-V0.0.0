"use strict";
const electron = require("electron");
const path = require("node:path");
const log_manager = require("./log_manager.js");
const ipc_manager = require("./ipc_manager.js");
const thread_manager = require("./thread_manager.js");
const message = require("./message.js");
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
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const { ProcessKind } = message;
const SELF = ProcessKind.PROCESS_KIND_ELECTRON_MAIN;
log_manager.electronInfo("Starting Electron.");
const enginePort = Number(process.env.FRAY_ENGINE_PORT);
const threads = new thread_manager.ThreadManager();
let ipc = null;
let shuttingDown = false;
let shutdownComplete = false;
let nextMessageId = 1;
let window = null;
let rendererState = "starting";
let rendererThreads = [];
let rendererShutdownRequested = false;
let resolveRendererStopped;
const rendererStopped = new Promise((resolve) => {
  resolveRendererStopped = resolve;
});
function makeFrame(commandId, payload = Buffer.alloc(0), destinationKind = ProcessKind.PROCESS_KIND_ENGINE, destinationId = 0) {
  return message.buildFrame({
    destinationKind,
    destinationId,
    senderKind: SELF,
    commandId
  }, {
    protocolVersion: 1,
    messageId: (nextMessageId += 2) - 2,
    timestamp: Date.now(),
    senderName: message.processName(SELF),
    destinationName: message.processName(destinationKind),
    payloadType: payload.length ? message.PayloadType.PAYLOAD_TYPE_JSON : message.PayloadType.PAYLOAD_TYPE_NONE
  }, payload);
}
function send(frame) {
  if (!ipc || shuttingDown) {
    log_manager.electronWarn("Cannot send: IPC is not available.");
    return;
  }
  try {
    ipc.send(frame);
  } catch (error) {
    log_manager.electronWarn("Cannot send: %s", error.message);
  }
}
function announceReady() {
  send(makeFrame(message.Command.COMMAND_READY, Buffer.alloc(0), ProcessKind.PROCESS_KIND_BROADCAST));
  send(makeFrame(message.Command.COMMAND_REQUEST_READY, Buffer.alloc(0), ProcessKind.PROCESS_KIND_BROADCAST));
}
function sendTestFrame(kind) {
  const payload = kind === ProcessKind.PROCESS_KIND_ENGINE ? Buffer.from(JSON.stringify({ message: "Hello from Electron Main" })) : Buffer.alloc(0);
  send(makeFrame(message.Command.COMMAND_TEST, payload, kind));
}
function connectToEngine() {
  if (!enginePort) {
    log_manager.electronError("FRAY_ENGINE_PORT is not set; start Electron through the engine.");
    return;
  }
  log_manager.electronInfo("Starting IPC threads.");
  ipc = new ipc_manager.IPCManager("127.0.0.1", enginePort, threads);
  ipc.on("connected", () => {
    if (shuttingDown) return;
    announceReady();
    sendTestFrame(ProcessKind.PROCESS_KIND_ENGINE);
    sendTestFrame(ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
  });
  ipc.on("peer-ready", (kind) => {
    log_manager.electronInfo("%s is ready.", message.processName(kind));
    if (ipc && ipc.connected) send(makeFrame(message.Command.COMMAND_READY, Buffer.alloc(0), kind));
  });
  ipc.on("message", ({ prefix, header, payload }) => {
    if (prefix.commandId !== message.Command.COMMAND_PING && prefix.commandId !== message.Command.COMMAND_PONG)
      log_manager.electronInfo(
        "Received frame: command=%d sender=%s destination=%s protocol=%d message_id=%s timestamp=%s flags=%d payload_type=%d message_type=%d payload_bytes=%d frame_bytes=%d.",
        prefix.commandId,
        header.senderName,
        header.destinationName,
        header.protocolVersion,
        header.messageId,
        header.timestamp,
        header.flags,
        header.payloadType,
        header.messageType,
        payload.length,
        message.PREFIX_SIZE + prefix.length
      );
    const sender = prefix.senderKind;
    if (prefix.commandId === message.Command.COMMAND_REQUEST_READY && sender !== SELF && sender !== ProcessKind.PROCESS_KIND_BROADCAST && ipc && ipc.connected)
      send(makeFrame(message.Command.COMMAND_READY, Buffer.alloc(0), sender, prefix.senderId));
  });
  ipc.on("renderer-frame", (frame, broadcast) => sendToRenderer(frame, broadcast));
}
function sendToRenderer(frame, broadcast = false) {
  if (!window || window.isDestroyed() || rendererState !== "ready" || shuttingDown) {
    if (!broadcast) log_manager.electronWarn("Cannot forward frame: renderer is not ready.");
    return;
  }
  window.webContents.send("fray:frame", new Uint8Array(frame));
}
function requestRendererShutdown() {
  if (!window || window.isDestroyed() || rendererState === "stopped" || rendererState === "gone")
    return;
  if (!rendererShutdownRequested && (rendererState === "ready" || rendererState === "failed")) {
    rendererShutdownRequested = true;
    window.webContents.send("fray:shutdown");
  }
}
electron.ipcMain.on("fray:frame", (event, frame) => {
  if (!window || event.sender !== window.webContents) {
    log_manager.electronError("Rejected frame from an unknown renderer.");
    return;
  }
  if (!(frame instanceof Uint8Array)) {
    log_manager.electronError("Rejected renderer frame: expected bytes.");
    return;
  }
  if (!ipc || shuttingDown) {
    log_manager.electronError("Cannot route renderer frame: IPC is not available.");
    return;
  }
  try {
    ipc.routeRendererFrame(frame);
  } catch (error) {
    log_manager.electronError("Cannot route renderer frame: %s", error.message);
  }
});
electron.ipcMain.on("fray:renderer-state", (event, report) => {
  if (!window || event.sender !== window.webContents) {
    log_manager.electronError("Rejected state from an unknown renderer.");
    return;
  }
  if (!report || !["starting", "ready", "stopping", "stopped", "failed"].includes(report.state) || !Array.isArray(report.threads) || !report.threads.every((name) => typeof name === "string")) {
    log_manager.electronError("Rejected invalid renderer thread state.");
    return;
  }
  rendererState = report.state;
  if (rendererState !== "ready") ipc?.markNotReady(ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
  rendererThreads = report.threads;
  if (rendererState === "stopped") {
    if (rendererThreads.length) {
      log_manager.electronError("Renderer reported stopped with threads still running: %s.", rendererThreads.join(", "));
      rendererState = "failed";
    } else {
      resolveRendererStopped();
    }
  }
  if (rendererState === "failed" && shuttingDown && rendererThreads.length === 0) {
    log_manager.electronError("Renderer threads stopped after a failure; shutdown was not clean.");
    resolveRendererStopped();
  }
  if (shuttingDown) requestRendererShutdown();
});
const createWindow = () => {
  const win = new electron.BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path__namespace.join(__dirname, "preload.js")
    }
  });
  window = win;
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") log_manager.electronError("Renderer: %s", event.message);
    else if (event.level === "warning") log_manager.electronWarn("Renderer: %s", event.message);
    else log_manager.electronInfo("Renderer: %s", event.message);
  });
  win.on("close", (event) => {
    if (!shutdownComplete) {
      event.preventDefault();
      electron.app.quit();
    }
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    log_manager.electronError("Renderer process exited (%s); its threads could not report a clean shutdown.", details.reason);
    rendererState = "gone";
    ipc?.markNotReady(ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
    resolveRendererStopped();
  });
  win.webContents.on("did-start-navigation", (_event, _url, isSameDocument, isMainFrame) => {
    if (!isMainFrame || isSameDocument) return;
    if (rendererState !== "starting" && rendererState !== "stopped" && rendererState !== "gone")
      log_manager.electronWarn("Renderer navigated without a coordinated worker shutdown.");
    rendererState = "starting";
    ipc?.markNotReady(ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
    rendererThreads = [];
    rendererShutdownRequested = false;
  });
  win.on("closed", () => {
    if (rendererState !== "stopped" && rendererState !== "gone") {
      log_manager.electronError("Renderer window was destroyed before its threads reported a clean shutdown.");
      rendererState = "gone";
      resolveRendererStopped();
    }
  });
  win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame) return;
    log_manager.electronError("Renderer failed to load (%d): %s.", code, description);
    if (rendererState === "starting" && rendererThreads.length === 0) {
      rendererState = "gone";
      resolveRendererStopped();
    }
  });
  win.loadURL("http://localhost:5173");
  connectToEngine();
};
electron.app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  if (!window) resolveRendererStopped();
  if (rendererState === "failed" && rendererThreads.length === 0) {
    log_manager.electronError("Renderer threads stopped after a failure; shutdown was not clean.");
    resolveRendererStopped();
  }
  requestRendererShutdown();
  rendererStopped.then(() => {
    if (!ipc) return;
    let finalFrame = null;
    if (ipc.connected) {
      log_manager.electronInfo("Telling the engine to quit.");
      finalFrame = makeFrame(message.Command.COMMAND_QUIT);
    }
    return ipc.close(finalFrame);
  }).catch((err) => {
    log_manager.electronError("Failed to stop IPC threads: %s", err.message);
  }).finally(() => {
    shutdownComplete = true;
    electron.app.quit();
  });
});
electron.app.whenReady().then(() => {
  log_manager.electronInfo("Showing the window.");
  createWindow();
});
electron.app.on("window-all-closed", () => {
  log_manager.electronInfo("Exiting Electron.");
  electron.app.quit();
});
//# sourceMappingURL=main.js.map
