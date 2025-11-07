const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const { spawn } = require('child_process');
const os = require('os');

function launchNativeExecutable() {
  let execPath;
  if (process.platform === 'darwin') {
    execPath = path.join(__dirname, '../Engine/build/Darwin/main');
  } else if (process.platform === 'win32') {
    execPath = path.join(__dirname, '../Engine/build/Windows/main.exe');
  } else {
    console.log('Unsupported OS for native executable.');
    return;
  }

  // Spawn the process detached
  const child = spawn(execPath, ["one", "two", "three"], {
    detached: true,
    stdio: 'inherit'
  });

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
  launchNativeExecutable();
}

app.whenReady().then(() => {
  createWindow()
})