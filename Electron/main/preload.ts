import { contextBridge, ipcRenderer } from 'electron';
import type { FrayBridge, RendererState } from '../shared/types';

contextBridge.exposeInMainWorld('platform', process.platform);

contextBridge.exposeInMainWorld('versions', {
  node: () => process.versions.node,
  chrome: () => process.versions.chrome,
  electron: () => process.versions.electron
});

const frayBridge: FrayBridge = {
  sendFrame: (frame) => ipcRenderer.send('fray:frame', frame),
  reportState: (state: RendererState, threads) => ipcRenderer.send('fray:renderer-state', { state, threads }),
  onFrame: (handler) => {
    const listener = (_event: unknown, frame: Uint8Array) => handler(frame);
    ipcRenderer.on('fray:frame', listener);
    return () => ipcRenderer.removeListener('fray:frame', listener);
  },
  onShutdown: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('fray:shutdown', listener);
    return () => ipcRenderer.removeListener('fray:shutdown', listener);
  },
  onNewProject: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('fray:new-project', listener);
    return () => ipcRenderer.removeListener('fray:new-project', listener);
  },
  chooseNewProjectPath: (previousPath) => ipcRenderer.invoke('fray:choose-new-project-path', previousPath),
  onOpenProject: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('fray:open-project', listener);
    return () => ipcRenderer.removeListener('fray:open-project', listener);
  },
  chooseOpenProjectPath: (kind) => ipcRenderer.invoke('fray:choose-open-project-path', kind),
  onCloseProject: (handler) => {
    const listener = (_event: unknown, packageProject: boolean) => handler(packageProject);
    ipcRenderer.on('fray:close-project', listener);
    return () => ipcRenderer.removeListener('fray:close-project', listener);
  },
};

contextBridge.exposeInMainWorld('frayBridge', frayBridge);
