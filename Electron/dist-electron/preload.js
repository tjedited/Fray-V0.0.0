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
  chooseNewProjectPath: (previousPath) => electron.ipcRenderer.send("fray:choose-new-project-path", previousPath),
  onNewProjectPath: (handler) => {
    const listener = (_event, result) => handler(result);
    electron.ipcRenderer.on("fray:new-project-path", listener);
    return () => electron.ipcRenderer.removeListener("fray:new-project-path", listener);
  },
  onOpenProject: (handler) => {
    const listener = () => handler();
    electron.ipcRenderer.on("fray:open-project", listener);
    return () => electron.ipcRenderer.removeListener("fray:open-project", listener);
  },
  chooseOpenProjectPath: (kind) => electron.ipcRenderer.send("fray:choose-open-project-path", kind),
  onOpenProjectPath: (handler) => {
    const listener = (_event, result) => handler(result);
    electron.ipcRenderer.on("fray:open-project-path", listener);
    return () => electron.ipcRenderer.removeListener("fray:open-project-path", listener);
  },
  onCloseProject: (handler) => {
    const listener = (_event, packageProject) => handler(packageProject);
    electron.ipcRenderer.on("fray:close-project", listener);
    return () => electron.ipcRenderer.removeListener("fray:close-project", listener);
  }
};
electron.contextBridge.exposeInMainWorld("frayBridge", frayBridge);
//# sourceMappingURL=preload.js.map
