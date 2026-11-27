/* main.js */
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import * as path from 'node:path';
import { lstat } from 'node:fs/promises';
import * as log from './log_manager';
import { IPCManager } from './ipc_manager';
import { ThreadManager } from './thread_manager';
import * as message from './message';
import { createMessageHandler } from './message_handler';
import { createFrameBuilder } from '../shared/frame_builder';
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
const frames = createFrameBuilder(SELF, 1, message.buildFrame, message.processName);
let window: BrowserWindow | null = null;
let rendererState: RendererState | 'gone' = 'starting';
let rendererThreads: string[] = [];
let rendererShutdownRequested = false;
let resolveRendererStopped!: () => void;
const rendererStopped = new Promise<void>((resolve) => { resolveRendererStopped = resolve; });

// Hands a frame to the router thread, which sends it when its destination is ready and holds it until then.
function send(frame: Buffer): void {
  if (!ipc || shuttingDown) {
    log.electronWarn('Cannot send: IPC is not available.');
    return;
  }
  try {
    ipc.send(frame);
  } catch (error) {
    log.electronWarn('Cannot send: %s', (error as Error).message);
  }
}

const messages = createMessageHandler(frames, send, () => ipc?.connected === true && !shuttingDown, (frame) => {
  if (!ipc || shuttingDown || !ipc.connected) throw new Error('Cannot send prompt: IPC is not available.');
  ipc.send(frame);
});

export const requestPrompt = messages.requestPrompt;

function connectToEngine(): void {
  if (!enginePort) {
    log.electronError("FRAY_ENGINE_PORT is not set; start Electron through the engine.");
    return;
  }
  log.electronInfo("Starting IPC threads.");
  ipc = new IPCManager('127.0.0.1', enginePort, threads);
  // Electron Main is ready once it is connected to the Engine, because that link is how everyone else reaches it.
  ipc.on('connected', () => {
    if (shuttingDown) return;
    messages.announceReady();
  });
  // A neighbor that has just become ready is answered with our own READY, so it need not ask. Only a change triggers
  // this, so the exchange ends after one reply each way. Until connected, Main is not ready and announces on connect.
  ipc.on('peer-ready', messages.onPeerReady);
  ipc.on('disconnected', () => messages.cancelPrompts('Engine connection was lost.'));
  ipc.on('peer-unavailable', (kind) => {
    if (kind === ProcessKind.PROCESS_KIND_ELECTRON_RENDERER)
      messages.cancelPrompts('Renderer is unavailable.');
  });
  ipc.on('message', messages.onMessage);
  ipc.on('renderer-frame', (frame, broadcast) => sendToRenderer(frame, broadcast));
}

