/* ipc_manager.js */
import * as net from 'node:net';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { MessageChannel, type Worker } from 'node:worker_threads';
import * as log from './log_manager';
import * as message from './message';
import { ThreadManager } from './thread_manager';
import type { DecodedHeader, IncomingMessage, Prefix } from '../shared/types';

export interface TCPClientHandlers {
    onFrame?: (frame: Buffer) => void;
    onConnect?: () => void;
    onClose?: () => void;
    onError?: (error: string) => void;
}

/** Events emitted by IPCManager. */
export interface IPCManagerEvents {
    connected: [];
    disconnected: [];
    message: [IncomingMessage<Buffer>];
    /** A frame to hand to the renderer. `broadcast` frames are sent only if the renderer can take them. */
    'renderer-frame': [ArrayBuffer, boolean];
    /** A neighbor became ready, as seen by the router thread. */
    'peer-ready': [number];
    'peer-unavailable': [number];
}

/**
 * TCP client that reads and writes complete Fray frames.
 */
export class TCPClient {
    readonly client = new net.Socket();
    connected = false;
    private readonly startTime = Date.now();
    private readonly prefixBuffer = Buffer.alloc(message.PREFIX_SIZE);
    private prefixBytes = 0;
    private frame: Buffer | null = null;
    private frameBytes = 0;
    private readonly onFrame?: (frame: Buffer) => void;
    private readonly onConnect?: () => void;
    private readonly onClose?: () => void;
    private readonly onError?: (error: string) => void;
    private stopping = false;
    private finished = false;
    private retryTimer: NodeJS.Timeout | null = null;

