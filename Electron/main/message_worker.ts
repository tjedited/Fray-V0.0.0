/* message_worker.js */
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import * as message from './message';
import { routeMessage, type Target } from './message_router';
import { OutgoingRouter } from '../shared/outgoing_router';
import { NeighborMonitor } from '../shared/neighbor_monitor';
import { parseHealthReport } from '../shared/health';
import { createFrameBuilder } from '../shared/frame_builder';
import type { DecodedHeader, Prefix } from '../shared/types';

const { ProcessKind, Command } = message;
const SELF = ProcessKind.PROCESS_KIND_ELECTRON_MAIN;
const parent = parentPort!;
const networkPort: MessagePort = workerData.port;
let invalid = false;
const frames = createFrameBuilder(SELF, 2, message.buildFrame, message.processName);
let heartbeat = 0;
let processedCount = 0;
let lastProgress = performance.now();

// Where a frame came from: the Engine, the renderer, or Electron Main itself.
type Source = 'network' | 'renderer' | 'local';

const TARGET_KINDS: Record<string, number> = {
    engine: ProcessKind.PROCESS_KIND_ENGINE,
    'electron-renderer': ProcessKind.PROCESS_KIND_ELECTRON_RENDERER,
};

// This thread is the router, so it alone owns the table of which neighbors are ready and the queue of messages
// waiting for each. Everything else learns about changes through messages.
const outgoing = new OutgoingRouter<ArrayBuffer>((kind, bytes) => forward(kind === ProcessKind.PROCESS_KIND_ENGINE
    ? 'engine' : 'electron-renderer', bytes, false));

function control(kind: number, commandId: number, destinationId = 0, payload: Uint8Array = new Uint8Array()): void {
    const bytes = Uint8Array.from(frames.build({ destination: kind, destinationId, command: commandId, payload,
        payloadType: commandId === Command.COMMAND_PONG
            ? message.PayloadType.PAYLOAD_TYPE_PROTOBUF : message.PayloadType.PAYLOAD_TYPE_NONE,
        messageType: commandId === Command.COMMAND_PONG
            ? message.MessageType.MESSAGE_TYPE_HEALTH_REPORT : message.MessageType.MESSAGE_TYPE_NONE,
    }));
    routeFrame(bytes.buffer, 'local');
}

function healthPayload(): Uint8Array {
    outgoing.sweep();
    return message.HealthReport.encode(message.HealthReport.fromObject({
        processedCount, heartbeat, progressAgeMs: Math.floor(performance.now() - lastProgress),
        queues: outgoing.queueHealth(),
    })).finish();
}

const monitor = new NeighborMonitor(
    (kind, command) => {
        if (command === 'probe') log('info', `Sending readiness probe to ${message.processName(kind)}.`);
        control(kind, command === 'probe' ? Command.COMMAND_REQUEST_READY : Command.COMMAND_PING);
    },
    (kind) => outgoing.state(kind),
    (kind, state) => {
        if (state === 'ready') {
            if (outgoing.markReady(kind)) parent.postMessage({ type: 'peer-ready', kind });
        } else {
            outgoing.setState(kind, state);
            if (state === 'down' || state === 'unreachable') {
                outgoing.discardQueue(kind);
                parent.postMessage({ type: 'peer-unavailable', kind });
            }
            if (state !== 'probing') log('warn', `${message.processName(kind)} is ${state.toUpperCase()}.`);
        }
    },
);
monitor.start(ProcessKind.PROCESS_KIND_ELECTRON_RENDERER);
const monitorTimer = setInterval(() => { outgoing.sweep(); monitor.tick(); }, 1000);
monitorTimer.unref();

function networkEnded(): void {
    const engine = ProcessKind.PROCESS_KIND_ENGINE;
    if (outgoing.state(engine) === 'unreachable') return;
    outgoing.setState(engine, 'unreachable');
    outgoing.discardQueue(engine);
    parent.postMessage({ type: 'peer-unavailable', kind: engine });
}

function forward(destination: Target, bytes: ArrayBuffer, broadcast: boolean): void {
    parent.postMessage({ type: 'forward', destination, frame: bytes, broadcast }, [bytes]);
}

function log(level: 'info' | 'warn', text: string): void {
    parent.postMessage({ type: 'log', level, message: text });
}

