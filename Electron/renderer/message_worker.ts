import { buildFrame, decodePrefix, parseFrame, PREFIX_SIZE, processName } from './message';
import { routeMessage } from './message_router';
import { Command, HealthReport, MessageType, PayloadType, ProcessKind } from './message_schema';
import { OutgoingRouter } from '../shared/outgoing_router';
import { NeighborMonitor } from '../shared/neighbor_monitor';
import { parseHealthReport } from '../shared/health';
import { createFrameBuilder } from '../shared/frame_builder';
import type { Prefix } from '../shared/types';

// Workers have no DOM window, so the DOM typing of `self` is narrowed to what this worker uses.
const worker = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
};

const SELF = ProcessKind.PROCESS_KIND_ELECTRON_RENDERER;
const frames = createFrameBuilder(SELF, 2, buildFrame, processName);
let heartbeat = 0;
let processedCount = 0;
let lastProgress = performance.now();

// This thread is the router, so it alone owns the table of which neighbors are ready and the queue of messages
// waiting for each. The UI thread learns about changes through messages and hands over frames to be sent.
const outgoing = new OutgoingRouter<ArrayBuffer>((_kind, frame) => {
  worker.postMessage({ type: 'outgoing', frame }, [frame]);
});

function control(kind: number, commandId: number, destinationId = 0, payload: Uint8Array = new Uint8Array()): void {
  const frame = frames.build({ destination: kind, destinationId, command: commandId, payload,
      payloadType: commandId === Command.COMMAND_PONG ? PayloadType.PAYLOAD_TYPE_PROTOBUF : PayloadType.PAYLOAD_TYPE_NONE,
      messageType: commandId === Command.COMMAND_PONG
        ? MessageType.MESSAGE_TYPE_HEALTH_REPORT : MessageType.MESSAGE_TYPE_NONE });
  worker.postMessage({ type: 'outgoing', frame: frame.buffer }, [frame.buffer]);
}

function healthPayload(): Uint8Array {
  outgoing.sweep();
  return HealthReport.encode(HealthReport.fromObject({
    processedCount, heartbeat, progressAgeMs: Math.floor(performance.now() - lastProgress),
    queues: outgoing.queueHealth(),
  })).finish();
}

function noteProgress(commandId: number): void {
  if (commandId === Command.COMMAND_READY || commandId === Command.COMMAND_REQUEST_READY ||
      commandId === Command.COMMAND_PING || commandId === Command.COMMAND_PONG) return;
  processedCount++;
  lastProgress = performance.now();
}

const monitor = new NeighborMonitor(
  (kind, command) => {
    if (command === 'probe') console.info(`Sending readiness probe to ${processName(kind)}.`);
    control(kind, command === 'probe' ? Command.COMMAND_REQUEST_READY : Command.COMMAND_PING);
  },
  (kind) => outgoing.state(kind),
  (kind, state) => {
    if (state === 'ready') {
      if (outgoing.markReady(kind)) worker.postMessage({ type: 'peer-ready', kind });
    } else {
      outgoing.setState(kind, state);
      if (state === 'down' || state === 'unreachable') outgoing.discardQueue(kind);
      if (state !== 'probing') console.warn(`${processName(kind)} is ${state.toUpperCase()}.`);
    }
  },
);
monitor.start(ProcessKind.PROCESS_KIND_ELECTRON_MAIN);
const monitorTimer = setInterval(() => { outgoing.sweep(); monitor.tick(); }, 1000);
function readFrame(buffer: ArrayBuffer): { frame: Uint8Array; prefix: Prefix } {
  const frame = new Uint8Array(buffer);
  const prefix = decodePrefix(frame);
  if (frame.length !== PREFIX_SIZE + prefix.length) throw new Error('Message length does not match its prefix.');
  return { frame, prefix };
}

// A frame from Electron Main. A READY from a neighbor marks it ready and delivers whatever was waiting for it.
function receive(buffer: ArrayBuffer): void {
  const { frame, prefix } = readFrame(buffer);
  if (routeMessage(prefix) !== 'electron-renderer') {
    throw new Error(`Cannot route message: unsupported destination kind=${prefix.destinationKind} id=${prefix.destinationId}.`);
  }
  const sender = prefix.senderKind;
  const { header, payload } = parseFrame(frame);
  noteProgress(prefix.commandId);
  if (prefix.commandId === Command.COMMAND_PONG) {
    if (header.payloadType !== PayloadType.PAYLOAD_TYPE_PROTOBUF ||
        header.messageType !== MessageType.MESSAGE_TYPE_HEALTH_REPORT)
      throw new Error('Invalid health report type.');
    const report = HealthReport.decode(payload);
    monitor.report(sender, parseHealthReport(HealthReport.toObject(report, { defaults: true, longs: String })));
  }
  monitor.observe(sender, prefix.commandId === Command.COMMAND_READY);
  if (prefix.commandId === Command.COMMAND_READY && sender !== SELF && sender !== ProcessKind.PROCESS_KIND_BROADCAST
      && outgoing.state(sender) !== 'degraded' && outgoing.markReady(sender)) {
    worker.postMessage({ type: 'peer-ready', kind: sender });
  }
  if (prefix.commandId === Command.COMMAND_PING)
    control(sender, Command.COMMAND_PONG, prefix.senderId, healthPayload());
  worker.postMessage({ type: 'message', prefix, header, frame: buffer }, [buffer]);
}

// A frame from the UI thread. Readiness messages and broadcasts always go out at once, because they are how readiness
// is learned. Everything else waits in the queue until its destination is ready.
function send(buffer: ArrayBuffer): void {
  const { frame, prefix } = readFrame(buffer);
  const kind = prefix.destinationKind;
  if (kind === SELF) throw new Error('Cannot send a message to the renderer itself.');
  noteProgress(prefix.commandId);
  if (kind === ProcessKind.PROCESS_KIND_BROADCAST || prefix.commandId === Command.COMMAND_READY
      || prefix.commandId === Command.COMMAND_REQUEST_READY || prefix.commandId === Command.COMMAND_PING
      || prefix.commandId === Command.COMMAND_PONG) {
    worker.postMessage({ type: 'outgoing', frame: buffer }, [buffer]);
    return;
  }
  const { header } = parseFrame(frame);
  if (!outgoing.send(kind, buffer, header.ttlMs)) console.info(`${processName(kind)} is not ready; the message is waiting.`);
}

worker.onmessage = ({ data }) => {
  if (data.type === 'shutdown') {
    clearInterval(monitorTimer);
    worker.postMessage({ type: 'stopped' });
    worker.close();
    return;
  }
  if (data.type === 'heartbeat') {
    heartbeat = data.heartbeat;
    return;
  }
  if (data.type !== 'frame' && data.type !== 'send') return;
  try {
    if (data.type === 'frame') receive(data.frame);
    else send(data.frame);
  } catch (error) {
    worker.postMessage({ type: 'error', message: (error as Error).message });
  }
};

worker.postMessage({ type: 'ready' });
