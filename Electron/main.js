/* main.js */

const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const { spawn } = require('child_process');
const os = require('os');
const { create } = require('node:domain');
const log = require('./fray/log');
const { TCPClient } = require('./fray/ipc');

log.electronInfo("Hey this is a quick test %d", 129);

function launchNativeExecutable(launchState) {
  let execPath;
  if (process.platform === 'darwin') {
    execPath = path.join(__dirname, '../Engine/build/Darwin/engine');
  } else if (process.platform === 'win32') {
    execPath = path.join(__dirname, '../Engine/build/Windows/engine.exe');
  } else {
    console.log('Unsupported OS for native executable.');
    return;
  }

  // Spawn the process detached
  const child = spawn(
    execPath,
    [launchState],
    {
      detached: true,
      stdio: 'inherit'
    }
  );

  child.unref(); // Disconnect from the child process
}

const createWindow = () => {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js')
    }
  })

  win.loadURL('http://localhost:5173');
  launchNativeExecutable("default"); // TODO: default, safe mode, developer
  waitForEngineAndConnect();
}

// In Electron main.js
function waitForEngineAndConnect() {
    setTimeout(() => {
        const tcpClient = new TCPClient('127.0.0.1', 1234);
    }, 1000); // Wait 1 second for engine to start
}

app.whenReady().then(() => {
  createWindow()
})