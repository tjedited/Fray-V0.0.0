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
  },
  onNewProject: (handler) => {
    const listener = () => handler();
    electron.ipcRenderer.on("fray:new-project", listener);
    return () => electron.ipcRenderer.removeListener("fray:new-project", listener);
  },
  chooseNewProjectPath: (previousPath) => electron.ipcRenderer.invoke("fray:choose-new-project-path", previousPath),
  onOpenProject: (handler) => {
    const listener = () => handler();
    electron.ipcRenderer.on("fray:open-project", listener);
    return () => electron.ipcRenderer.removeListener("fray:open-project", listener);
  },
  chooseOpenProjectPath: (kind) => electron.ipcRenderer.invoke("fray:choose-open-project-path", kind),
  onCloseProject: (handler) => {
    const listener = (_event, packageProject) => handler(packageProject);
    electron.ipcRenderer.on("fray:close-project", listener);
    return () => electron.ipcRenderer.removeListener("fray:close-project", listener);
  }
};
electron.contextBridge.exposeInMainWorld("frayBridge", frayBridge);
//# sourceMappingURL=preload.js.map
