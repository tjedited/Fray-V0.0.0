const { app, BrowserWindow, ipcMain } = require('electron');

let contents;
app.on('web-contents-created', (_event, webContents) => {
    contents = webContents;
    webContents.on('console-message', (event) => {
        console.log(`RENDERER:${event.message}`);
    });
});
ipcMain.on('fray:renderer-state', (_event, state) => {
    console.log(`STATE:${JSON.stringify(state)}`);
});

require('node:readline').createInterface({ input: process.stdin }).on('line', async (command) => {
    if (command === 'send') {
        try {
            await contents.executeJavaScript(`import('/message.ts').then(({ buildFrame, ProcessKind }) => {
                window.frayBridge.sendFrame(buildFrame({
                    destinationKind: ProcessKind.PROCESS_KIND_ENGINE,
                    senderKind: ProcessKind.PROCESS_KIND_ELECTRON_RENDERER,
                    commandId: 77,
                }, { messageId: '18446744073709551615', senderName: 'Renderer' },
                new Uint8Array([0, 1, 128, 255])));
            })`);
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command.startsWith('sendhex ')) {
        try {
            const bytes = [...Buffer.from(command.slice(8), 'hex')];
            await contents.executeJavaScript(`window.frayBridge.sendFrame(new Uint8Array(${JSON.stringify(bytes)}))`);
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command === 'quit') {
        BrowserWindow.fromWebContents(contents).close();
    }
});

require('../dist-electron/main.js');
