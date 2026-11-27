import * as log from './log_manager';
import * as message from './message';
import type { FrameOptions } from '../shared/frame_builder';
import type { IncomingMessage } from '../shared/types';
import { createPromptClient, type PromptRequest, type PromptResult } from './prompt_client';

const SELF = message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN;

export function createMessageHandler(
  frames: { build(options: FrameOptions): Buffer },
  send: (frame: Buffer) => void,
  isConnected: () => boolean,
  sendPrompt: (frame: Buffer) => void = send,
): {
  announceReady: () => void;
  onPeerReady: (kind: number) => void;
  onMessage: (incoming: IncomingMessage<Buffer>) => void;
  requestPrompt: (prompt: PromptRequest, callback: (result: PromptResult) => void) => void;
  cancelPrompts: (reason?: string) => void;
} {
  const prompts = createPromptClient(frames, sendPrompt);
  return {
    requestPrompt(prompt, callback) {
      if (!isConnected()) throw new Error('Cannot request a prompt: Engine connection is unavailable.');
      prompts.request(prompt, callback);
    },
    cancelPrompts: prompts.cancel,
    announceReady() {
      send(frames.build({ command: message.Command.COMMAND_READY, destination: message.ProcessKind.PROCESS_KIND_BROADCAST }));
      send(frames.build({ command: message.Command.COMMAND_REQUEST_READY, destination: message.ProcessKind.PROCESS_KIND_BROADCAST }));
    },
    onPeerReady(kind) {
      log.electronInfo('%s is ready.', message.processName(kind));
      if (isConnected()) send(frames.build({ command: message.Command.COMMAND_READY, destination: kind }));
    },
    onMessage({ prefix, header, payload }) {
      try {
        if (prompts.onMessage({ prefix, header, payload })) return;
      } catch (error) {
        log.electronError('Cannot handle prompt response: %s', (error as Error).message);
        return;
      }
      if (prefix.commandId !== message.Command.COMMAND_PING && prefix.commandId !== message.Command.COMMAND_PONG)
        log.electronInfo('Received frame: command=%d sender=%s destination=%s protocol=%d message_id=%s timestamp=%s flags=%d payload_type=%d message_type=%d payload_bytes=%d frame_bytes=%d.',
          prefix.commandId, header.senderName, header.destinationName, header.protocolVersion, header.messageId,
          header.timestamp, header.flags, header.payloadType, header.messageType, payload.length,
          message.PREFIX_SIZE + prefix.length);
      const sender = prefix.senderKind;
      if (prefix.commandId === message.Command.COMMAND_REQUEST_READY && sender !== SELF &&
          sender !== message.ProcessKind.PROCESS_KIND_BROADCAST && isConnected())
        send(frames.build({ command: message.Command.COMMAND_READY, destination: sender, destinationId: prefix.senderId }));
    },
  };
}
