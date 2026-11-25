/* message.js */
const path = require('path');
const protobuf = require('protobufjs');

// A frame is three separate sections:
//   [routing prefix: fixed binary] [Header: protobuf] [payload: opaque bytes]
// Routers read only the prefix. The header is parsed once by the receiving process.
const PREFIX_VERSION = 1;
const PREFIX_SIZE = 23;

const root = protobuf.loadSync(path.join(__dirname, '..', '..', 'Schemas', 'fray.proto'));
const Header = root.lookupType('fray.Header');

// Enum name -> number objects, generated from the same schema as the engine.
const ProcessKind = root.lookupEnum('fray.ProcessKind').values;
const PayloadType = root.lookupEnum('fray.PayloadType').values;
const MessageType = root.lookupEnum('fray.MessageType').values;
const Command = root.lookupEnum('fray.Command').values;

const PROCESS_NAMES = {
    [ProcessKind.PROCESS_KIND_ENGINE]: 'Engine',
    [ProcessKind.PROCESS_KIND_ENGINE_PLUGIN]: 'Engine Plugin',
    [ProcessKind.PROCESS_KIND_ELECTRON_MAIN]: 'Electron Main',
    [ProcessKind.PROCESS_KIND_ELECTRON_RENDERER]: 'Electron Renderer',
    [ProcessKind.PROCESS_KIND_ELECTRON_PLUGIN]: 'Electron Plugin',
    [ProcessKind.PROCESS_KIND_BROADCAST]: 'Everyone',
};

/** Human-readable name for a ProcessKind, used in headers and logs. */
function processName(kind) {
    return PROCESS_NAMES[kind] || 'Unknown';
}

/**
 * Encode the 23-byte routing prefix (all integers big-endian).
 * @param {object} p
 * @param {number} p.destinationKind
 * @param {number} [p.destinationId=0] 0 = default or broadcast.
 * @param {number} p.senderKind
 * @param {number} [p.senderId=0]
 * @param {number} [p.commandId=0] 0 = none.
 * @param {number} p.length Bytes after the prefix (header + payload).
 * @param {number} p.headerLength Bytes of the protobuf header.
 * @returns {Buffer}
 */
function encodePrefix(p) {
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
 * @param {Buffer} buf
 * @returns {object} The prefix fields.
 * @throws If the buffer is too short, the version is unsupported, or the lengths are inconsistent.
 */
function decodePrefix(buf) {
    if (buf.length < PREFIX_SIZE) throw new Error('Message is shorter than the routing prefix.');
    const version = buf.readUInt8(0);
    if (version !== PREFIX_VERSION) throw new Error(`Unsupported message prefix version ${version}.`);

    const prefix = {
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
    return prefix;
}

/**
 * Build a full frame.
 * @param {object} prefix Routing fields; length and headerLength are filled in.
 * @param {object} header Fields of fray.Header (camelCase).
 * @param {Buffer|Uint8Array} [payload] Opaque payload bytes.
 * @returns {Buffer}
 */
function buildFrame(prefix, header, payload = Buffer.alloc(0)) {
    const problem = Header.verify(header);
    if (problem) throw new Error(`Invalid message header: ${problem}`);

    const headerBytes = Header.encode(Header.create(header)).finish();
    const payloadBuf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    return Buffer.concat([
        encodePrefix({ ...prefix, length: headerBytes.length + payloadBuf.length, headerLength: headerBytes.length }),
        headerBytes,
        payloadBuf,
    ]);
}

/**
 * Parse a complete frame. The payload is a view into the frame, not a copy.
 * @param {Buffer} frame
 * @returns {{prefix: object, header: object, payload: Buffer}} The in_data for handlers.
 */
function parseFrame(frame) {
    const prefix = decodePrefix(frame);
    if (frame.length !== PREFIX_SIZE + prefix.length) throw new Error('Message length does not match its prefix.');

    const headerEnd = PREFIX_SIZE + prefix.headerLength;
    const header = Header.toObject(Header.decode(frame.subarray(PREFIX_SIZE, headerEnd)), { defaults: true, longs: String });
    return { prefix, header, payload: frame.subarray(headerEnd) };
}

module.exports = {
    PREFIX_VERSION,
    PREFIX_SIZE,
    ProcessKind,
    PayloadType,
    MessageType,
    Command,
    processName,
    encodePrefix,
    decodePrefix,
    buildFrame,
    parseFrame,
};
