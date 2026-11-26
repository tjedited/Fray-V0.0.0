"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const message = require("./message.js");
class PeerReadiness {
  constructor() {
    this.ready = /* @__PURE__ */ new Set();
  }
  /** Returns true only when the peer was not ready before, so callers act once per transition. */
  markReady(kind) {
    if (this.ready.has(kind)) return false;
    this.ready.add(kind);
    return true;
  }
  markNotReady(kind) {
    this.ready.delete(kind);
  }
  isReady(kind) {
    return this.ready.has(kind);
  }
}
function handleReadiness(prefix, self, peers, { reply, onPeerReady }) {
  const sender = prefix.senderKind;
  if (sender === self || sender === message.ProcessKind.PROCESS_KIND_BROADCAST) return;
  if (prefix.commandId === message.Command.COMMAND_READY) {
    if (peers.markReady(sender)) onPeerReady(sender);
  } else if (prefix.commandId === message.Command.COMMAND_REQUEST_READY) {
    reply(sender, prefix.senderId);
  }
}
exports.PeerReadiness = PeerReadiness;
exports.handleReadiness = handleReadiness;
//# sourceMappingURL=readiness.js.map
