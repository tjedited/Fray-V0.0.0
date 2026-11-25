/* message_worker.js */
const { parentPort, workerData } = require('node:worker_threads');
const message = require('./message');
const { routeMessage } = require('./message_router');

const networkPort = workerData.port;
let invalid = false;

function routeFrame(bytes, source) {
    let frame;
    let prefix;
    try {
        frame = Buffer.from(bytes);
        prefix = message.decodePrefix(frame);
        if (frame.length !== message.PREFIX_SIZE + prefix.length)
            throw new Error('Message length does not match its prefix.');
    } catch (error) {
        parentPort.postMessage({ type: 'error', message: `Invalid message frame: ${error.message}` });
        if (source === 'network') {
            invalid = true;
            networkPort.postMessage({ type: 'invalid' });
        }
        return;
    }
    // Frames from the network came from the Engine, so none of them can be sent back to it.
    const targets = routeMessage(prefix).filter((target) => !(target === 'engine' && source === 'network'));
    if (targets.length === 0) {
        parentPort.postMessage({
            type: 'error',
            message: `Cannot route message: unsupported destination kind=${prefix.destinationKind} id=${prefix.destinationId}.`,
        });
        return;
    }
    let incoming = null;
    if (targets.includes('electron-main')) {
        try {
            incoming = message.parseFrame(frame);
        } catch (error) {
            parentPort.postMessage({ type: 'error', message: `Invalid message header: ${error.message}` });
            if (source === 'network') {
                invalid = true;
                networkPort.postMessage({ type: 'invalid' });
            }
            return;
        }
    }
    // Every delivery but the last gets its own copy, because posting an ArrayBuffer transfers it away.
    targets.forEach((target, index) => {
        const bytesToSend = index === targets.length - 1 ? bytes : bytes.slice(0);
        if (target === 'electron-main') {
            parentPort.postMessage({
                type: 'message',
                prefix: incoming.prefix,
                header: incoming.header,
                frame: bytesToSend,
            }, [bytesToSend]);
        } else {
            parentPort.postMessage({ type: 'forward', destination: target, frame: bytesToSend }, [bytesToSend]);
        }
    });
}

networkPort.on('message', (event) => {
    if (event.type === 'end') {
        networkPort.close();
        parentPort.close();
        return;
    }
    if (event.type === 'frame' && !invalid) routeFrame(event.frame, 'network');
});

parentPort.on('message', (event) => {
    if (event.type === 'frame') {
        routeFrame(event.frame, 'renderer');
    } else if (event.type === 'shutdown') {
        networkPort.close();
        parentPort.close();
    }
});
