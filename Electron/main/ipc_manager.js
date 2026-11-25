/* ipc_manager.js */
const net = require('net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { MessageChannel } = require('node:worker_threads');
const log = require('./log_manager');
const message = require('./message');
const { ThreadManager } = require('./thread_manager');

/**
 * TCP client that reads and writes complete Fray frames.
 */
class TCPClient {
    /**
     * Create a TCPClient.
     * @param {string} host Hostname or IP address to connect to.
     * @param {number} port TCP port to connect to.
     * @param {number} [timeoutMs=10000] Max time to keep retrying connection (ms).
     * @param {number} [retryDelayMs=500] Delay between connection retries (ms).
     */
    constructor(host, port, timeoutMs = 10000, retryDelayMs = 500, handlers = {}) {
        this.host = host;
        this.port = port;
        this.timeoutMs = timeoutMs;
        this.retryDelayMs = retryDelayMs;
        this.startTime = Date.now();
        this.client = new net.Socket();
        this.connected = false;
        this.prefixBuffer = Buffer.alloc(message.PREFIX_SIZE);
        this.prefixBytes = 0;
        this.frame = null;
        this.frameBytes = 0;
        this.onFrame = handlers.onFrame;
        this.onConnect = handlers.onConnect;
        this.onClose = handlers.onClose;
        this.onError = handlers.onError;
        this.stopping = false;
        this.finished = false;
        this.retryTimer = null;

        this.client.on('data', (data) => {
            let offset = 0;
            while (offset < data.length) {
                if (!this.frame) {
                    const count = Math.min(message.PREFIX_SIZE - this.prefixBytes, data.length - offset);
                    data.copy(this.prefixBuffer, this.prefixBytes, offset, offset + count);
                    this.prefixBytes += count;
                    offset += count;
                    if (this.prefixBytes < message.PREFIX_SIZE) break;
                    let prefix;
                    try {
                        prefix = message.decodePrefix(this.prefixBuffer);
                    } catch (err) {
                        log.electronError('Invalid message prefix: %s', err.message);
                        this.client.destroy();
                        return;
                    }
                    this.frame = Buffer.allocUnsafeSlow(message.PREFIX_SIZE + prefix.length);
                    this.prefixBuffer.copy(this.frame);
                    this.frameBytes = message.PREFIX_SIZE;
                }
                const count = Math.min(this.frame.length - this.frameBytes, data.length - offset);
                data.copy(this.frame, this.frameBytes, offset, offset + count);
                this.frameBytes += count;
                offset += count;
                if (this.frameBytes < this.frame.length) break;
                const frame = this.frame;
                this.frame = null;
                this.prefixBytes = 0;
                if (this.onFrame) this.onFrame(frame);
            }
        });

        // Log when the connection is closed by the server or due to error cleanup.
        this.client.on('close', () => {
            if (this.prefixBytes || this.frame)
                log.electronError('Connection closed with an incomplete message frame.');
            this.connected = false;
            log.electronInfo('Connection closed');
            if (!this.retryTimer) this.finish();
        });

        // Handle connection errors, retry until timeout or destroy the socket.
        this.client.on('error', (err) => {
            if (err.code === 'ECONNREFUSED' && !this.connected && !this.stopping) {
                if (Date.now() - this.startTime < this.timeoutMs) {
                    this.retryTimer = setTimeout(() => {
                        this.retryTimer = null;
                        if (!this.stopping) this.tryConnect();
                    }, this.retryDelayMs);
                } else {
                    log.electronError(`TCP Client Error: Connection refused, timed out after ${this.timeoutMs}ms`);
                    if (this.onError) this.onError(err.message);
                    this.client.destroy();
                }
            } else {
                log.electronError('TCP Client Error: %s', err.message);
                if (this.onError) this.onError(err.message);
                this.client.destroy();
            }
        });

        this.client.on('connect', () => {
            this.connected = true;
            log.electronInfo(`Connected to TCP server on ${this.port}`);
            if (this.onConnect) this.onConnect();
        });

        this.tryConnect();
    }

    /**
     * Attempt to connect to the configured host/port.
     * On success, marks the client as connected.
     * @returns {void}
     */
    tryConnect() {
        this.client.connect(this.port, this.host);
    }

    /**
     * Send a complete Fray frame.
     * @param {Buffer} frame
     * @returns {void}
     */
    send(frame) {
        if (!this.connected) throw new Error('Cannot send: TCP client is not connected.');
        this.client.write(frame);
    }

    /**
     * Gracefully end the TCP connection.
     * @returns {void}
     */
    close() {
        log.electronInfo("Client connection ending.");
        this.stopping = true;
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        if (this.connected) this.client.end();
        else {
            this.client.destroy();
            this.finish();
        }
    }

    finish() {
        if (this.finished) return;
        this.finished = true;
        if (this.onClose) this.onClose();
    }
}

class IPCManager extends EventEmitter {
    constructor(host, port, threads = new ThreadManager()) {
        super();
        this.threads = threads;
        this.connected = false;
        this.closing = false;
        this.closePromise = null;
        const { port1, port2 } = new MessageChannel();
        this.router = threads.spawn('electron-messages', path.join(__dirname, 'message_worker.js'),
            { port: port1 }, [port1]);
        this.network = threads.spawn('network', path.join(__dirname, 'network_worker.js'),
            { host, port, routerPort: port2 }, [port2]);
        this.network.on('message', (event) => {
            if (event.type === 'connected') {
                this.connected = true;
                this.emit('connected');
            } else if (event.type === 'closed') {
                this.connected = false;
                this.emit('disconnected');
            } else if (event.type === 'error') {
                log.electronError('Network thread: %s', event.message);
            }
        });
        this.router.on('message', (event) => {
            if (event.type === 'message') {
                const frame = Buffer.from(event.frame);
                this.emit('message', {
                    prefix: event.prefix,
                    header: event.header,
                    payload: frame.subarray(message.PREFIX_SIZE + event.prefix.headerLength),
                });
            } else if (event.type === 'forward') {
                if (event.destination === 'engine') {
                    if (this.connected && !this.closing) this.send(Buffer.from(event.frame));
                    else log.electronError('Cannot forward frame: TCP client is not connected.');
                } else {
                    this.emit('renderer-frame', event.frame);
                }
            } else if (event.type === 'error') {
                log.electronError('Message thread: %s', event.message);
            }
        });
        for (const [name, worker] of [['network', this.network], ['electron-messages', this.router]]) {
            worker.on('exit', () => {
                if (!this.closing) {
                    log.electronWarn('Thread %s stopped; closing IPC.', name);
                    this.close();
                }
            });
        }
    }

    send(frame) {
        if (!this.connected || this.closing) throw new Error('Cannot send: TCP client is not connected.');
        this.network.postMessage({ type: 'send', frame });
    }

    routeRendererFrame(frame) {
        if (this.closing) throw new Error('Cannot route frame: IPC is closing.');
        const bytes = Uint8Array.from(frame);
        this.router.postMessage({ type: 'frame', frame: bytes.buffer }, [bytes.buffer]);
    }

    close(finalFrame = null) {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        this.closePromise = this.stop(finalFrame);
        return this.closePromise;
    }

    async stop(finalFrame) {
        this.network.postMessage({ type: 'shutdown', frame: this.connected ? finalFrame : null });
        // Also stop the router if the network worker has already exited.
        if (!this.threads.runningNames().includes('network'))
            this.router.postMessage({ type: 'shutdown' });
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), 1000);
        });
        const names = ['network', 'electron-messages'];
        const stopped = await Promise.race([this.threads.wait(names).then(() => true), timeout]);
        clearTimeout(timer);
        if (!stopped) {
            log.electronWarn('Waiting on threads: %s; terminating.',
                this.threads.runningNames().filter((name) => names.includes(name)).join(', '));
            await this.threads.terminate(names);
        }
        this.connected = false;
    }
}

module.exports = { IPCManager, TCPClient };