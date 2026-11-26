import { Header, ProcessKind, PayloadType, MessageType, Command } from './message_schema';

import type { DecodedHeader, HeaderFields, Prefix, PrefixFields } from '../shared/types';

export { ProcessKind, PayloadType, MessageType, Command };
export const PREFIX_VERSION = 1;
export const PREFIX_SIZE = 23;
// Largest allowed prefix length field (header + payload). Matches the Engine and Electron Main.
export const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

const PROCESS_NAMES: Record<number, string> = {
  [ProcessKind.PROCESS_KIND_ENGINE]: 'Engine',
  [ProcessKind.PROCESS_KIND_ENGINE_PLUGIN]: 'Engine Plugin',
  [ProcessKind.PROCESS_KIND_ELECTRON_MAIN]: 'Electron Main',
  [ProcessKind.PROCESS_KIND_ELECTRON_RENDERER]: 'Electron Renderer',
  [ProcessKind.PROCESS_KIND_ELECTRON_PLUGIN]: 'Electron Plugin',
  [ProcessKind.PROCESS_KIND_BROADCAST]: 'Everyone',
};

// Human-readable name for a ProcessKind, used in headers and logs.
export function processName(kind: number): string {
  return PROCESS_NAMES[kind] || 'Unknown';
}

export function decodePrefix(bytes: Uint8Array): Prefix {
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < PREFIX_SIZE) throw new Error('Message is shorter than the routing prefix.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint8(0);
  if (version !== PREFIX_VERSION) throw new Error(`Unsupported message prefix version ${version}.`);
  const prefix: Prefix = {
    version,
    destinationKind: view.getUint8(1),
    destinationId: view.getUint32(2),
    senderKind: view.getUint8(6),
    senderId: view.getUint32(7),
    commandId: view.getUint32(11),
    length: view.getUint32(15),
    headerLength: view.getUint32(19),
  };
  if (prefix.headerLength > prefix.length) throw new Error('Message header is longer than the message.');
  if (prefix.length > MAX_FRAME_LENGTH)
    throw new Error(`Message length ${prefix.length} exceeds the maximum of ${MAX_FRAME_LENGTH} bytes.`);
  return prefix;
}

export function buildFrame(prefix: PrefixFields, header: HeaderFields, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const value = Header.fromObject(header);
  const problem = Header.verify(value);
  if (problem) throw new Error(`Invalid message header: ${problem}`);
  const headerBytes = Header.encode(value).finish();
  if (headerBytes.length + payload.length > MAX_FRAME_LENGTH)
    throw new Error(`Message exceeds the maximum of ${MAX_FRAME_LENGTH} bytes.`);
  const frame = new Uint8Array(PREFIX_SIZE + headerBytes.length + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint8(0, PREFIX_VERSION);
  view.setUint8(1, prefix.destinationKind);
  view.setUint32(2, prefix.destinationId || 0);
  view.setUint8(6, prefix.senderKind);
  view.setUint32(7, prefix.senderId || 0);
  view.setUint32(11, prefix.commandId || 0);
  view.setUint32(15, headerBytes.length + payload.length);
  view.setUint32(19, headerBytes.length);
  frame.set(headerBytes, PREFIX_SIZE);
  frame.set(payload, PREFIX_SIZE + headerBytes.length);
  return frame;
}

export function parseFrame(frame: Uint8Array): { prefix: Prefix; header: DecodedHeader; payload: Uint8Array } {
  const prefix = decodePrefix(frame);
  if (frame.length !== PREFIX_SIZE + prefix.length) throw new Error('Message length does not match its prefix.');
  const headerEnd = PREFIX_SIZE + prefix.headerLength;
  const header = Header.toObject(Header.decode(frame.subarray(PREFIX_SIZE, headerEnd)), { defaults: true, longs: String }) as DecodedHeader;
  return { prefix, header, payload: frame.subarray(headerEnd) };
}
