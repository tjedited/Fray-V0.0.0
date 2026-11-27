const { app, BrowserWindow, ipcMain, Menu } = require('electron');

let contents;
app.on('browser-window-created', (_event, win) => {
    win.once('show', () => console.log(`SHOWN:${win.getOpacity()}:SHOWN_END`));
});
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
    if (command.startsWith('open-project ')) {
        const name = Buffer.from(command.slice('open-project '.length), 'base64').toString('utf8');
        try {
            const status = await contents.executeJavaScript(`Promise.all([
                import('/message_handler.ts'), import('/message.ts')
            ]).then(([{ createMessageHandler }, { parseFrame, Command }]) => new Promise((resolve, reject) => {
                const timer = setTimeout(() => { remove(); reject(new Error('Project result timed out')); }, 8000);
                const handler = createMessageHandler((frame) => window.frayBridge.sendFrame(frame), (status) => {
                    if (status.startsWith('Requested project:')) return;
                    clearTimeout(timer);
                    remove();
                    resolve(status);
                });
                const remove = window.frayBridge.onFrame((frame) => {
                    const incoming = parseFrame(frame);
                    if (incoming.prefix.commandId === Command.COMMAND_PROJECT_OPEN_RESULT)
                        handler.onMessage(incoming);
                });
                handler.submitProject(${JSON.stringify(name)});
            }))`);
            console.log(`OPEN_RESULT:${JSON.stringify({ name, status })}`);
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command === 'preview-test') {
        try {
            const result = await contents.executeJavaScript(`new Promise((resolve) => {
                const cards = () => [...document.querySelectorAll('.notification-stack [data-notification-id]')];
                for (const card of cards()) card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
                const initial = cards().map((card) => card.dataset.notificationType);
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', ctrlKey: true, shiftKey: true }));
                requestAnimationFrame(() => resolve({ initial, afterShortcut: cards().length }));
            })`);
            console.log(`PREVIEW:${JSON.stringify(result)}:PREVIEW_END`);
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command === 'prompt-preview-test') {
        try {
            const result = await contents.executeJavaScript(`(async () => {
                const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
                const dialogs = () => [...document.querySelectorAll('[role="dialog"]')];
                const initial = dialogs().map((dialog) => dialog.querySelector('.prompt-title')?.textContent);
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true }));
                await nextFrame();
                const during = dialogs().length;
                dialogs()[0].querySelector('[aria-label^="Dismiss "]').click();
                await nextFrame();
                const afterClose = dialogs().map((dialog) => dialog.querySelector('.prompt-title')?.textContent);
                dialogs()[0].querySelector('[aria-label^="Dismiss "]').click();
                await nextFrame();
                return { initial, during, afterClose, remaining: dialogs().length };
            })()`);
            console.log(`PROMPT_PREVIEW:${JSON.stringify(result)}:PROMPT_PREVIEW_END`);
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command === 'notifications-test') {
        try {
            const modulePath = `/@fs${require('node:path').join(__dirname, 'notification_probe.tsx')}`;
            await contents.executeJavaScript(`import(${JSON.stringify(modulePath)}).then((module) => module.testNotifications())`);
            console.log('NOTIFICATIONS_TEST:PASS');
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command === 'prompts-test') {
        try {
            const modulePath = `/@fs${require('node:path').join(__dirname, 'prompt_probe.tsx')}`;
            await contents.executeJavaScript(`import(${JSON.stringify(modulePath)}).then((module) => module.testPrompts())`);
            console.log('PROMPTS_TEST:PASS');
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command === 'window') {
        const win = BrowserWindow.fromWebContents(contents);
        const page = await contents.executeJavaScript(`new Promise((resolve) => requestAnimationFrame(() => {
            const bar = document.querySelector('.title-bar');
            const bounds = bar.getBoundingClientRect();
            resolve({
                bodyBackground: getComputedStyle(document.body).backgroundColor,
                titleBarBackground: getComputedStyle(bar).backgroundColor,
                dragRegion: getComputedStyle(bar).getPropertyValue('app-region'),
                barTop: bounds.top,
                barHeight: bounds.height,
                barWidth: bounds.width,
                viewportWidth: innerWidth,
                viewportHeight: innerHeight,
                barText: bar.innerText,
            });
        }))`);
        const image = await contents.capturePage();
        const bitmap = image.toBitmap();
        const size = image.getSize();
        const pixel = (x, y) => {
            const index = (Math.floor(y * size.height / page.viewportHeight) * size.width +
                Math.floor(x * size.width / page.viewportWidth)) * 4;
            return [...bitmap.subarray(index, index + 3)];
        };
        console.log(`WINDOW:${JSON.stringify({
            page, fullscreen: win.isFullScreen(), bounds: win.getBounds(), contentBounds: win.getContentBounds(),
            imageSize: size, barPixel: pixel(page.viewportWidth / 2, page.barHeight / 2),
            bodyPixel: pixel(page.viewportWidth / 2, page.barHeight + 10),
        })}:WINDOW_END`);
    } else if (command === 'menu') {
        const items = Menu.getApplicationMenu().items.map((item) => ({
            label: item.label,
            submenu: item.submenu?.items.map((child) => ({
                label: child.label, enabled: child.enabled, role: child.role,
            })),
        }));
        console.log(`MENU:${JSON.stringify(items)}:MENU_END`);
    } else if (command === 'send') {
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
    } else if (command === 'block-ui') {
        await contents.executeJavaScript(`(() => {
            const until = performance.now() + 5000;
            while (performance.now() < until) {}
        })()`);
        console.log('UI_BLOCK_END');
    } else if (command === 'quit') {
        BrowserWindow.fromWebContents(contents).close();
    }
});

require(process.env.FRAY_TEST_ELECTRON_MAIN || '../dist-electron/main.js');
