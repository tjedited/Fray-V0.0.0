/* ipc.js */
const net = require('net');
const log = require('./log');

class TCPClient {
    constructor(host, port, timeoutMs = 10000, retryDelayMs = 500) {
        this.host = host;
        this.port = port;
        this.timeoutMs = timeoutMs;
        this.retryDelayMs = retryDelayMs;
        this.startTime = Date.now();
        this.client = new net.Socket();
        this.connected = false;
        this.recvBuffer = Buffer.alloc(0);

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

        this.client.on('close', () => {
            log.electronInfo('Connection closed');
        });

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

        // Send a ping every 5 seconds
        this.pingInterval = setInterval(() => {
            if (this.connected) {
                log.electronInfo('Sent: ping');
                this.send('ping');
            }
        }, 5000);
    }

    tryConnect() {
        this.client.connect(this.port, this.host, () => {
            this.connected = true;
            log.electronInfo(`Connected to TCP server at ${this.host}:${this.port}`);
            this.send('Hello from Electron TCP client!');
        });
    }

    send(data) {
        if (this.connected) {
            const msgBuffer = Buffer.from(data, 'utf8');
            const header = Buffer.alloc(4);
            header.writeUInt32BE(msgBuffer.length, 0);
            this.client.write(Buffer.concat([header, msgBuffer]));
        }
    }

    close() {
        log.electronInfo("Client connection ending.");
        clearInterval(this.pingInterval); // Stop pinging
        this.client.end();
    }
}

module.exports = { TCPClient };