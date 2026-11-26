/* message_worker.js */
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import * as message from './message';
import { routeMessage } from './message_router';
import type { DecodedHeader, Prefix } from '../shared/types';

const parent = parentPort!;
const networkPort: MessagePort = workerData.port;
let invalid = false;

type Source = 'network' | 'renderer';

function routeFrame(bytes: ArrayBuffer, source: Source): void {
    let frame: Buffer;
    let prefix: Prefix;
    try {
        frame = Buffer.from(bytes);
        prefix = message.decodePrefix(frame);
        if (frame.length !== message.PREFIX_SIZE + prefix.length)
            throw new Error('Message length does not match its prefix.');
    } catch (error) {
        parent.postMessage({ type: 'error', message: `Invalid message frame: ${(error as Error).message}` });
        if (source === 'network') {
            invalid = true;
            networkPort.postMessage({ type: 'invalid' });
        }
        return;
    }
    // Frames from the network came from the Engine, so none of them can be sent back to it.
    const targets = routeMessage(prefix).filter((target) => !(target === 'engine' && source === 'network'));
    if (targets.length === 0) {
        parent.postMessage({
            type: 'error',
            message: `Cannot route message: unsupported destination kind=${prefix.destinationKind} id=${prefix.destinationId}.`,
        });
        return;
    }
    let incoming: { prefix: Prefix; header: DecodedHeader } | null = null;
    if (targets.includes('electron-main')) {
        try {
            incoming = message.parseFrame(frame);
        } catch (error) {
            parent.postMessage({ type: 'error', message: `Invalid message header: ${(error as Error).message}` });
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
            parent.postMessage({
                type: 'message',
                prefix: incoming!.prefix,
                header: incoming!.header,
                frame: bytesToSend,
            }, [bytesToSend]);
        } else {
            parent.postMessage({ type: 'forward', destination: target, frame: bytesToSend }, [bytesToSend]);
        }
    });
}

networkPort.on('message', (event: { type: string; frame: ArrayBuffer }) => {
    if (event.type === 'end') {
        networkPort.close();
        parent.close();
        return;
    }
    if (event.type === 'frame' && !invalid) routeFrame(event.frame, 'network');
});

parent.on('message', (event: { type: string; frame: ArrayBuffer }) => {
    if (event.type === 'frame') {
        routeFrame(event.frame, 'renderer');
    } else if (event.type === 'shutdown') {
        networkPort.close();
        parent.close();
    }
});
