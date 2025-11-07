const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('platform', process.platform);

contextBridge.exposeInMainWorld('versions', {
  node: () => process.versions.node,
  chrome: () => process.versions.chrome,
  electron: () => process.versions.electron
});