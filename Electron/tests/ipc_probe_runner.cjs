const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');

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
    if (command.startsWith('new-project ')) {
        try {
            const paths = JSON.parse(Buffer.from(command.slice('new-project '.length), 'base64').toString('utf8'));
            dialog.showSaveDialog = async (_window, options) => {
                if (!paths.length) throw new Error('No mocked project path remains.');
                console.log(`SAVE_DIALOG_DEFAULT:${JSON.stringify(options.defaultPath ?? null)}`);
                const filePath = paths.shift();
                return { canceled: filePath === null, filePath: filePath ?? undefined };
            };
            Menu.getApplicationMenu().items.find((item) => item.label === 'File')
                .submenu.items.find((item) => item.label === 'New Project').click();
            console.log('NEW_PROJECT_STARTED');
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command.startsWith('choose-open-project ')) {
        try {
            const filePath = JSON.parse(Buffer.from(command.slice('choose-open-project '.length), 'base64').toString('utf8'));
            dialog.showOpenDialog = async (_window, options) => {
                console.log(`OPEN_DIALOG:${JSON.stringify(options.properties)}`);
                return { canceled: filePath === null, filePaths: filePath === null ? [] : [filePath] };
            };
            Menu.getApplicationMenu().items.find((item) => item.label === 'File')
                .submenu.items.find((item) => item.label === 'Open Project').click();
            console.log('OPEN_PROJECT_STARTED');
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command === 'close-project' || command === 'package-project') {
        const label = command === 'close-project' ? 'Close Project' : 'Package Project';
        Menu.getApplicationMenu().items.find((item) => item.label === 'File')
            .submenu.items.find((item) => item.label === label).click();
        console.log(`PROJECT_ACTION:${label}`);
    } else if (command.startsWith('answer-prompt ')) {
        try {
            const label = Buffer.from(command.slice('answer-prompt '.length), 'base64').toString('utf8');
            await contents.executeJavaScript(`(() => {
                const button = [...document.querySelectorAll('[role="dialog"] button')]
                    .find((element) => element.textContent === ${JSON.stringify(label)});
                if (!button) throw new Error('Prompt choice not found.');
                button.click();
            })()`);
            console.log(`ANSWERED:${label}`);
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command.startsWith('dismiss-prompt ')) {
        try {
            const title = Buffer.from(command.slice('dismiss-prompt '.length), 'base64').toString('utf8');
            await contents.executeJavaScript(`(() => {
                const button = [...document.querySelectorAll('[role="dialog"] button')]
                    .find((element) => element.getAttribute('aria-label') === ${JSON.stringify(`Dismiss ${title}`)});
                if (!button) throw new Error('Prompt close button not found.');
                button.click();
            })()`);
            console.log(`DISMISSED:${title}`);
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command.startsWith('await-ui ')) {
        try {
            const { text, token } = JSON.parse(Buffer.from(command.slice('await-ui '.length), 'base64').toString('utf8'));
            await contents.executeJavaScript(`new Promise((resolve, reject) => {
                const seen = new Set();
                const check = () => {
                    const elements = [...document.querySelectorAll('[role="dialog"], .notification')];
                    for (const element of elements) seen.add(element.textContent);
                    if (elements.some((element) => element.textContent.includes(${JSON.stringify(text)}))) {
                        observer.disconnect();
                        clearTimeout(timer);
                        resolve();
                    }
                };
                const observer = new MutationObserver(check);
                const timer = setTimeout(() => {
                    observer.disconnect();
                    reject(new Error('UI text timed out: ' + JSON.stringify([...seen])));
                }, 15000);
                observer.observe(document.body, { childList: true, subtree: true, characterData: true });
                check();
            })`);
            console.log(`UI_FOUND:${token}`);
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command.startsWith('close-target ')) {
        const target = Buffer.from(command.slice('close-target '.length), 'base64').toString('utf8');
        try {
            const result = await contents.executeJavaScript(`Promise.all([
                import('/message_handler.ts'), import('/message.ts'), import('/message_schema.ts')
            ]).then(([{ createMessageHandler }, { parseFrame, Command }, { ProjectCloseResult }]) => new Promise((resolve, reject) => {
                const timer = setTimeout(() => { remove(); reject(new Error('Project close result timed out')); }, 8000);
                const handler = createMessageHandler((frame) => window.frayBridge.sendFrame(frame), () => {});
                const remove = window.frayBridge.onFrame((frame) => {
                    const incoming = parseFrame(frame);
                    if (incoming.prefix.commandId !== Command.COMMAND_PROJECT_CLOSE_RESULT) return;
                    clearTimeout(timer);
                    remove();
                    const result = ProjectCloseResult.decode(incoming.payload);
                    resolve({ success: result.success, error: result.error });
                });
                handler.closeProject(false, ${JSON.stringify(target)});
            }))`);
            console.log(`CLOSE_TARGET_RESULT:${JSON.stringify({ target, ...result })}`);
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command.startsWith('open-project ')) {
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
    } else if (command === 'no-preview-test') {
        try {
            const result = await contents.executeJavaScript(`new Promise((resolve) => {
                const counts = () => ({
                    notifications: document.querySelectorAll('.notification-stack [data-notification-id]').length,
                    prompts: document.querySelectorAll('[role="dialog"]').length,
                });
                const initial = counts();
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', ctrlKey: true, shiftKey: true }));
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true }));
                requestAnimationFrame(() => resolve({ initial, afterShortcuts: counts() }));
            })`);
            console.log(`NO_PREVIEW:${JSON.stringify(result)}:NO_PREVIEW_END`);
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
    } else if (command === 'project-creation-test') {
        try {
            const modulePath = `/@fs${require('node:path').join(__dirname, 'project_creation_probe.ts')}`;
            await contents.executeJavaScript(`import(${JSON.stringify(modulePath)}).then((module) => module.testProjectCreation())`);
            console.log('PROJECT_CREATION_TEST:PASS');
        } catch (error) {
            console.error(`PROBE_ERROR:${error.message}`);
            app.exit(1);
        }
    } else if (command === 'project-opening-test') {
        try {
            const modulePath = `/@fs${require('node:path').join(__dirname, 'project_opening_probe.ts')}`;
            await contents.executeJavaScript(`import(${JSON.stringify(modulePath)}).then((module) => module.testProjectOpening())`);
            console.log('PROJECT_OPENING_TEST:PASS');
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
