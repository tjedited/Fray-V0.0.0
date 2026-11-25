import { Header, ProcessKind, PayloadType, MessageType, Command } from '../renderer/message_schema.js';

try {
  const hex = new URLSearchParams(location.search).get('header');
  const bytes = Uint8Array.from(hex.match(/../g), (pair) => Number.parseInt(pair, 16));
  const decoded = Header.toObject(Header.decode(bytes), { defaults: true, longs: String });
  const header = Header.fromObject({
    protocolVersion: 1,
    messageId: '18446744073709551615',
    timestamp: '18446744073709551614',
    senderName: 'Renderer',
    destinationName: 'Engine',
    targetProject: 'Project',
    payloadType: PayloadType.PAYLOAD_TYPE_JSON,
  });
  const problem = Header.verify(header);
  if (problem) throw new Error(problem);
  const encoded = Array.from(Header.encode(header).finish(), (byte) => byte.toString(16).padStart(2, '0')).join('');
  let malformedRejected = false;
  try {
    Header.decode(Uint8Array.of(0x80));
  } catch {
    malformedRejected = true;
  }
  const result = {
    decoded, encoded, malformedRejected,
    processKind: ProcessKind.PROCESS_KIND_ELECTRON_RENDERER,
    payloadType: PayloadType.PAYLOAD_TYPE_JSON,
    messageType: MessageType.MESSAGE_TYPE_NONE,
    command: Command.COMMAND_TEST,
    buildProbe: Command.COMMAND_BUILD_PROBE ?? null,
    nodeAvailable: typeof process !== 'undefined',
  };
  const worker = new Worker(new URL('./schema_probe_worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    result.worker = event.data;
    document.getElementById('result').textContent = JSON.stringify(result);
    worker.terminate();
  };
  worker.onerror = (error) => {
    document.getElementById('result').textContent = JSON.stringify({ error: error.message });
    worker.terminate();
  };
} catch (error) {
  document.getElementById('result').textContent = JSON.stringify({ error: error.message });
}
