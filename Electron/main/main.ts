/* main.js */
import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'node:path';
import * as log from './log_manager';
import { IPCManager } from './ipc_manager';
import { ThreadManager } from './thread_manager';
import * as message from './message';
import { PeerReadiness, handleReadiness } from './readiness';
import type { RendererState } from '../shared/types';

const { ProcessKind } = message;
const SELF = ProcessKind.PROCESS_KIND_ELECTRON_MAIN;

log.electronInfo("Starting Electron.");

// The engine spawns Electron and passes the port it is listening on.
const enginePort = Number(process.env.FRAY_ENGINE_PORT);
const threads = new ThreadManager();
let ipc: IPCManager | null = null;
let shuttingDown = false;
let shutdownComplete = false;
let nextMessageId = 1;
const peers = new PeerReadiness();
let window: BrowserWindow | null = null;
let rendererState: RendererState | 'gone' = 'starting';
let rendererThreads: string[] = [];
let rendererShutdownRequested = false;
let resolveRendererStopped!: () => void;
const rendererStopped = new Promise<void>((resolve) => { resolveRendererStopped = resolve; });

function makeFrame(commandId: number, payload: Buffer = Buffer.alloc(0), destinationKind: number = ProcessKind.PROCESS_KIND_ENGINE, destinationId = 0): Buffer {
  return message.buildFrame({
    destinationKind,
    destinationId,
    senderKind: SELF,
    commandId,
  }, {
    protocolVersion: 1,
    messageId: nextMessageId++,
    timestamp: Date.now(),
    senderName: message.processName(SELF),
    destinationName: message.processName(destinationKind),
    payloadType: payload.length ? message.PayloadType.PAYLOAD_TYPE_JSON : message.PayloadType.PAYLOAD_TYPE_NONE,
  }, payload);
}

// Sends to one peer whether or not it has said it is ready. Used for readiness messages themselves.
function sendToPeer(kind: number, frame: Buffer): void {
  if (kind === ProcessKind.PROCESS_KIND_ENGINE) {
    if (ipc && ipc.connected && !shuttingDown) ipc.send(frame);
    else log.electronWarn('Cannot send to the Engine: TCP client is not connected.');
  } else if (kind === ProcessKind.PROCESS_KIND_ELECTRON_RENDERER) {
    sendToRenderer(frame);
  }
}

// Everything else waits for the peer to say it is ready. Messages to a peer that is not ready are dropped, not queued.
function sendToReadyPeer(kind: number, frame: Buffer): void {
  if (!peers.isReady(kind)) {
    log.electronWarn('Cannot send to %s: it has not said it is ready.', message.processName(kind));
    return;
  }
  sendToPeer(kind, frame);
}

// Reaches every peer that can currently be reached. Peers that are not up yet will ask for readiness when they start.
function broadcast(frame: Buffer): void {
  if (ipc && ipc.connected && !shuttingDown) ipc.send(frame);
  if (rendererState === 'ready') sendToRenderer(frame);
}

function announceReady(): void {
  broadcast(makeFrame(message.Command.COMMAND_READY, Buffer.alloc(0), ProcessKind.PROCESS_KIND_BROADCAST));
  broadcast(makeFrame(message.Command.COMMAND_REQUEST_READY, Buffer.alloc(0), ProcessKind.PROCESS_KIND_BROADCAST));
}

function sendTestFrame(kind: number): void {
  const payload = kind === ProcessKind.PROCESS_KIND_ENGINE
    ? Buffer.from(JSON.stringify({ message: 'Hello from Electron Main' })) : Buffer.alloc(0);
  sendToReadyPeer(kind, makeFrame(message.Command.COMMAND_TEST, payload, kind));
}

function connectToEngine(): void {
  if (!enginePort) {
    log.electronError("FRAY_ENGINE_PORT is not set; start Electron through the engine.");
    return;
  }
  log.electronInfo("Starting IPC threads.");
  ipc = new IPCManager('127.0.0.1', enginePort, threads);
  // Electron Main is ready once it is connected to the Engine, because that link is how everyone else reaches it.
  ipc.on('connected', () => {
    if (!shuttingDown) announceReady();
  });
  ipc.on('disconnected', () => peers.markNotReady(ProcessKind.PROCESS_KIND_ENGINE));
  ipc.on('message', ({ prefix, header, payload }) => {
    log.electronInfo('Received frame: command=%d sender=%s destination=%s protocol=%d message_id=%s timestamp=%s flags=%d payload_type=%d message_type=%d payload_bytes=%d frame_bytes=%d.',
      prefix.commandId, header.senderName, header.destinationName, header.protocolVersion, header.messageId,
      header.timestamp, header.flags, header.payloadType, header.messageType, payload.length,
      message.PREFIX_SIZE + prefix.length);
    handleReadiness(prefix, SELF, peers, {
      reply: (kind, id) => {
        if (ipc && ipc.connected) sendToPeer(kind, makeFrame(message.Command.COMMAND_READY, Buffer.alloc(0), kind, id));
      },
      onPeerReady: (kind) => {
        log.electronInfo('%s is ready.', message.processName(kind));
        sendTestFrame(kind);
      },
    });
  });
  ipc.on('renderer-frame', (frame) => sendToRenderer(frame));
}