// Relayed frames are not inspected beyond their time to live; the process they are for rejects a bad header itself.
function timeToLive(frame: Buffer): number {
    try {
        return message.parseFrame(frame).header.ttlMs;
    } catch {
        return 0;
    }
}

// A READY from a neighbor marks it ready and delivers whatever was waiting for it.
function noteReadiness(prefix: Prefix, source: Source): void {
    const sender = prefix.senderKind;
    if (source === 'local' || prefix.commandId !== Command.COMMAND_READY ||
        sender === SELF || sender === ProcessKind.PROCESS_KIND_BROADCAST) return;
    if (outgoing.state(sender) !== 'degraded' && outgoing.markReady(sender))
        parent.postMessage({ type: 'peer-ready', kind: sender });
}

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
    // Readiness messages and broadcasts always go out at once, because they are how readiness is learned.
    // Everything else waits in the queue until its destination is ready.
    const broadcast = prefix.destinationKind === ProcessKind.PROCESS_KIND_BROADCAST;
    const queued = !broadcast && prefix.commandId !== Command.COMMAND_READY &&
        prefix.commandId !== Command.COMMAND_REQUEST_READY && prefix.commandId !== Command.COMMAND_PING &&
        prefix.commandId !== Command.COMMAND_PONG;
    let incoming: { prefix: Prefix; header: DecodedHeader; payload: Buffer } | null = null;
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
    if (queued || (broadcast && prefix.commandId !== Command.COMMAND_READY &&
        prefix.commandId !== Command.COMMAND_REQUEST_READY && prefix.commandId !== Command.COMMAND_PING &&
        prefix.commandId !== Command.COMMAND_PONG)) {
        processedCount++;
        lastProgress = performance.now();
    }
    if (source !== 'local') {
        if (incoming && prefix.commandId === Command.COMMAND_PONG) {
            try {
                if (incoming.header.payloadType !== message.PayloadType.PAYLOAD_TYPE_PROTOBUF ||
                    incoming.header.messageType !== message.MessageType.MESSAGE_TYPE_HEALTH_REPORT)
                    throw new Error('Unexpected health report type.');
                const decoded = message.HealthReport.decode(incoming.payload);
                monitor.report(prefix.senderKind, parseHealthReport(message.HealthReport.toObject(decoded,
                    { defaults: true, longs: String })));
            } catch (error) {
                parent.postMessage({ type: 'error', message: `Invalid health report: ${(error as Error).message}` });
            }
        }
        if (incoming || prefix.commandId === Command.COMMAND_READY)
            monitor.observe(prefix.senderKind, prefix.commandId === Command.COMMAND_READY);
        noteReadiness(prefix, source);
        if (incoming && prefix.commandId === Command.COMMAND_PING)
            control(prefix.senderKind, Command.COMMAND_PONG, prefix.senderId, healthPayload());
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
        } else if (queued) {
            if (!outgoing.send(TARGET_KINDS[target], bytesToSend, incoming ? incoming.header.ttlMs : timeToLive(frame)))
                log('info', `${message.processName(TARGET_KINDS[target])} is not ready; the message is waiting.`);
        } else {
            forward(target, bytesToSend, broadcast);
        }
    });
}

networkPort.on('message', (event: { type: string; frame: ArrayBuffer }) => {
    if (event.type === 'connected') {
        monitor.start(ProcessKind.PROCESS_KIND_ENGINE);
        return;
    }
    if (event.type === 'end') {
        networkEnded();
        networkPort.close();
        return;
    }
    if (event.type === 'frame' && !invalid) routeFrame(event.frame, 'network');
});

parent.on('message', (event: { type: string; frame: ArrayBuffer; source?: Source; kind: number; heartbeat: number }) => {
    if (event.type === 'frame') {
        routeFrame(event.frame, event.source ?? 'renderer');
    } else if (event.type === 'heartbeat') {
        heartbeat = event.heartbeat;
    } else if (event.type === 'not-ready') {
        outgoing.markNotReady(event.kind);
        if (event.kind === ProcessKind.PROCESS_KIND_ELECTRON_RENDERER)
            monitor.start(event.kind);
    } else if (event.type === 'network-ended') {
        networkEnded();
    } else if (event.type === 'shutdown') {
        clearInterval(monitorTimer);
        networkPort.close();
        parent.close();
    }
});
