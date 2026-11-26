"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("platform", process.platform);
electron.contextBridge.exposeInMainWorld("versions", {
  node: () => process.versions.node,
  chrome: () => process.versions.chrome,
  electron: () => process.versions.electron
});
const frayBridge = {
  sendFrame: (frame) => electron.ipcRenderer.send("fray:frame", frame),
  reportState: (state, threads) => electron.ipcRenderer.send("fray:renderer-state", { state, threads }),
  onFrame: (handler) => {
    const listener = (_event, frame) => handler(frame);
    electron.ipcRenderer.on("fray:frame", listener);
    return () => electron.ipcRenderer.removeListener("fray:frame", listener);
  },
  onShutdown: (handler) => {
    const listener = () => handler();
    electron.ipcRenderer.on("fray:shutdown", listener);
    return () => electron.ipcRenderer.removeListener("fray:shutdown", listener);
  }
};
electron.contextBridge.exposeInMainWorld("frayBridge", frayBridge);
//# sourceMappingURL=preload.js.map
