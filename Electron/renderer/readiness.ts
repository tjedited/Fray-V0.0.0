import { Command, ProcessKind } from './message_schema';
import type { Prefix, ReadinessActions } from '../shared/types';

// What this process currently believes about the other processes. Nothing is assumed about startup order:
// a peer is ready only after it has said so, and it can say so at any time.
export class PeerReadiness {
  private readonly ready = new Set<number>();

  // Returns true only when the peer was not ready before, so callers act once per transition.
  markReady(kind: number): boolean {
    if (this.ready.has(kind)) return false;
    this.ready.add(kind);
    return true;
  }

  markNotReady(kind: number): void {
    this.ready.delete(kind);
  }

  isReady(kind: number): boolean {
    return this.ready.has(kind);
  }
}

// A READY marks the sender ready. A REQUEST_READY is answered with a READY sent back to the sender only,
// so no peer ever has to announce to everyone because someone else asked.
export function handleReadiness(prefix: Prefix, self: number, peers: PeerReadiness,
                                { reply, onPeerReady }: ReadinessActions): void {
  const sender = prefix.senderKind;
  if (sender === self || sender === ProcessKind.PROCESS_KIND_BROADCAST) return;
  if (prefix.commandId === Command.COMMAND_READY) {
    if (peers.markReady(sender)) onPeerReady(sender);
  } else if (prefix.commandId === Command.COMMAND_REQUEST_READY) {
    reply(sender, prefix.senderId);
  }
}
