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
};

contextBridge.exposeInMainWorld('frayBridge', frayBridge);
