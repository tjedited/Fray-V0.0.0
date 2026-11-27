const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const os = require('node:os');
const message = require('../Electron/dist-electron/message');

// Requests the renderer entry so Vite finishes optimizing dependencies before Electron loads the page.
// Otherwise a cold cache makes Vite reload the page just after it starts.
async function warmUp(server) {
    await fetch(new URL('main.tsx', server.resolvedUrls.local[0]));
    await server.waitForRequestsIdle();
}

for (const mode of ['development', 'production']) test(`real ${mode} renderer exchanges framed messages and stops its worker`, { timeout: 30000 }, async () => {
    const vite = await import(pathToFileURL(require.resolve('../Electron/node_modules/vite')).href);
    const configFile = path.join(__dirname, '../Electron/vite.config.ts');
    const tcp = net.createServer();
    let server;
    let outputDirectory;
    let child;
    let socket;
    let output = '';
    const waiters = [];
    function waitFor(text) {
        if (output.includes(text)) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${text}:\n${output}`)), 8000);
            waiters.push({ text, resolve: () => { clearTimeout(timer); resolve(); } });
        });
    }
    try {
        if (mode === 'development') {
            server = await vite.createServer({ configFile, logLevel: 'silent', server: { port: 5173, strictPort: true } });
            await server.listen();
            await warmUp(server);
        } else {
            outputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'fray-renderer-ipc-'));
            await vite.build({ configFile, logLevel: 'silent', build: { outDir: outputDirectory, emptyOutDir: true } });
            server = await vite.preview({ configFile, logLevel: 'silent', build: { outDir: outputDirectory },
                preview: { port: 5173, strictPort: true } });
        }
        tcp.listen(0, '127.0.0.1');
        await once(tcp, 'listening');
        const connection = once(tcp, 'connection');
        const env = { ...process.env, FRAY_ENGINE_PORT: String(tcp.address().port) };
        delete env.ELECTRON_RUN_AS_NODE;
        child = spawn(require('../Electron/node_modules/electron'),
            [path.join(__dirname, '../Electron/tests/ipc_probe_runner.cjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        const exited = once(child, 'exit');
        for (const stream of [child.stdout, child.stderr]) {
            stream.on('data', (data) => {
                output += data.toString();
                for (const waiter of waiters.splice(0)) {
                    if (output.includes(waiter.text)) waiter.resolve();
                    else waiters.push(waiter);
                }
            });
        }
        [socket] = await Promise.race([
            connection,
            exited.then(() => { throw new Error(`Electron exited before connecting: ${output}`); }),
        ]);
        const received = [];
        let pending = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= message.PREFIX_SIZE) {
                const prefix = message.decodePrefix(pending);
                const length = message.PREFIX_SIZE + prefix.length;
                if (pending.length < length) break;
                received.push(message.parseFrame(pending.subarray(0, length)));
                pending = pending.subarray(length);
            }
        });
        const failOnExit = exited.then(() => { throw new Error(`Electron exited early: ${output}`); });
        await Promise.race([waitFor('STATE:{"state":"ready"'), failOnExit]);
        await Promise.race([waitFor('Renderer received frame: command=3 message_id='), failOnExit]);
        await Promise.race([waitFor('sender=Electron Renderer'), failOnExit]);
        await Promise.race([waitFor(':SHOWN_END'), failOnExit]);
        assert.match(output, /SHOWN:1:SHOWN_END/);
        child.stdin.write('preview-test\n');
        await Promise.race([waitFor(':PREVIEW_END'), failOnExit]);
        const preview = JSON.parse(output.match(/PREVIEW:(.+):PREVIEW_END/)[1]);
        assert.deepEqual(preview.initial, ['error', 'warning', 'success', 'info']);
        assert.equal(preview.afterShortcut, 5);
        child.stdin.write('prompt-preview-test\n');
        await Promise.race([waitFor(':PROMPT_PREVIEW_END'), failOnExit]);
        const promptPreview = JSON.parse(output.match(/PROMPT_PREVIEW:(.+):PROMPT_PREVIEW_END/)[1]);
        assert.deepEqual(promptPreview.initial, ['Example prompt']);
        assert.equal(promptPreview.during, 1);
        assert.deepEqual(promptPreview.afterClose, ['Example prompt']);
        assert.equal(promptPreview.remaining, 0);
        child.stdin.write('window\n');
        await Promise.race([waitFor(':WINDOW_END'), failOnExit]);
        const window = JSON.parse(output.match(/WINDOW:(.+):WINDOW_END/)[1]);
        assert.equal(window.fullscreen, false);
        assert.equal(window.page.bodyBackground, 'rgb(0, 0, 0)');
        assert.equal(window.page.titleBarBackground, 'rgb(26, 26, 26)');
        assert.equal(window.page.dragRegion, 'drag');
        assert.equal(window.page.barTop, 0);
        assert.equal(window.page.barHeight, process.platform === 'darwin' ? 32 : 35);
        assert.equal(window.page.barWidth, window.page.viewportWidth);
        assert.equal(window.page.barText, '');
        assert.ok(window.imageSize.width > 0 && window.imageSize.height > 0);
        assert.deepEqual(window.barPixel, [26, 26, 26]);
        assert.deepEqual(window.bodyPixel, [0, 0, 0]);
        assert.deepEqual(window.bounds, window.contentBounds);
        if (mode === 'development') {
            child.stdin.write('notifications-test\n');
            await Promise.race([waitFor('NOTIFICATIONS_TEST:PASS'), failOnExit]);
            child.stdin.write('prompts-test\n');
            await Promise.race([waitFor('PROMPTS_TEST:PASS'), failOnExit]);
        }
        assert.doesNotMatch(output, /Content Security Policy|PROBE_ERROR:/);
        child.stdin.write('menu\n');
        await Promise.race([waitFor(':MENU_END'), failOnExit]);
        const menu = JSON.parse(output.match(/MENU:(.+):MENU_END/)[1]);
        assert.deepEqual(menu.map((item) => item.label),
            process.platform === 'darwin' ? [menu[0].label, 'File', 'Edit'] : ['File', 'Edit']);
        const fileMenu = menu.find((item) => item.label === 'File').submenu;
        assert.deepEqual(fileMenu.map((item) => item.label),
            ['New Project', 'Open Project', 'Project Preferences', 'Close Project', 'Package Project']);
        assert.ok(fileMenu.every((item) => !item.enabled));
        const editMenu = menu.find((item) => item.label === 'Edit').submenu;
        assert.deepEqual(editMenu.map((item) => item.label), ['Undo', 'Redo']);
        assert.deepEqual(editMenu.map((item) => item.role), ['undo', 'redo']);
        if (process.platform === 'darwin') {
            assert.equal(menu[0].submenu.length, 1);
            assert.match(menu[0].submenu[0].label, /^Quit/);
            assert.equal(menu[0].submenu[0].enabled, true);
        }
        // Main announced itself and asked for readiness, and the renderer's own announcement reached the Engine.
        const readyFrom = (kind) => received.some((frame) => frame.prefix.commandId === message.Command.COMMAND_READY
            && frame.prefix.senderKind === kind && frame.prefix.destinationKind === message.ProcessKind.PROCESS_KIND_BROADCAST);
        for (let attempt = 0; attempt < 100 && !readyFrom(message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER); attempt++)
            await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(readyFrom(message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN), output);
        assert.ok(readyFrom(message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER), output);
        assert.equal(received.some((frame) => frame.prefix.commandId === message.Command.COMMAND_TEST), false);
        assert.doesNotMatch(output, /Renderer received frame: command=1 message_id=/);
        const malformed = Buffer.concat([
            message.encodePrefix({ destinationKind: 4, senderKind: 1, length: 1, headerLength: 1 }),
            Buffer.from([0x80]),
        ]);
        const toRenderer = message.buildFrame({
            destinationKind: 4, senderKind: 1, commandId: 42,
        }, { messageId: { low: -1, high: -1, unsigned: true } }, Buffer.alloc(65536, 0x7f));
        socket.write(Buffer.concat([malformed, toRenderer]));
        await Promise.race([waitFor('Message thread:'), failOnExit]);
        await Promise.race([waitFor('command=42 message_id=18446744073709551615 payload_bytes=65536'), failOnExit]);

        if (mode === 'development') child.stdin.write('send\n');
        else {
            const frame = message.buildFrame({ destinationKind: 1, senderKind: 4, commandId: 77 },
                { messageId: { low: -1, high: -1, unsigned: true }, senderName: 'Renderer' },
                Buffer.from([0, 1, 128, 255]));
            child.stdin.write(`sendhex ${frame.toString('hex')}\n`);
        }
        // The Engine has not said it is ready, so the routers hold the renderer's message instead of sending it.
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(received.some((frame) => frame.prefix.commandId === 77), false, output);
        socket.write(message.buildFrame({
            destinationKind: message.ProcessKind.PROCESS_KIND_BROADCAST,
            senderKind: message.ProcessKind.PROCESS_KIND_ENGINE,
            commandId: message.Command.COMMAND_READY,
        }, { senderName: 'Engine', messageId: 3 }));
        for (let attempt = 0; attempt < 100 && !received.some((frame) => frame.prefix.commandId === 77); attempt++)
            await new Promise((resolve) => setTimeout(resolve, 20));
        const outgoing = received.find((frame) => frame.prefix.commandId === 77);
        assert.ok(outgoing, output);
        assert.equal(outgoing.prefix.senderKind, message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
        assert.equal(outgoing.header.messageId, '18446744073709551615');
        assert.deepEqual(outgoing.payload, Buffer.from([0, 1, 128, 255]));

        socket.write(message.buildFrame({
            destinationKind: message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER,
            senderKind: message.ProcessKind.PROCESS_KIND_ENGINE,
            commandId: message.Command.COMMAND_PING,
        }, { senderName: 'Engine', messageId: 4 }));
        for (let attempt = 0; attempt < 100 && !received.some((frame) =>
            frame.prefix.commandId === message.Command.COMMAND_PONG &&
            frame.prefix.senderKind === message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER); attempt++)
            await new Promise((resolve) => setTimeout(resolve, 20));
        const rendererPong = received.find((frame) => frame.prefix.commandId === message.Command.COMMAND_PONG &&
            frame.prefix.senderKind === message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
        assert.ok(rendererPong, output);
        assert.equal(rendererPong.header.messageType, message.MessageType.MESSAGE_TYPE_HEALTH_REPORT);
        const health = message.HealthReport.toObject(message.HealthReport.decode(rendererPong.payload),
            { defaults: true, longs: String });
        assert.ok(BigInt(health.heartbeat) > 0n);

        if (mode === 'development') {
            child.stdin.write('block-ui\n');
            await Promise.race([waitFor('Electron Renderer is SUSPECT.'), failOnExit]);
            await Promise.race([waitFor('UI_BLOCK_END'), failOnExit]);
        }

        child.stdin.write('quit\n');
        const [code] = await exited;
        assert.equal(code, 0, output);
        assert.match(output, /STATE:{"state":"stopped","threads":\[\]}/);
        assert.ok(output.indexOf('STATE:{"state":"stopped"') < output.indexOf('Telling the engine to quit.'), output);
        assert.equal(received.at(-1).prefix.commandId, message.Command.COMMAND_QUIT);
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill();
        if (socket) socket.destroy();
        if (tcp.listening) await new Promise((resolve) => tcp.close(resolve));
        if (server && mode === 'development') await server.close();
        if (server && mode === 'production')
            await new Promise((resolve, reject) => server.httpServer.close((err) => err ? reject(err) : resolve()));
        if (outputDirectory) await fs.rm(outputDirectory, { recursive: true, force: true });
    }
});

test('real Engine and renderer exchange frames and project requests', { timeout: 30000 }, async () => {
    const vite = await import(pathToFileURL(require.resolve('../Electron/node_modules/vite')).href);
    const server = await vite.createServer({
        configFile: path.join(__dirname, '../Electron/vite.config.ts'),
        logLevel: 'silent', server: { port: 5173, strictPort: true },
    });
    const enginePath = process.env.FRAY_TEST_ENGINE || path.join(__dirname, '../Engine/build/Darwin/engine');
    let engine;
    let electron;
    let engineOutput = '';
    let electronOutput = '';
    const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'fray-project-ui-'));
    const waiters = [];
    function watch(stream, append) {
        stream.on('data', (data) => {
            append(data.toString());
            for (const waiter of waiters.splice(0)) {
                if (waiter.matches()) waiter.resolve();
                else waiters.push(waiter);
            }
        });
    }
    function waitFor(matches, description) {
        if (matches()) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(
                `Timed out waiting for ${description}.\nEngine: ${engineOutput}\nElectron: ${electronOutput}`)), 8000);
            waiters.push({ matches, resolve: () => { clearTimeout(timer); resolve(); } });
        });
    }
    try {
        await fs.mkdir(path.join(projectDirectory, 'Existing'));
        await fs.writeFile(path.join(projectDirectory, 'Existing', 'marker.txt'), 'existing project');
        await fs.mkdir(path.join(projectDirectory, 'Conflicted'));
        await fs.writeFile(path.join(projectDirectory, 'Conflicted.fry'), 'existing archive');
        await server.listen();
        await warmUp(server);
        engine = spawn(enginePath, ['--no-ui'], { cwd: projectDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
        const engineExit = once(engine, 'exit');
        watch(engine.stdout, (data) => { engineOutput += data; });
        watch(engine.stderr, (data) => { engineOutput += data; });
        const engineFailed = engineExit.then(([code]) => {
            throw new Error(`Engine exited early (${code}): ${engineOutput}`);
        });
        await Promise.race([
            waitFor(() => /Constructed server on port (\d+)\./.test(engineOutput), 'Engine port'),
            engineFailed,
        ]);
        const port = engineOutput.match(/Constructed server on port (\d+)\./)[1];
        const env = { ...process.env, FRAY_ENGINE_PORT: port };
        delete env.ELECTRON_RUN_AS_NODE;
        electron = spawn(require('../Electron/node_modules/electron'),
            [path.join(__dirname, '../Electron/tests/ipc_probe_runner.cjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        const electronExit = once(electron, 'exit');
        watch(electron.stdout, (data) => { electronOutput += data; });
        watch(electron.stderr, (data) => { electronOutput += data; });
        const electronFailed = electronExit.then(([code]) => {
            throw new Error(`Electron exited early (${code}): ${electronOutput}`);
        });
        const failures = [engineFailed, electronFailed];
        await Promise.race([
            waitFor(() => electronOutput.includes('Connected to TCP server'), 'TCP connection'),
            ...failures,
        ]);
        await Promise.race([
            waitFor(() => /Renderer: Renderer received frame: command=3 message_id=\d+ payload_bytes=0 sender=Engine/.test(electronOutput),
                'Engine readiness at the renderer'),
            ...failures,
        ]);
        assert.doesNotMatch(engineOutput, /command=1 sender=Electron Renderer destination=Engine /);
        assert.doesNotMatch(electronOutput, /Renderer: Renderer received frame: command=1 message_id=/);
        async function openProject(name, status) {
            electron.stdin.write(`open-project ${Buffer.from(name).toString('base64')}\n`);
            await Promise.race([
                waitFor(() => electronOutput.includes(`OPEN_RESULT:${JSON.stringify({ name, status })}`),
                    `project result for ${name}`),
                ...failures,
            ]);
        }
        await openProject('New Project', 'Project opened: New Project');
        const database = path.join(projectDirectory, 'New Project', 'New Project.sqlite');
        assert.deepEqual((await fs.readFile(database)).subarray(0, 16), Buffer.from('SQLite format 3\0'));
        await openProject('Existing', 'Project opened: Existing');
        assert.equal(await fs.readFile(path.join(projectDirectory, 'Existing', 'marker.txt'), 'utf8'), 'existing project');
        await openProject('Existing', 'This project is already open.');
        await openProject('../outside', 'The project name or request is invalid.');
        await openProject('Conflicted', 'Both the working folder and archive exist; resolve the conflict before opening.');
        assert.equal(await fs.readFile(path.join(projectDirectory, 'Conflicted.fry'), 'utf8'), 'existing archive');
        electron.stdin.write('send\n');
        await Promise.race([
            waitFor(() => /command=77 sender=Renderer .*message_id=18446744073709551615 .*payload_bytes=4 /.test(engineOutput),
                'renderer frame at the Engine'),
            ...failures,
        ]);
        await Promise.race([new Promise((resolve) => setTimeout(resolve, 4500)), ...failures]);
        assert.doesNotMatch(engineOutput + electronOutput, / is (?:DEGRADED|SUSPECT|DOWN)\./);
        assert.doesNotMatch(engineOutput + electronOutput, /Sending PING|received frame: command=(?:5|6) /i);
        assert.doesNotMatch(engineOutput, /Sending health report|Health report from|Health queue /);
        electron.stdin.write('quit\n');
        const [[electronCode], [engineCode]] = await Promise.all([electronExit, engineExit]);
        assert.equal(electronCode, 0, electronOutput);
        assert.equal(engineCode, 0, engineOutput);
        assert.ok((await fs.stat(path.join(projectDirectory, 'New Project.fry'))).isFile());
        assert.match(electronOutput, /STATE:{"state":"stopped","threads":\[\]}/);
        assert.match(engineOutput, /Quit requested by the UI/);
        assert.match(engineOutput, /Electron Main is ready\./);
        assert.match(engineOutput, /Electron Renderer is ready\./);
        assert.match(electronOutput, /Renderer: Engine is ready\./);
    } finally {
        if (electron && electron.exitCode === null && electron.signalCode === null) electron.kill();
        if (engine && engine.exitCode === null && engine.signalCode === null) engine.kill();
        await server.close();
        await fs.rm(projectDirectory, { recursive: true, force: true });
    }
});

test('renderer that starts before the Engine link announces itself once the link is up', { timeout: 30000 }, async () => {
    const vite = await import(pathToFileURL(require.resolve('../Electron/node_modules/vite')).href);
    const server = await vite.createServer({
        configFile: path.join(__dirname, '../Electron/vite.config.ts'),
        logLevel: 'silent', server: { port: 5173, strictPort: true },
    });
    const tcp = net.createServer();
    let electron;
    let socket;
    let output = '';
    try {
        await server.listen();
        await warmUp(server);
        // Reserve a port, then release it so Electron's first connection attempts are refused.
        tcp.listen(0, '127.0.0.1');
        await once(tcp, 'listening');
        const port = tcp.address().port;
        await new Promise((resolve) => tcp.close(resolve));
        const env = { ...process.env, FRAY_ENGINE_PORT: String(port) };
        delete env.ELECTRON_RUN_AS_NODE;
        electron = spawn(require('../Electron/node_modules/electron'),
            [path.join(__dirname, '../Electron/tests/ipc_probe_runner.cjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        const exited = once(electron, 'exit');
        for (const stream of [electron.stdout, electron.stderr]) stream.on('data', (data) => { output += data; });
        const until = async (condition, description) => {
            for (let attempt = 0; attempt < 400 && !condition(); attempt++) {
                if (electron.exitCode !== null) throw new Error(`Electron exited early: ${output}`);
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            assert.ok(condition(), `Timed out waiting for ${description}:\n${output}`);
        };
        await until(() => output.includes('STATE:{"state":"ready"'), 'the renderer to be ready');
        const received = [];
        let pending = Buffer.alloc(0);
        tcp.on('connection', (connection) => {
            socket = connection;
            connection.on('data', (chunk) => {
                pending = Buffer.concat([pending, chunk]);
                while (pending.length >= message.PREFIX_SIZE) {
                    const prefix = message.decodePrefix(pending);
                    const length = message.PREFIX_SIZE + prefix.length;
                    if (pending.length < length) break;
                    received.push(message.parseFrame(pending.subarray(0, length)));
                    pending = pending.subarray(length);
                }
            });
        });
        tcp.listen(port, '127.0.0.1');
        await until(() => received.some((frame) => frame.prefix.commandId === message.Command.COMMAND_READY
            && frame.prefix.senderKind === message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER),
        'the renderer announcement at the Engine');
        electron.stdin.write('quit\n');
        const [code] = await exited;
        assert.equal(code, 0, output);
    } finally {
        if (electron && electron.exitCode === null && electron.signalCode === null) electron.kill();
        if (socket) socket.destroy();
        if (tcp.listening) await new Promise((resolve) => tcp.close(resolve));
        await server.close();
    }
});
