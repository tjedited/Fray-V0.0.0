const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('platform', process.platform);

contextBridge.exposeInMainWorld('versions', {
  node: () => process.versions.node,
  chrome: () => process.versions.chrome,
  electron: () => process.versions.electron
});

contextBridge.exposeInMainWorld('frayBridge', {
  sendFrame: (frame) => ipcRenderer.send('fray:frame', frame),
  reportState: (state, threads) => ipcRenderer.send('fray:renderer-state', { state, threads }),
  onFrame: (handler) => {
    const listener = (_event, frame) => handler(frame);
    ipcRenderer.on('fray:frame', listener);
    return () => ipcRenderer.removeListener('fray:frame', listener);
  },
  onShutdown: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('fray:shutdown', listener);
    return () => ipcRenderer.removeListener('fray:shutdown', listener);
  },
});