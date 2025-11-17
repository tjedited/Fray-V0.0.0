/* ipc.js */
const net = require('net');
const log = require('./log');

/**
 * TCP client that connects to a local engine over a size-prefixed protocol.
 * Each outbound message is prefixed with a 4-byte big-endian length header.
 * Incoming data is buffered and parsed into complete messages using that header.
 */
class TCPClient {
    /**
     * Create a TCPClient.
     * @param {string} host Hostname or IP address to connect to.
     * @param {number} port TCP port to connect to.
     * @param {number} [timeoutMs=10000] Max time to keep retrying connection (ms).
     * @param {number} [retryDelayMs=500] Delay between connection retries (ms).
     */
    constructor(host, port, timeoutMs = 10000, retryDelayMs = 500) {
        this.host = host;
        this.port = port;
        this.timeoutMs = timeoutMs;
        this.retryDelayMs = retryDelayMs;
        this.startTime = Date.now();
        this.client = new net.Socket();
        this.connected = false;
        this.recvBuffer = Buffer.alloc(0);

        // Parse incoming data stream into complete messages using a 4-byte header.
        this.client.on('data', (data) => {
            this.recvBuffer = Buffer.concat([this.recvBuffer, data]);
            while (this.recvBuffer.length >= 4) {
                const msgLen = this.recvBuffer.readUInt32BE(0);
                if (this.recvBuffer.length >= 4 + msgLen) {
                    const msg = this.recvBuffer.slice(4, 4 + msgLen).toString('utf8');
                    log.electronInfo('Received: %s', msg);
                    this.recvBuffer = this.recvBuffer.slice(4 + msgLen);
                } else {
                    break;
                }
            }
        });

        // Log when the connection is closed by the server or due to error cleanup.
        this.client.on('close', () => {
            log.electronInfo('Connection closed');
        });

        // Handle connection errors, retry until timeout or destroy the socket.
        this.client.on('error', (err) => {
            if (err.code === 'ECONNREFUSED' && !this.connected) {
                if (Date.now() - this.startTime < this.timeoutMs) {
                    setTimeout(() => this.tryConnect(), this.retryDelayMs);
                } else {
                    log.electronError(`TCP Client Error: Connection refused, timed out after ${this.timeoutMs}ms`);
                    this.client.destroy();
                }
            } else {
                log.electronError('TCP Client Error: %s', err.message);
                this.client.destroy();
            }
        });

        this.tryConnect();

        // Send a ping every 1 second while connected.
        /** @type {NodeJS.Timeout} */
        this.pingInterval = setInterval(() => {
            if (this.connected) {
                log.electronInfo('Sent: ping');
                this.send('ping');
            }
        }, 5000);
    }

    /**
     * Attempt to connect to the configured host/port.
     * On success, marks the client as connected and sends an initial greeting.
     * @returns {void}
     */
    tryConnect() {
        this.client.connect(this.port, this.host, () => {
            this.connected = true;
            log.electronInfo(`Connected to TCP server on ${this.port}`);
            this.send('Hello from Electron TCP client!');
        });
    }

    /**
     * Send a UTF-8 message with a 4-byte big-endian length header.
     * No-op if not currently connected.
     * @param {string} data Message body to send.
     * @returns {void}
     */
    send(data) {
        if (this.connected) {
            const msgBuffer = Buffer.from(data, 'utf8');
            const header = Buffer.alloc(4);
            header.writeUInt32BE(msgBuffer.length, 0);
            this.client.write(Buffer.concat([header, msgBuffer]));
        }
    }

    /**
     * Gracefully end the TCP connection and stop the periodic ping.
     * @returns {void}
     */
    close() {
        log.electronInfo("Client connection ending.");
        clearInterval(this.pingInterval);
        this.client.end();
    }
}

module.exports = { TCPClient };