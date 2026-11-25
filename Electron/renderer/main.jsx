import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { IPCManager } from './ipc_manager';
import { buildFrame, Command, PayloadType, processName, ProcessKind } from './message';
import { handleReadiness, PeerReadiness } from './readiness';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);

const SELF = ProcessKind.PROCESS_KIND_ELECTRON_RENDERER;

if (window.frayBridge) {
  const peers = new PeerReadiness();
  let nextMessageId = 1;
  let ipc;

  function makeFrame(commandId, destinationKind, destinationId = 0, payload = new Uint8Array()) {
    return buildFrame({ destinationKind, destinationId, senderKind: SELF, commandId }, {
      protocolVersion: 1,
      messageId: nextMessageId++,
      timestamp: Date.now(),
      senderName: processName(SELF),
      destinationName: processName(destinationKind),
      payloadType: payload.length ? PayloadType.PAYLOAD_TYPE_JSON : PayloadType.PAYLOAD_TYPE_NONE,
    }, payload);
  }

  // Messages to a peer that is not ready are dropped, not queued.
  function sendToReadyPeer(kind, frame) {
    if (!peers.isReady(kind)) {
      console.warn(`Cannot send to ${processName(kind)}: it has not said it is ready.`);
      return;
    }
    ipc.send(frame);
  }

  function sendTestFrame(kind) {
    const payload = kind === ProcessKind.PROCESS_KIND_ENGINE
      ? new TextEncoder().encode(JSON.stringify({ message: 'Hello from Electron Renderer' })) : new Uint8Array();
    sendToReadyPeer(kind, makeFrame(Command.COMMAND_TEST, kind, 0, payload));
  }

  // Electron Main is this process's only way to reach the others, so the renderer announces itself to everyone
  // once it hears that Main is ready.
  function announceReady() {
    ipc.send(makeFrame(Command.COMMAND_READY, ProcessKind.PROCESS_KIND_BROADCAST));
    ipc.send(makeFrame(Command.COMMAND_REQUEST_READY, ProcessKind.PROCESS_KIND_BROADCAST));
  }

  ipc = new IPCManager(window.frayBridge, ({ prefix, header, payload }) => {
    console.info(`Renderer received frame: command=${prefix.commandId} message_id=${header.messageId} payload_bytes=${payload.length} sender=${header.senderName}.`);
    handleReadiness(prefix, SELF, peers, {
      reply: (kind, id) => ipc.send(makeFrame(Command.COMMAND_READY, kind, id)),
      onPeerReady: (kind) => {
        console.info(`${processName(kind)} is ready.`);
        if (kind === ProcessKind.PROCESS_KIND_ELECTRON_MAIN) announceReady();
        sendTestFrame(kind);
      },
    });
  }, () => {
    ipc.send(makeFrame(Command.COMMAND_REQUEST_READY, ProcessKind.PROCESS_KIND_ELECTRON_MAIN));
  });
}
