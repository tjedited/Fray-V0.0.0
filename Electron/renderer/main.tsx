import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { IPCManager } from './ipc_manager';
import { buildFrame, Command, PayloadType, processName, ProcessKind } from './message';

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);

const SELF = ProcessKind.PROCESS_KIND_ELECTRON_RENDERER;

const bridge = window.frayBridge;
if (bridge) {
  // The UI thread and its message worker use odd and even IDs respectively.
  let nextMessageId = 1;
  let ipc: IPCManager;

  function makeFrame(commandId: number, destinationKind: number, destinationId = 0, payload: Uint8Array = new Uint8Array()): Uint8Array {
    return buildFrame({ destinationKind, destinationId, senderKind: SELF, commandId }, {
      protocolVersion: 1,
      messageId: (nextMessageId += 2) - 2,
      timestamp: Date.now(),
      senderName: processName(SELF),
      destinationName: processName(destinationKind),
      payloadType: payload.length ? PayloadType.PAYLOAD_TYPE_JSON : PayloadType.PAYLOAD_TYPE_NONE,
    }, payload);
  }

  function sendTestFrame(kind: number): void {
    const payload = kind === ProcessKind.PROCESS_KIND_ENGINE
      ? new TextEncoder().encode(JSON.stringify({ message: 'Hello from Electron Renderer' })) : new Uint8Array();
    ipc.send(makeFrame(Command.COMMAND_TEST, kind, 0, payload));
  }

  // Electron Main is this process's only way to reach the others, so the renderer announces itself to everyone
  // once it hears that Main is ready.
  let mainReady = false;
  function announceReady(): void {
    ipc.send(makeFrame(Command.COMMAND_READY, ProcessKind.PROCESS_KIND_BROADCAST));
    ipc.send(makeFrame(Command.COMMAND_REQUEST_READY, ProcessKind.PROCESS_KIND_BROADCAST));
  }

  ipc = new IPCManager(bridge, ({ prefix, header, payload }) => {
    if (prefix.commandId !== Command.COMMAND_PING && prefix.commandId !== Command.COMMAND_PONG)
      console.info(`Renderer received frame: command=${prefix.commandId} message_id=${header.messageId} payload_bytes=${payload.length} sender=${header.senderName}.`);
    // A request is answered with a READY sent back to the requester only.
    const sender = prefix.senderKind;
    if (prefix.commandId === Command.COMMAND_REQUEST_READY && sender !== SELF && sender !== ProcessKind.PROCESS_KIND_BROADCAST)
      ipc.send(makeFrame(Command.COMMAND_READY, sender, prefix.senderId));
  }, () => {
    ipc.send(makeFrame(Command.COMMAND_REQUEST_READY, ProcessKind.PROCESS_KIND_ELECTRON_MAIN));
    // Each test frame waits in the router's queue until its peer says it is ready.
    sendTestFrame(ProcessKind.PROCESS_KIND_ELECTRON_MAIN);
    sendTestFrame(ProcessKind.PROCESS_KIND_ENGINE);
  }, (kind) => {
    console.info(`${processName(kind)} is ready.`);
    if (kind === ProcessKind.PROCESS_KIND_ELECTRON_MAIN) {
      mainReady = true;
      announceReady();
    } else if (mainReady) {
      // Answer a newly ready neighbor with our own READY so it need not ask; only a change triggers this.
      ipc.send(makeFrame(Command.COMMAND_READY, kind));
    }
  });
}
