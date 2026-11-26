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
        await Promise.race([waitFor('Renderer received frame: command=1 message_id='), failOnExit]);
        await Promise.race([waitFor('sender=Electron Renderer'), failOnExit]);
        // Main announced itself and asked for readiness, and the renderer's own announcement reached the Engine.
        const readyFrom = (kind) => received.some((frame) => frame.prefix.commandId === message.Command.COMMAND_READY
            && frame.prefix.senderKind === kind && frame.prefix.destinationKind === message.ProcessKind.PROCESS_KIND_BROADCAST);
        for (let attempt = 0; attempt < 100 && !readyFrom(message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER); attempt++)
            await new Promise((resolve) => setTimeout(resolve, 20));
        assert.ok(readyFrom(message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN), output);
        assert.ok(readyFrom(message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER), output);
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

test('real Engine and renderer exchange frames in both directions', { timeout: 30000 }, async () => {
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
        await server.listen();
        await warmUp(server);
        engine = spawn(enginePath, ['--no-ui', '--test-renderer-ipc'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
            waitFor(() => /command=1 sender=Electron Renderer destination=Engine .*payload_bytes=\d+ /.test(engineOutput),
                'renderer startup frame at the Engine'),
            ...failures,
        ]);
        await Promise.race([
            waitFor(() => /Renderer: Renderer received frame: command=1 message_id=\d+ payload_bytes=\d+ sender=Engine/.test(electronOutput),
                'Engine startup frame in terminal output'),
            ...failures,
        ]);
        electron.stdin.write('send\n');
        await Promise.race([
            waitFor(() => /command=77 sender=Renderer .*message_id=18446744073709551615 .*payload_bytes=4 /.test(engineOutput),
                'renderer frame at the Engine'),
            ...failures,
        ]);
        await Promise.race([
            waitFor(() => (engineOutput.match(/Health report from Electron Main:/g) || []).length >= 4,
                'sustained health reports'),
            ...failures,
        ]);
        assert.doesNotMatch(engineOutput + electronOutput, / is (?:DEGRADED|SUSPECT|DOWN)\./);
        assert.doesNotMatch(engineOutput + electronOutput, /Sending PING|received frame: command=(?:5|6) /i);
        electron.stdin.write('quit\n');
        const [[electronCode], [engineCode]] = await Promise.all([electronExit, engineExit]);
        assert.equal(electronCode, 0, electronOutput);
        assert.equal(engineCode, 0, engineOutput);
        assert.match(electronOutput, /STATE:{"state":"stopped","threads":\[\]}/);
        assert.match(engineOutput, /Quit requested by the UI/);
        assert.match(engineOutput, /Electron Main is ready\./);
        assert.match(engineOutput, /Electron Renderer is ready\./);
        assert.match(electronOutput, /Renderer: Engine is ready\./);
    } finally {
        if (electron && electron.exitCode === null && electron.signalCode === null) electron.kill();
        if (engine && engine.exitCode === null && engine.signalCode === null) engine.kill();
        await server.close();
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
