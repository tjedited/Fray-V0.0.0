import * as message from './message';
import type { FrameOptions } from '../shared/frame_builder';
import type { IncomingMessage } from '../shared/types';

export interface PromptRequest {
  title: string;
  description?: string;
  buttons: { label: string; value: string }[];
  dismissible?: boolean;
}

export type PromptResult = { value: string | null; error?: string };

export function createPromptClient(
  frames: { build(options: FrameOptions): Buffer },
  send: (frame: Buffer) => void,
): {
  request: (prompt: PromptRequest, callback: (result: PromptResult) => void) => void;
  onMessage: (incoming: IncomingMessage<Buffer>) => boolean;
  cancel: (reason?: string) => void;
} {
  const pending = new Map<string, { prompt: PromptRequest; callback: (result: PromptResult) => void }>();
  return {
    request(prompt, callback) {
      if (!prompt.title.trim() || !prompt.buttons.length || prompt.buttons.some((button) => !button.label.trim()))
        throw new Error('Prompt requires a title and labeled buttons.');
      const payload = message.PromptRequest.encode(message.PromptRequest.fromObject(prompt)).finish();
      const frame = frames.build({
        destination: message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER,
        command: message.Command.COMMAND_PROMPT_REQUEST,
        payload, payloadType: message.PayloadType.PAYLOAD_TYPE_PROTOBUF,
        messageType: message.MessageType.MESSAGE_TYPE_PROMPT_REQUEST,
      });
      const id = message.parseFrame(frame).header.messageId;
      pending.set(id, { prompt, callback });
      try {
        send(frame);
      } catch (error) {
        pending.delete(id);
        throw error;
      }
    },
    onMessage({ prefix, header, payload }) {
      if (prefix.commandId !== message.Command.COMMAND_PROMPT_RESPONSE) return false;
      if (prefix.senderKind !== message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER ||
          prefix.senderId !== 0 || header.payloadType !== message.PayloadType.PAYLOAD_TYPE_PROTOBUF ||
          header.messageType !== message.MessageType.MESSAGE_TYPE_PROMPT_RESPONSE)
        throw new Error('Invalid prompt response format or sender.');
      const response = message.PromptResponse.toObject(message.PromptResponse.decode(payload), { defaults: true, longs: String });
      const id = String(response.requestId);
      const request = pending.get(id);
      if (!request) throw new Error('Unknown prompt response.');
      if (!response.error && (response.dismissed
        ? request.prompt.dismissible === false
        : !request.prompt.buttons.some((button) => button.value === response.value)))
        throw new Error('Prompt response is not an allowed choice.');
      pending.delete(id);
      request.callback(response.error ? { value: null, error: response.error } :
        { value: response.dismissed ? null : response.value });
      return true;
    },
    cancel(reason = 'Application is shutting down.') {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const { callback } of callbacks) callback({ value: null, error: reason });
    },
  };
}
