/* message.js */
import * as path from 'node:path';
import * as protobuf from 'protobufjs';
import type { DecodedHeader, HeaderFields, Prefix, PrefixFields } from '../shared/types';

// A frame is three separate sections:
//   [routing prefix: fixed binary] [Header: protobuf] [payload: opaque bytes]
// Routers read only the prefix. The header is parsed once by the receiving process.
export const PREFIX_VERSION = 1;
export const PREFIX_SIZE = 23;
// Largest allowed prefix length field (header + payload), checked before any buffer is allocated. Matches the Engine.
export const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

// Both main/ and its build output sit one level below Electron/, so the schema is found the same way.
const root = protobuf.loadSync(path.join(__dirname, '..', '..', 'Schemas', 'fray.proto'));
const Header = root.lookupType('fray.Header');

// Enum name -> number objects, generated from the same schema as the engine.
export const ProcessKind = root.lookupEnum('fray.ProcessKind').values;
export const PayloadType = root.lookupEnum('fray.PayloadType').values;
export const MessageType = root.lookupEnum('fray.MessageType').values;
export const Command = root.lookupEnum('fray.Command').values;

const PROCESS_NAMES: Record<number, string> = {
    [ProcessKind.PROCESS_KIND_ENGINE]: 'Engine',
    [ProcessKind.PROCESS_KIND_ENGINE_PLUGIN]: 'Engine Plugin',
    [ProcessKind.PROCESS_KIND_ELECTRON_MAIN]: 'Electron Main',
    [ProcessKind.PROCESS_KIND_ELECTRON_RENDERER]: 'Electron Renderer',
    [ProcessKind.PROCESS_KIND_ELECTRON_PLUGIN]: 'Electron Plugin',
    [ProcessKind.PROCESS_KIND_BROADCAST]: 'Everyone',
};

/** Human-readable name for a ProcessKind, used in headers and logs. */
export function processName(kind: number): string {
    return PROCESS_NAMES[kind] || 'Unknown';
}

/** Encode the 23-byte routing prefix (all integers big-endian). */
export function encodePrefix(p: PrefixFields & { length: number; headerLength: number }): Buffer {
    const buf = Buffer.alloc(PREFIX_SIZE);
    buf.writeUInt8(PREFIX_VERSION, 0);
    buf.writeUInt8(p.destinationKind, 1);
    buf.writeUInt32BE(p.destinationId || 0, 2);
    buf.writeUInt8(p.senderKind, 6);
    buf.writeUInt32BE(p.senderId || 0, 7);
    buf.writeUInt32BE(p.commandId || 0, 11);
    buf.writeUInt32BE(p.length, 15);
    buf.writeUInt32BE(p.headerLength, 19);
    return buf;
}

/**
 * Decode the routing prefix from the start of a buffer.
 * @throws If the buffer is too short, the version is unsupported, or the lengths are inconsistent.
 */
export function decodePrefix(buf: Buffer): Prefix {
    if (buf.length < PREFIX_SIZE) throw new Error('Message is shorter than the routing prefix.');
    const version = buf.readUInt8(0);
    if (version !== PREFIX_VERSION) throw new Error(`Unsupported message prefix version ${version}.`);

    const prefix: Prefix = {
        version,
        destinationKind: buf.readUInt8(1),
        destinationId: buf.readUInt32BE(2),
        senderKind: buf.readUInt8(6),
        senderId: buf.readUInt32BE(7),
        commandId: buf.readUInt32BE(11),
        length: buf.readUInt32BE(15),
        headerLength: buf.readUInt32BE(19),
    };
    if (prefix.headerLength > prefix.length) throw new Error('Message header is longer than the message.');
    if (prefix.length > MAX_FRAME_LENGTH)
        throw new Error(`Message length ${prefix.length} exceeds the maximum of ${MAX_FRAME_LENGTH} bytes.`);
    return prefix;
}

/** Build a full frame. The prefix lengths are filled in. */
export function buildFrame(prefix: PrefixFields, header: HeaderFields, payload: Uint8Array = Buffer.alloc(0)): Buffer {
    const problem = Header.verify(header);
    if (problem) throw new Error(`Invalid message header: ${problem}`);

    const headerBytes = Header.encode(Header.create(header)).finish();
    const payloadBuf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    if (headerBytes.length + payloadBuf.length > MAX_FRAME_LENGTH)
        throw new Error(`Message exceeds the maximum of ${MAX_FRAME_LENGTH} bytes.`);
    return Buffer.concat([
        encodePrefix({ ...prefix, length: headerBytes.length + payloadBuf.length, headerLength: headerBytes.length }),
        headerBytes,
        payloadBuf,
    ]);
}

/** Parse a complete frame. The payload is a view into the frame, not a copy. */
export function parseFrame(frame: Buffer): { prefix: Prefix; header: DecodedHeader; payload: Buffer } {
    const prefix = decodePrefix(frame);
    if (frame.length !== PREFIX_SIZE + prefix.length) throw new Error('Message length does not match its prefix.');

    const headerEnd = PREFIX_SIZE + prefix.headerLength;
    const header = Header.toObject(Header.decode(frame.subarray(PREFIX_SIZE, headerEnd)), { defaults: true, longs: String }) as DecodedHeader;
    return { prefix, header, payload: frame.subarray(headerEnd) };
}
