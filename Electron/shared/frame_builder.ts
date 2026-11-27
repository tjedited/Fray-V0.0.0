import type { HeaderFields, PrefixFields } from './types';

export interface FrameOptions {
  destination: number;
  command: number;
  destinationId?: number;
  payload?: Uint8Array;
  payloadType?: number;
  messageType?: number;
  targetProject?: string;
  ttlMs?: number;
}

const nextMessageIds = new Map<string, number>();

export function createFrameBuilder<T extends Uint8Array>(
  sender: number,
  firstMessageId: 1 | 2,
  encode: (prefix: PrefixFields, header: HeaderFields, payload: Uint8Array) => T,
  processName: (kind: number) => string,
): { build(options: FrameOptions): T } {
  const sequence = `${sender}:${firstMessageId}`;

  return {
    build(options) {
      const { destination, command, destinationId = 0, payload = new Uint8Array(),
        payloadType = 0, messageType = 0, targetProject, ttlMs = 0 } = options;
      for (const [name, value, max] of [
        ['destination', destination, 255],
        ['command', command, 0xffffffff],
        ['destinationId', destinationId, 0xffffffff],
        ['ttlMs', ttlMs, 0xffffffff],
        ['payloadType', payloadType, 0x7fffffff],
        ['messageType', messageType, 0x7fffffff],
      ] as const) {
        if (!Number.isInteger(value) || value < 0 || value > max)
          throw new RangeError(`Invalid ${name}: ${value}.`);
      }
      if (payload.length && payloadType === 0)
        throw new Error('A nonempty payload requires an explicit payload type.');
      const nextMessageId = nextMessageIds.get(sequence) ?? firstMessageId;
      if (!Number.isSafeInteger(nextMessageId))
        throw new RangeError('Message ID sequence exhausted.');

      const frame = encode(
        { destinationKind: destination, destinationId, senderKind: sender, commandId: command },
        { protocolVersion: 1, messageId: nextMessageId, timestamp: Date.now(),
          senderName: processName(sender), destinationName: processName(destination),
          payloadType, messageType, targetProject, ttlMs },
        payload,
      );
      nextMessageIds.set(sequence, nextMessageId + 2);
      return frame;
    },
  };
}