    /**
     * Create a TCPClient.
     * @param host Hostname or IP address to connect to.
     * @param port TCP port to connect to.
     * @param timeoutMs Max time to keep retrying connection (ms).
     * @param retryDelayMs Delay between connection retries (ms).
     */
    constructor(
        private readonly host: string,
        private readonly port: number,
        private readonly timeoutMs = 10000,
        private readonly retryDelayMs = 500,
        handlers: TCPClientHandlers = {},
    ) {
        this.onFrame = handlers.onFrame;
        this.onConnect = handlers.onConnect;
        this.onClose = handlers.onClose;
        this.onError = handlers.onError;

        this.client.on('data', (data: Buffer) => {
            let offset = 0;
            while (offset < data.length) {
                if (!this.frame) {
                    const count = Math.min(message.PREFIX_SIZE - this.prefixBytes, data.length - offset);
                    data.copy(this.prefixBuffer, this.prefixBytes, offset, offset + count);
                    this.prefixBytes += count;
                    offset += count;
                    if (this.prefixBytes < message.PREFIX_SIZE) break;
                    let prefix: Prefix;
                    try {
                        prefix = message.decodePrefix(this.prefixBuffer);
                    } catch (err) {
                        log.electronError('Invalid message prefix: %s', (err as Error).message);
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
        this.client.on('error', (err: NodeJS.ErrnoException) => {
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
     */
    tryConnect(): void {
        this.client.connect(this.port, this.host);
    }

    /**
     * Send a complete Fray frame.
     */
    send(frame: Buffer): void {
        if (!this.connected) throw new Error('Cannot send: TCP client is not connected.');
        this.client.write(frame);
    }

    /**
     * Gracefully end the TCP connection.
     */
    close(): void {
        log.electronInfo("Client connection ending.");
        this.stopping = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        if (this.connected) this.client.end();
        else {
            this.client.destroy();
            this.finish();
        }
    }

    private finish(): void {
        if (this.finished) return;
        this.finished = true;
        if (this.onClose) this.onClose();
    }
}

export class IPCManager extends EventEmitter<IPCManagerEvents> {
    connected = false;
    private closing = false;
    private closePromise: Promise<void> | null = null;
    private readonly router: Worker;
    private readonly network: Worker;
    private readonly heartbeatTimer: NodeJS.Timeout;

    constructor(host: string, port: number, private readonly threads = new ThreadManager()) {
        super();
        const { port1, port2 } = new MessageChannel();
        this.router = threads.spawn('electron-messages', path.join(__dirname, 'message_worker.js'),
            { port: port1 }, [port1]);
        let heartbeat = 0;
        const beat = () => this.router.postMessage({ type: 'heartbeat', heartbeat: ++heartbeat });
        beat();
        this.heartbeatTimer = setInterval(beat, 1000);
        this.heartbeatTimer.unref();
        this.network = threads.spawn('network', path.join(__dirname, 'network_worker.js'),
            { host, port, routerPort: port2 }, [port2]);
        this.network.on('message', (event: { type: string; message?: string }) => {
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
        this.router.on('message', (event: { type: string; prefix: Prefix; header: DecodedHeader; frame: ArrayBuffer; destination?: string; broadcast?: boolean; kind?: number; level?: string; message?: string }) => {
            if (event.type === 'message') {
                const frame = Buffer.from(event.frame);
                this.emit('message', {
                    prefix: event.prefix,
                    header: event.header,
                    payload: frame.subarray(message.PREFIX_SIZE + event.prefix.headerLength),
                });
            } else if (event.type === 'forward') {
                if (event.destination === 'engine') {
                    if (this.connected && !this.closing) this.network.postMessage({ type: 'send', frame: Buffer.from(event.frame) });
                    else log.electronError('Cannot forward frame: TCP client is not connected.');
                } else {
                    this.emit('renderer-frame', event.frame, event.broadcast === true);
                }
            } else if (event.type === 'peer-ready') {
                this.emit('peer-ready', event.kind!);
            } else if (event.type === 'peer-unavailable') {
                this.emit('peer-unavailable', event.kind!);
            } else if (event.type === 'log') {
                if (event.level === 'warn') log.electronWarn('Message thread: %s', event.message);
                else log.electronInfo('Message thread: %s', event.message);
            } else if (event.type === 'error') {
                log.electronError('Message thread: %s', event.message);
            }
        });
        const workers: [string, Worker][] = [['network', this.network], ['electron-messages', this.router]];
        for (const [name, worker] of workers) {
            worker.on('exit', () => {
                if (!this.closing) {
                    if (name === 'network') {
                        this.connected = false;
                        this.router.postMessage({ type: 'network-ended' });
                        log.electronWarn('Network thread stopped; Main and Renderer routing remains available.');
                    } else {
                        log.electronWarn('Thread %s stopped; closing IPC.', name);
                        void this.close();
                    }
                }
            });
        }
    }

    /**
     * Hands a frame to the router thread and returns at once. The router sends it now if its destination is ready,
     * and otherwise holds it until the destination is ready or the header's ttlMs runs out. Nothing comes back.
     */
    send(frame: Buffer): void {
        if (this.closing) throw new Error('Cannot send: IPC is closing.');
        const bytes = Uint8Array.from(frame);
        this.router.postMessage({ type: 'frame', source: 'local', frame: bytes.buffer }, [bytes.buffer]);
    }

    /** Tells the router that a neighbor can no longer be reached, so messages for it wait in the queue again. */
    markNotReady(kind: number): void {
        if (!this.closing) this.router.postMessage({ type: 'not-ready', kind });
    }

    routeRendererFrame(frame: Uint8Array): void {
        if (this.closing) throw new Error('Cannot route frame: IPC is closing.');
        const bytes = Uint8Array.from(frame);
        this.router.postMessage({ type: 'frame', frame: bytes.buffer }, [bytes.buffer]);
    }

    close(finalFrame: Buffer | null = null): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        clearInterval(this.heartbeatTimer);
        this.closePromise = this.stop(finalFrame);
        return this.closePromise;
    }

    private async stop(finalFrame: Buffer | null): Promise<void> {
        this.network.postMessage({ type: 'shutdown', frame: this.connected ? finalFrame : null });
        this.router.postMessage({ type: 'shutdown' });
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<boolean>((resolve) => {
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