function sendToRenderer(frame: Uint8Array | ArrayBuffer): void {
  if (!window || window.isDestroyed() || rendererState !== 'ready' || shuttingDown) {
    log.electronWarn('Cannot forward frame: renderer is not ready.');
    return;
  }
  window.webContents.send('fray:frame', new Uint8Array(frame));
}

function requestRendererShutdown(): void {
  if (!window || window.isDestroyed() || rendererState === 'stopped' || rendererState === 'gone')
    return;
  if (!rendererShutdownRequested && (rendererState === 'ready' || rendererState === 'failed')) {
    rendererShutdownRequested = true;
    window.webContents.send('fray:shutdown');
  }
}

ipcMain.on('fray:frame', (event, frame: unknown) => {
  if (!window || event.sender !== window.webContents) {
    log.electronError('Rejected frame from an unknown renderer.');
    return;
  }
  if (!(frame instanceof Uint8Array)) {
    log.electronError('Rejected renderer frame: expected bytes.');
    return;
  }
  if (!ipc || shuttingDown) {
    log.electronError('Cannot route renderer frame: IPC is not available.');
    return;
  }
  try {
    ipc.routeRendererFrame(frame);
  } catch (error) {
    log.electronError('Cannot route renderer frame: %s', (error as Error).message);
  }
});

ipcMain.on('fray:renderer-state', (event, report: { state: RendererState; threads: string[] } | null) => {
  if (!window || event.sender !== window.webContents) {
    log.electronError('Rejected state from an unknown renderer.');
    return;
  }
  if (!report || !['starting', 'ready', 'stopping', 'stopped', 'failed'].includes(report.state) ||
      !Array.isArray(report.threads) || !report.threads.every((name) => typeof name === 'string')) {
    log.electronError('Rejected invalid renderer thread state.');
    return;
  }
  rendererState = report.state;
  if (rendererState !== 'ready') peers.markNotReady(ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
  rendererThreads = report.threads;
  if (rendererState === 'stopped') {
    if (rendererThreads.length) {
      log.electronError('Renderer reported stopped with threads still running: %s.', rendererThreads.join(', '));
      rendererState = 'failed';
    } else {
      resolveRendererStopped();
    }
  }
  if (rendererState === 'failed' && shuttingDown && rendererThreads.length === 0) {
    log.electronError('Renderer threads stopped after a failure; shutdown was not clean.');
    resolveRendererStopped();
  }
  if (shuttingDown) requestRendererShutdown();
});

const createWindow = (): void => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  })
  window = win;
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') log.electronError('Renderer: %s', event.message);
    else if (event.level === 'warning') log.electronWarn('Renderer: %s', event.message);
    else log.electronInfo('Renderer: %s', event.message);
  });
  win.on('close', (event) => {
    if (!shutdownComplete) {
      event.preventDefault();
      app.quit();
    }
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    log.electronError('Renderer process exited (%s); its threads could not report a clean shutdown.', details.reason);
    rendererState = 'gone';
    peers.markNotReady(ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
    resolveRendererStopped();
  });
  win.webContents.on('did-start-navigation', (_event, _url, isSameDocument, isMainFrame) => {
    if (!isMainFrame || isSameDocument) return;
    if (rendererState !== 'starting' && rendererState !== 'stopped' && rendererState !== 'gone')
      log.electronWarn('Renderer navigated without a coordinated worker shutdown.');
    rendererState = 'starting';
    peers.markNotReady(ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
    rendererThreads = [];
    rendererShutdownRequested = false;
  });
  win.on('closed', () => {
    if (rendererState !== 'stopped' && rendererState !== 'gone') {
      log.electronError('Renderer window was destroyed before its threads reported a clean shutdown.');
      rendererState = 'gone';
      resolveRendererStopped();
    }
  });
  win.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame) return;
    log.electronError('Renderer failed to load (%d): %s.', code, description);
    if (rendererState === 'starting' && rendererThreads.length === 0) {
      rendererState = 'gone';
      resolveRendererStopped();
    }
  });
  win.loadURL('http://localhost:5173');
  connectToEngine();
}

// Tells the engine to quit before Electron exits.
app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  if (!window) resolveRendererStopped();
  if (rendererState === 'failed' && rendererThreads.length === 0) {
    log.electronError('Renderer threads stopped after a failure; shutdown was not clean.');
    resolveRendererStopped();
  }
  requestRendererShutdown();
  rendererStopped.then(() => {
    if (!ipc) return;
    let finalFrame = null;
    if (ipc.connected) {
      log.electronInfo("Telling the engine to quit.");
      finalFrame = makeFrame(message.Command.COMMAND_QUIT);
    }
    return ipc.close(finalFrame);
  }).catch((err) => {
    log.electronError("Failed to stop IPC threads: %s", (err as Error).message);
  }).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

app.whenReady().then(() => {
  log.electronInfo("Showing the window.");
  createWindow()
})

app.on('window-all-closed', () => {
  log.electronInfo("Exiting Electron.");
  app.quit();
});