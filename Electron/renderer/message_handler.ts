import { buildFrame, Command, MessageType, parseFrame, PayloadType, processName, ProcessKind } from './message';
import { ProjectOpenRequest, ProjectOpenResult } from './message_schema';
import { createFrameBuilder } from '../shared/frame_builder';
import type { IncomingMessage } from '../shared/types';

const SELF = ProcessKind.PROCESS_KIND_ELECTRON_RENDERER;

export function createMessageHandler(
  send: (frame: Uint8Array) => void,
  setStatus: (status: string) => void,
): {
  submitProject: (input: string) => void;
  onMessage: (incoming: IncomingMessage<Uint8Array>) => void;
  onReady: () => void;
  onPeerReady: (kind: number) => void;
} {
  const frames = createFrameBuilder(SELF, 1, buildFrame, processName);
  let latestRequestId = '';
  let mainReady = false;

  function announceReady(): void {
    send(frames.build({ command: Command.COMMAND_READY, destination: ProcessKind.PROCESS_KIND_BROADCAST }));
    send(frames.build({ command: Command.COMMAND_REQUEST_READY, destination: ProcessKind.PROCESS_KIND_BROADCAST }));
  }

  return {
    submitProject(input) {
      const name = input.trim();
      if (!name) {
        setStatus('Enter a project name.');
        return;
      }
      let status: string;
      try {
        const payload = ProjectOpenRequest.encode(ProjectOpenRequest.fromObject({ name })).finish();
        const frame = frames.build({
          destination: ProcessKind.PROCESS_KIND_ENGINE, command: Command.COMMAND_OPEN_PROJECT,
          payload, payloadType: PayloadType.PAYLOAD_TYPE_PROTOBUF,
          messageType: MessageType.MESSAGE_TYPE_PROJECT_OPEN_REQUEST,
        });
        latestRequestId = parseFrame(frame).header.messageId;
        send(frame);
        status = `Requested project: ${name}`;
      } catch (error) {
        status = `Could not send request: ${(error as Error).message}`;
      }
      setStatus(status);
    },
    onMessage({ prefix, header, payload }) {
      if (prefix.commandId !== Command.COMMAND_PING && prefix.commandId !== Command.COMMAND_PONG)
        console.info(`Renderer received frame: command=${prefix.commandId} message_id=${header.messageId} payload_bytes=${payload.length} sender=${header.senderName}.`);
      if (prefix.commandId === Command.COMMAND_PROJECT_OPEN_RESULT && prefix.senderKind === ProcessKind.PROCESS_KIND_ENGINE) {
        try {
          if (header.payloadType !== PayloadType.PAYLOAD_TYPE_PROTOBUF ||
              header.messageType !== MessageType.MESSAGE_TYPE_PROJECT_OPEN_RESULT)
            throw new Error('Unexpected project result format.');
          const result = ProjectOpenResult.decode(payload);
          if (String(result.requestId) === latestRequestId)
            setStatus(result.success ? `Project opened: ${result.name}` : result.error || 'Could not open project.');
        } catch (error) {
          const status = `Invalid project result: ${(error as Error).message}`;
          console.error(status);
          setStatus(status);
        }
      }
      const sender = prefix.senderKind;
      if (prefix.commandId === Command.COMMAND_REQUEST_READY && sender !== SELF && sender !== ProcessKind.PROCESS_KIND_BROADCAST)
        send(frames.build({ command: Command.COMMAND_READY, destination: sender, destinationId: prefix.senderId }));
    },
    onReady() {
      send(frames.build({ command: Command.COMMAND_REQUEST_READY, destination: ProcessKind.PROCESS_KIND_ELECTRON_MAIN }));
    },
    onPeerReady(kind) {
      console.info(`${processName(kind)} is ready.`);
      if (kind === ProcessKind.PROCESS_KIND_ELECTRON_MAIN) {
        mainReady = true;
        announceReady();
      } else if (mainReady) {
        send(frames.build({ command: Command.COMMAND_READY, destination: kind }));
      }
    },
  };
}