// A broadcast reaches whoever can be reached, so a renderer that is not ready is skipped without a warning.
function sendToRenderer(frame: Uint8Array | ArrayBuffer, broadcast = false): void {
  if (!window || window.isDestroyed() || rendererState !== 'ready' || shuttingDown) {
    if (!broadcast) log.electronWarn('Cannot forward frame: renderer is not ready.');
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

ipcMain.handle('fray:choose-new-project-path', async (event, previousPath: unknown) => {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || shuttingDown)
    throw new Error('Cannot choose a project path from this renderer.');
  if (previousPath !== undefined &&
      (typeof previousPath !== 'string' || !path.isAbsolute(previousPath) || previousPath.includes('\0')))
    throw new Error('Cannot choose a project path: invalid previous path.');
  const result = await dialog.showSaveDialog(window, {
    title: 'New Project',
    buttonLabel: 'Create Project',
    defaultPath: previousPath === undefined ? undefined : path.dirname(previousPath),
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath.endsWith('.fry') ? result.filePath.slice(0, -4) : result.filePath;
});

ipcMain.handle('fray:choose-open-project-path', async (event, kind: unknown) => {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || shuttingDown)
    throw new Error('Cannot choose a project from this renderer.');
  if (kind !== 'archive' && kind !== 'folder' && !(kind === 'both' && process.platform === 'darwin'))
    throw new Error('Cannot choose a project: invalid picker type.');
  const properties: ('openFile' | 'openDirectory')[] = kind === 'both'
    ? ['openFile', 'openDirectory'] : [kind === 'archive' ? 'openFile' : 'openDirectory'];
  const result = await dialog.showOpenDialog(window, {
    title: 'Open Project',
    properties,
    ...(kind === 'folder' ? {} : { filters: [{ name: 'Fray projects', extensions: ['fry'] }] }),
  });
  if (result.canceled) return null;
  const selected = result.filePaths[0];
  if (!selected || !path.isAbsolute(selected) || selected.includes('\0'))
    throw new Error('The selected project path is invalid.');
  const status = await lstat(selected);
  if (status.isDirectory() && kind !== 'archive')
    return { path: selected, kind: 'folder' };
  if (status.isFile() && kind !== 'folder' && path.extname(selected) === '.fry')
    return { path: selected.slice(0, -4), kind: 'archive' };
  throw new Error('Select a working folder or a .fry project archive.');
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
  if (rendererState !== 'ready') ipc?.markNotReady(ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
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
    frame: false,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false
    }
  })
  if (process.platform === 'darwin') win.setWindowButtonVisibility(true);
  window = win;
  let shown = false;
  const showWindow = (): void => {
    if (shown || shuttingDown) return;
    shown = true;
    win.show();
  };
  win.once('ready-to-show', showWindow);
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
    messages.cancelPrompts('Renderer process exited.');
    log.electronError('Renderer process exited (%s); its threads could not report a clean shutdown.', details.reason);
    rendererState = 'gone';
    ipc?.markNotReady(ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
    resolveRendererStopped();
  });
  win.webContents.on('did-start-navigation', (_event, _url, isSameDocument, isMainFrame) => {
    if (!isMainFrame || isSameDocument) return;
    messages.cancelPrompts('Renderer navigated.');
    if (rendererState !== 'starting' && rendererState !== 'stopped' && rendererState !== 'gone')
      log.electronWarn('Renderer navigated without a coordinated worker shutdown.');
    rendererState = 'starting';
    ipc?.markNotReady(ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
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
    showWindow();
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
  messages.cancelPrompts();
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
      finalFrame = frames.build({ command: message.Command.COMMAND_QUIT, destination: ProcessKind.PROCESS_KIND_ENGINE });
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
  const menu: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New Project', click: () => {
          if (!window || window.isDestroyed() || rendererState !== 'ready' || shuttingDown) {
            log.electronWarn('Cannot create project: renderer is not ready.');
            return;
          }
          window.webContents.send('fray:new-project');
        } },
        { label: 'Open Project', click: () => {
          if (!window || window.isDestroyed() || rendererState !== 'ready' || shuttingDown) {
            log.electronWarn('Cannot open project: renderer is not ready.');
            return;
          }
          window.webContents.send('fray:open-project');
        } },
        { label: 'Project Preferences', enabled: false },
        { label: 'Close Project', click: () => {
          if (!window || window.isDestroyed() || rendererState !== 'ready' || shuttingDown) {
            log.electronWarn('Cannot close project: renderer is not ready.');
            return;
          }
          window.webContents.send('fray:close-project', false);
        } },
        { label: 'Package Project', click: () => {
          if (!window || window.isDestroyed() || rendererState !== 'ready' || shuttingDown) {
            log.electronWarn('Cannot package project: renderer is not ready.');
            return;
          }
          window.webContents.send('fray:close-project', true);
        } }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' }
      ]
    }
  ];
  if (process.platform === 'darwin') {
    menu.unshift({ label: app.name, submenu: [{ role: 'quit' }] });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  log.electronInfo("Showing the window.");
  createWindow()
})

app.on('window-all-closed', () => {
  log.electronInfo("Exiting Electron.");
  app.quit();
});