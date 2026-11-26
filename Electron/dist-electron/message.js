"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const path = require("node:path");
const protobuf = require("protobufjs");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const protobuf__namespace = /* @__PURE__ */ _interopNamespaceDefault(protobuf);
const PREFIX_VERSION = 1;
const PREFIX_SIZE = 23;
const MAX_FRAME_LENGTH = 16 * 1024 * 1024;
const root = protobuf__namespace.loadSync(path__namespace.join(__dirname, "..", "..", "Schemas", "fray.proto"));
const Header = root.lookupType("fray.Header");
const HealthReport = root.lookupType("fray.HealthReport");
const ProcessKind = root.lookupEnum("fray.ProcessKind").values;
const PayloadType = root.lookupEnum("fray.PayloadType").values;
const MessageType = root.lookupEnum("fray.MessageType").values;
const Command = root.lookupEnum("fray.Command").values;
const PROCESS_NAMES = {
  [ProcessKind.PROCESS_KIND_ENGINE]: "Engine",
  [ProcessKind.PROCESS_KIND_ENGINE_PLUGIN]: "Engine Plugin",
  [ProcessKind.PROCESS_KIND_ELECTRON_MAIN]: "Electron Main",
  [ProcessKind.PROCESS_KIND_ELECTRON_RENDERER]: "Electron Renderer",
  [ProcessKind.PROCESS_KIND_ELECTRON_PLUGIN]: "Electron Plugin",
  [ProcessKind.PROCESS_KIND_BROADCAST]: "Everyone"
};
function processName(kind) {
  return PROCESS_NAMES[kind] || "Unknown";
}
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
function decodePrefix(buf) {
  if (buf.length < PREFIX_SIZE) throw new Error("Message is shorter than the routing prefix.");
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
    headerLength: buf.readUInt32BE(19)
  };
  if (prefix.headerLength > prefix.length) throw new Error("Message header is longer than the message.");
  if (prefix.length > MAX_FRAME_LENGTH)
    throw new Error(`Message length ${prefix.length} exceeds the maximum of ${MAX_FRAME_LENGTH} bytes.`);
  return prefix;
}
function buildFrame(prefix, header, payload = Buffer.alloc(0)) {
  const problem = Header.verify(header);
  if (problem) throw new Error(`Invalid message header: ${problem}`);
  const headerBytes = Header.encode(Header.create(header)).finish();
  const payloadBuf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  if (headerBytes.length + payloadBuf.length > MAX_FRAME_LENGTH)
    throw new Error(`Message exceeds the maximum of ${MAX_FRAME_LENGTH} bytes.`);
  return Buffer.concat([
    encodePrefix({ ...prefix, length: headerBytes.length + payloadBuf.length, headerLength: headerBytes.length }),
    headerBytes,
    payloadBuf
  ]);
}
function parseFrame(frame) {
  const prefix = decodePrefix(frame);
  if (frame.length !== PREFIX_SIZE + prefix.length) throw new Error("Message length does not match its prefix.");
  const headerEnd = PREFIX_SIZE + prefix.headerLength;
  const header = Header.toObject(Header.decode(frame.subarray(PREFIX_SIZE, headerEnd)), { defaults: true, longs: String });
  return { prefix, header, payload: frame.subarray(headerEnd) };
}
exports.Command = Command;
exports.HealthReport = HealthReport;
exports.MAX_FRAME_LENGTH = MAX_FRAME_LENGTH;
exports.MessageType = MessageType;
exports.PREFIX_SIZE = PREFIX_SIZE;
exports.PREFIX_VERSION = PREFIX_VERSION;
exports.PayloadType = PayloadType;
exports.ProcessKind = ProcessKind;
exports.buildFrame = buildFrame;
exports.decodePrefix = decodePrefix;
exports.encodePrefix = encodePrefix;
exports.parseFrame = parseFrame;
exports.processName = processName;
//# sourceMappingURL=message.js.map
