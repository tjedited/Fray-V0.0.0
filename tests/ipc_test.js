const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { once } = require('node:events');
const EventEmitter = require('node:events');
const Module = require('node:module');
const { test } = require('node:test');
const { IPCManager, TCPClient } = require('../Electron/dist-electron/ipc_manager');
const { ThreadManager } = require('../Electron/dist-electron/thread_manager');
const message = require('../Electron/dist-electron/message');
const log = require('../Electron/dist-electron/log_manager');

function frame(commandId, payload = Buffer.alloc(0), id = 1, destination = message.ProcessKind.PROCESS_KIND_ENGINE) {
    return message.buildFrame({
        destinationKind: destination,
        senderKind: message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN,
        commandId,
    }, {
        protocolVersion: 1,
        messageId: id,
        timestamp: 12345,
        senderName: 'Electron Main',
        destinationName: 'Engine',
        payloadType: message.PayloadType.PAYLOAD_TYPE_CUSTOM,
    }, payload);
}

async function waitUntil(condition, description, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const BROADCAST = message.ProcessKind.PROCESS_KIND_BROADCAST;

test('Electron workers receive fragmented and combined frames in order', { timeout: 10000 }, async () => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const connection = once(server, 'connection');
    const received = [];
    let done;
    const complete = new Promise((resolve) => { done = resolve; });
    const threads = new ThreadManager();
    const client = new IPCManager('127.0.0.1', server.address().port, threads);
    const routingErrors = [];
    client.router.on('message', (event) => {
        if (event.type === 'error') routingErrors.push(event.message);
    });
    client.on('message', (incoming) => {
        received.push(incoming);
        if (received.length === 3) done();
    });
    const [socket] = await connection;
    try {
        const data = Buffer.alloc(65536, 0xa5);
        const destination = message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN;
        // These come from the Engine; a frame is never routed back to its own sender.
        const fromEngine = (commandId, payload) => {
            const built = frame(commandId, payload, 1, destination);
            built[6] = message.ProcessKind.PROCESS_KIND_ENGINE;
            return built;
        };
        const first = fromEngine(1, data);
        const unsupported = Buffer.concat([
            message.encodePrefix({ destinationKind: message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER,
                destinationId: 7, senderKind: 1, length: 1, headerLength: 1 }),
            Buffer.from([0x80]),
        ]);
        socket.write(unsupported);
        socket.write(first.subarray(0, 8));
        await new Promise((resolve) => setTimeout(resolve, 20));
        socket.write(first.subarray(8, 100));
        await new Promise((resolve) => setTimeout(resolve, 20));
        socket.write(Buffer.concat([first.subarray(100), fromEngine(2, Buffer.alloc(0)), fromEngine(3, Buffer.from('end'))]));
        await complete;
        assert.deepEqual(threads.runningNames().sort(), ['electron-messages', 'network']);
        assert.notEqual(client.network.threadId, client.router.threadId);
        assert.notEqual(client.network.threadId, 0);
        assert.notEqual(client.router.threadId, 0);
        assert.deepEqual(received.map((item) => item.prefix.commandId), [1, 2, 3]);
        assert.deepEqual(received[0].payload, data);
        assert.equal(received[0].header.senderName, 'Electron Main');
        assert.equal(received[1].payload.length, 0);
        assert.equal(received[2].payload.toString(), 'end');
        assert.deepEqual(routingErrors, ['Cannot route message: unsupported destination kind=4 id=7.']);
    } finally {
        await client.close();
        assert.deepEqual(threads.runningNames(), []);
        socket.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('IPC shuts down while connecting', { timeout: 10000 }, async () => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const threads = new ThreadManager();
    const client = new IPCManager('127.0.0.1', port, threads);
    await client.close();
    assert.deepEqual(threads.runningNames(), []);
});

test('IPC retries a refused connection without stopping its workers', { timeout: 10000 }, async () => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const threads = new ThreadManager();
    const client = new IPCManager('127.0.0.1', port, threads);
    let connections = 0;
    client.on('connected', () => { connections++; });
    const connected = once(client, 'connected');
    try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        server.listen(port, '127.0.0.1');
        await once(server, 'listening');
        await connected;
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(connections, 1);
        assert.deepEqual(threads.runningNames().sort(), ['electron-messages', 'network']);
    } finally {
        await client.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('IPC shuts down the remaining worker if the message worker fails', { timeout: 10000 }, async () => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const connection = once(server, 'connection');
    const threads = new ThreadManager();
    const client = new IPCManager('127.0.0.1', server.address().port, threads);
    const connected = once(client, 'connected');
    const [socket] = await connection;
    try {
        await connected;
        const disconnected = once(client, 'disconnected');
        await client.router.terminate();
        await disconnected;
        await client.close();
        assert.deepEqual(threads.runningNames(), []);
    } finally {
        await client.close();
        socket.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('Engine exchanges complete frames and accepts framed quit', { timeout: 15000 }, async () => {
    const executable = process.env.FRAY_TEST_ENGINE || path.join(__dirname, '../Engine/build/Darwin/engine');
    const engine = spawn(executable, ['--no-ui'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exit = once(engine, 'exit');
    let output = '';
    let portResolve;
    const portReady = new Promise((resolve) => { portResolve = resolve; });
    engine.stdout.on('data', (data) => {
        output += data.toString();
        const match = output.match(/Constructed server on port (\d+)\./);
        if (match) portResolve(Number(match[1]));
    });
    engine.stderr.on('data', (data) => { output += data.toString(); });
    let client;
    try {
        const port = await Promise.race([
            portReady,
            exit.then(() => { throw new Error(`Engine exited before opening a port: ${output}`); }),
        ]);
        const invalid = net.createConnection(port, '127.0.0.1');
        invalid.on('data', () => {});
        await once(invalid, 'connect');
        const invalidClosed = once(invalid, 'close');
        const badPrefix = Buffer.alloc(message.PREFIX_SIZE);
        badPrefix[0] = 99;
        invalid.write(badPrefix);
        await invalidClosed;
        const malformed = net.createConnection(port, '127.0.0.1');
        malformed.on('data', () => {});
        await once(malformed, 'connect');
        malformed.end(Buffer.concat([
            message.encodePrefix({ destinationKind: 1, senderKind: 3, length: 1, headerLength: 1 }),
            Buffer.from([0x80]),
        ]));
        await once(malformed, 'close');
        const engineFrames = [];
        client = new TCPClient('127.0.0.1', port, 1000, 50, {
            onFrame: (incoming) => engineFrames.push(message.parseFrame(incoming)),
        });
        await once(client.client, 'connect');
        // The Engine says nothing until a peer announces itself.
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(engineFrames, []);
        client.client.write(frame(message.Command.COMMAND_READY, Buffer.alloc(0), 50));
        client.client.write(frame(message.Command.COMMAND_REQUEST_READY, Buffer.alloc(0), 51, BROADCAST));
        await waitUntil(() => engineFrames.some((f) => f.prefix.commandId === message.Command.COMMAND_TEST), 'the Engine test frame');
        await waitUntil(() => engineFrames.some((f) => f.prefix.commandId === message.Command.COMMAND_READY), 'the Engine READY reply');
        const incoming = engineFrames.find((f) => f.prefix.commandId === message.Command.COMMAND_TEST);
        const reply = engineFrames.find((f) => f.prefix.commandId === message.Command.COMMAND_READY);
        assert.equal(reply.prefix.destinationKind, message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN);
        assert.equal(reply.prefix.senderKind, message.ProcessKind.PROCESS_KIND_ENGINE);
        const testFrame = frame(message.Command.COMMAND_TEST, Buffer.alloc(65536, 0x7f), 55);
        client.client.write(testFrame.subarray(0, 5));
        await new Promise((resolve) => setTimeout(resolve, 20));
        const wrongDestination = frame(message.Command.COMMAND_QUIT, Buffer.alloc(0), 57);
        wrongDestination[1] = message.ProcessKind.PROCESS_KIND_ENGINE_PLUGIN;
        const wrongSender = frame(message.Command.COMMAND_QUIT, Buffer.alloc(0), 58);
        wrongSender[6] = message.ProcessKind.PROCESS_KIND_ENGINE_PLUGIN;
        const unsupported = Buffer.concat([
            message.encodePrefix({ destinationKind: message.ProcessKind.PROCESS_KIND_ENGINE_PLUGIN,
                destinationId: 42, senderKind: 3, length: 1, headerLength: 1 }),
            Buffer.from([0x80]),
        ]);
        client.client.write(Buffer.concat([
            testFrame.subarray(5),
            frame(message.Command.COMMAND_TEST, Buffer.from('second'), 56),
            wrongDestination,
            unsupported,
            wrongSender,
            frame(message.Command.COMMAND_QUIT, Buffer.alloc(0), 59),
        ]));
        const [code] = await exit;
        assert.equal(code, 0, output);
        assert.match(output, /message_id=55 .*payload_bytes=65536 /);
        assert.match(output, /message_id=56 .*payload_bytes=6 /);
        assert.doesNotMatch(output, /message_id=57 .*payload_bytes=0 /);
        assert.match(output, /Cannot route message: unsupported destination kind=2 id=42/);
        assert.match(output, /message_id=58 .*payload_bytes=0 /);
        assert.match(output, /message_id=59 .*payload_bytes=0 /);
        assert.match(output, /Invalid message prefix/);
        assert.match(output, /Message processing failed/);
        assert.equal((output.match(/Message processing failed/g) || []).length, 1);
        assert.match(output, /Quit requested by the UI/);
        assert.match(output, /Electron Main is ready\./);
    } finally {
        if (client) client.client.destroy();
        if (engine.exitCode === null && engine.signalCode === null) engine.kill();
    }
});

test('Electron workers exchange frames with the Engine and shut down', { timeout: 15000 }, async () => {
    const executable = process.env.FRAY_TEST_ENGINE || path.join(__dirname, '../Engine/build/Darwin/engine');
    const engine = spawn(executable, ['--no-ui'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(engine, 'exit');
    let output = '';
    let resolvePort;
    const portReady = new Promise((resolve) => { resolvePort = resolve; });
    engine.stdout.on('data', (data) => {
        output += data.toString();
        const match = output.match(/Constructed server on port (\d+)\./);
        if (match) resolvePort(Number(match[1]));
    });
    engine.stderr.on('data', (data) => { output += data.toString(); });
    let client;
    try {
        const port = await Promise.race([
            portReady,
            exited.then(() => { throw new Error(`Engine exited before opening a port: ${output}`); }),
        ]);
        const threads = new ThreadManager();
        client = new IPCManager('127.0.0.1', port, threads);
        const received = [];
        client.on('message', (incomingMessage) => received.push(incomingMessage));
        await once(client, 'connected');
        client.send(frame(message.Command.COMMAND_READY, Buffer.alloc(0), 77));
        await waitUntil(() => received.some((m) => m.prefix.commandId === message.Command.COMMAND_TEST), 'the Engine test frame');
        const incoming = received.find((m) => m.prefix.commandId === message.Command.COMMAND_TEST);
        assert.equal(incoming.header.senderName, 'Engine');
        assert.deepEqual(JSON.parse(incoming.payload.toString()), { message: 'Hello from the Engine' });
        client.send(frame(message.Command.COMMAND_TEST, Buffer.from('worker test'), 78));
        await client.close(frame(message.Command.COMMAND_QUIT, Buffer.alloc(0), 79));
        const [code] = await exited;
        assert.equal(code, 0, output);
        assert.match(output, /message_id=78 .*payload_bytes=11 /);
        assert.match(output, /message_id=79 .*payload_bytes=0 /);
        assert.deepEqual(threads.runningNames(), []);
    } finally {
        if (client) await client.close();
        if (engine.exitCode === null && engine.signalCode === null) engine.kill();
    }
});

test('Electron worker threads disconnect on an invalid prefix or protobuf header', { timeout: 10000 }, async () => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        for (const bad of [Buffer.alloc(message.PREFIX_SIZE), Buffer.concat([
            message.encodePrefix({ destinationKind: message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN,
                senderKind: 1, length: 1, headerLength: 1 }),
            Buffer.from([0x80]),
        ]), message.encodePrefix({ destinationKind: message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN,
            senderKind: 1, length: message.MAX_FRAME_LENGTH + 1, headerLength: 1 })]) {
            const connection = once(server, 'connection');
            const threads = new ThreadManager();
            const client = new IPCManager('127.0.0.1', server.address().port, threads);
            const closed = once(client, 'disconnected');
            const [socket] = await connection;
            socket.write(bad);
            await closed;
            await client.close();
            assert.deepEqual(threads.runningNames(), []);
            socket.destroy();
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('frames over the maximum size are refused when built or parsed', () => {
    const header = { messageId: 1, senderName: 'Test' };
    assert.throws(() => message.buildFrame({ destinationKind: 1, senderKind: 3 }, header,
        Buffer.alloc(message.MAX_FRAME_LENGTH)), /maximum/);
    assert.throws(() => message.decodePrefix(message.encodePrefix({ destinationKind: 1, senderKind: 3,
        length: message.MAX_FRAME_LENGTH + 1, headerLength: 1 })), /maximum/);
});

test('Electron main sends a test frame and a framed quit', { timeout: 10000 }, async () => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const connection = once(server, 'connection');
    const app = new EventEmitter();
    const ipcMain = new EventEmitter();
    app.whenReady = () => Promise.resolve();
    let resolveQuit;
    const quitFinished = new Promise((resolve) => { resolveQuit = resolve; });
    app.quit = () => {
        app.emit('before-quit', { preventDefault() {} });
        resolveQuit();
    };
    let windowOptions;
    let windowUrl;
    let win;
    class BrowserWindow extends EventEmitter {
        constructor(options) {
            super();
            win = this;
            windowOptions = options;
            this.webContents = new EventEmitter();
            this.sent = [];
            this.webContents.send = (...args) => this.sent.push(args);
        }
        isDestroyed() { return false; }
        loadURL(url) { windowUrl = url; }
    }
    const originalLoad = Module._load;
    const originalPort = process.env.FRAY_ENGINE_PORT;
    const originalInfo = log.electronInfo;
    let resolveIncoming;
    const incomingLogged = new Promise((resolve) => { resolveIncoming = resolve; });
    log.electronInfo = (format, ...args) => {
        if (format.startsWith('Received frame:') && args[4] === '99') resolveIncoming(args);
        originalInfo(format, ...args);
    };
    process.env.FRAY_ENGINE_PORT = String(server.address().port);
    Module._load = function (request, ...args) {
        if (request === 'electron') return { app, BrowserWindow, ipcMain };
        return originalLoad.call(this, request, ...args);
    };
    try {
        require('../Electron/dist-electron/main');
    } finally {
        Module._load = originalLoad;
        if (originalPort === undefined) delete process.env.FRAY_ENGINE_PORT;
        else process.env.FRAY_ENGINE_PORT = originalPort;
    }
    const [socket] = await connection;
    assert.equal(require.resolve('../Electron'), require.resolve('../Electron/dist-electron/main'));
    assert.equal(windowOptions.webPreferences.preload, path.join(__dirname, '../Electron/dist-electron/preload.js'));
    assert.equal(fs.existsSync(windowOptions.webPreferences.preload), true);
    assert.equal(windowUrl, 'http://localhost:5173');
    let data = Buffer.alloc(0);
    const frames = [];
    let resolveFirst;
    const firstFrame = new Promise((resolve) => { resolveFirst = resolve; });
    let resolveFrames;
    const complete = new Promise((resolve) => { resolveFrames = resolve; });
    socket.on('data', (chunk) => {
        data = Buffer.concat([data, chunk]);
        while (data.length >= message.PREFIX_SIZE) {
            const prefix = message.decodePrefix(data);
            const size = message.PREFIX_SIZE + prefix.length;
            if (data.length < size) break;
            frames.push(message.parseFrame(data.subarray(0, size)));
            data = data.subarray(size);
            if (frames.length === 2) resolveFirst();
            if (frames.at(-1).prefix.commandId === message.Command.COMMAND_QUIT) resolveFrames();
        }
    });
    try {
        await firstFrame;
        // On connecting, Main announces itself and asks everyone else to do the same.
        assert.deepEqual(frames.map((f) => [f.prefix.commandId, f.prefix.destinationKind]), [
            [message.Command.COMMAND_READY, BROADCAST],
            [message.Command.COMMAND_REQUEST_READY, BROADCAST],
        ]);
        assert.equal(frames[0].header.senderName, 'Electron Main');
        ipcMain.emit('fray:renderer-state', { sender: win.webContents },
            { state: 'ready', threads: ['renderer-messages'] });
        assert.equal(win.sent.length, 0, 'Main does not test the renderer until the renderer says it is ready.');
        const fromRenderer = (commandId, destinationKind) => new Uint8Array(message.buildFrame({
            destinationKind, senderKind: message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER, commandId,
        }, { senderName: 'Electron Renderer', messageId: 5 }));
        ipcMain.emit('fray:frame', { sender: win.webContents },
            fromRenderer(message.Command.COMMAND_READY, BROADCAST));
        await waitUntil(() => win.sent.length === 1, 'the Main to renderer test frame');
        assert.equal(win.sent[0][0], 'fray:frame');
        // The renderer's broadcast reaches the Engine too, but is not echoed back to the renderer.
        await waitUntil(() => frames.some((f) => f.prefix.senderKind === message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER),
            'the renderer broadcast at the Engine');
        assert.equal(win.sent.length, 1);
        assert.equal(frames.some((f) => f.prefix.commandId === message.Command.COMMAND_TEST), false,
            'Main does not test the Engine until the Engine says it is ready.');
        socket.write(message.buildFrame({
            destinationKind: BROADCAST,
            senderKind: message.ProcessKind.PROCESS_KIND_ENGINE,
            commandId: message.Command.COMMAND_READY,
        }, { senderName: 'Engine', messageId: 98 }));
        await waitUntil(() => frames.some((f) => f.prefix.commandId === message.Command.COMMAND_TEST), 'the Main to Engine test frame');
        const fromEngine = message.buildFrame({
            destinationKind: message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN,
            senderKind: message.ProcessKind.PROCESS_KIND_ENGINE,
            commandId: message.Command.COMMAND_TEST,
        }, { senderName: 'Engine', messageId: 99 }, Buffer.from('hi'));
        socket.write(fromEngine);
        const logged = await incomingLogged;
        assert.equal(logged[1], 'Engine');
        app.emit('before-quit', { preventDefault() {} });
        assert.equal(win.sent.at(-1)[0], 'fray:shutdown');
        const framesBeforeQuit = frames.length;
        ipcMain.emit('fray:renderer-state', { sender: win.webContents },
            { state: 'stopped', threads: ['renderer-messages'] });
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(frames.length, framesBeforeQuit, 'Engine must not be told to quit while renderer threads are running.');
        ipcMain.emit('fray:renderer-state', { sender: win.webContents },
            { state: 'stopped', threads: [] });
        await complete;
        const hello = frames.find((f) => f.prefix.commandId === message.Command.COMMAND_TEST);
        assert.equal(hello.header.senderName, 'Electron Main');
        assert.deepEqual(JSON.parse(hello.payload.toString()), { message: 'Hello from Electron Main' });
        assert.equal(frames.at(-1).prefix.commandId, message.Command.COMMAND_QUIT);
        assert.equal(frames.at(-1).payload.length, 0);
        await quitFinished;
    } finally {
        log.electronInfo = originalInfo;
        socket.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('uint64 header fields are preserved beyond JavaScript safe integers', () => {
    const source = message.buildFrame({
        destinationKind: 1,
        senderKind: 3,
    }, {
        messageId: { low: -1, high: -1, unsigned: true },
        timestamp: { low: -1, high: -1, unsigned: true },
    });
    const parsed = message.parseFrame(source);
    assert.equal(parsed.header.messageId, '18446744073709551615');
    assert.equal(parsed.header.timestamp, '18446744073709551615');
});

test('Electron log timestamps use three-digit milliseconds', () => {
    const OriginalDate = global.Date;
    const originalConsoleLog = console.log;
    let output;
    global.Date = class extends OriginalDate {
        constructor() { super(2024, 0, 1, 12, 34, 56, 7); }
    };
    console.log = (line) => { output = line; };
    try {
        log.electronInfo('test');
        assert.match(output, /^\[12:34:56\.007\]/);
    } finally {
        global.Date = OriginalDate;
        console.log = originalConsoleLog;
    }
});
