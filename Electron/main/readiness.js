/* readiness.js */
const { ProcessKind, Command } = require('./message');

/**
 * What this process currently believes about the other processes. Nothing is assumed about startup order:
 * a peer is ready only after it has said so, and it can say so at any time.
 */
class PeerReadiness {
    constructor() {
        this.ready = new Set();
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

/**
 * A READY marks the sender ready. A REQUEST_READY is answered with a READY sent back to the sender only,
 * so no peer ever has to announce to everyone because someone else asked.
 * @param {object} prefix The routing prefix of a received frame.
 * @param {number} self The ProcessKind of this process.
 * @param {PeerReadiness} peers
 * @param {{reply: function(number, number): void, onPeerReady: function(number): void}} actions
 */
function handleReadiness(prefix, self, peers, { reply, onPeerReady }) {
    const sender = prefix.senderKind;
    if (sender === self || sender === ProcessKind.PROCESS_KIND_BROADCAST) return;
    if (prefix.commandId === Command.COMMAND_READY) {
        if (peers.markReady(sender)) onPeerReady(sender);
    } else if (prefix.commandId === Command.COMMAND_REQUEST_READY) {
        reply(sender, prefix.senderId);
    }
}

module.exports = { PeerReadiness, handleReadiness };
