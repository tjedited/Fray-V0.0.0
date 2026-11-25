const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
    const window = new BrowserWindow({
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    const errors = [];
    let exitCode = 0;
    window.webContents.on('console-message', (event) => errors.push(event.message));
    try {
        await window.loadURL(process.argv[2]);
        const result = await window.webContents.executeJavaScript(`new Promise((resolve) => {
            const result = document.getElementById('result');
            if (result.textContent) return resolve(result.textContent);
            new MutationObserver((_changes, observer) => {
                if (result.textContent) {
                    observer.disconnect();
                    resolve(result.textContent);
                }
            }).observe(result, { childList: true });
        })`);
        if (!result) throw new Error(`Renderer did not run schema probe: ${errors.join('; ')}`);
        await new Promise((resolve) => process.stdout.write(`SCHEMA_PROBE:${result}\n`, resolve));
    } catch (error) {
        console.error(error);
        exitCode = 1;
    } finally {
        window.destroy();
        app.exit(exitCode);
    }
});
