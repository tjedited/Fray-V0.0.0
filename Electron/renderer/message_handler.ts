import { buildFrame, Command, MessageType, parseFrame, PayloadType, processName, ProcessKind } from './message';
import { ProjectOpenRequest, ProjectOpenResult, ProjectCreateRequest, ProjectCreateResult,
  ProjectCloseRequest, ProjectCloseResult, PromptRequest, PromptResponse } from './message_schema';
import { createFrameBuilder } from '../shared/frame_builder';
import type { IncomingMessage } from '../shared/types';
import type { PromptOptions } from './prompts';

const SELF = ProcessKind.PROCESS_KIND_ELECTRON_RENDERER;

export interface ProjectCreateReply {
  path: string;
  status: number;
  error: string;
}

export interface ProjectCloseReply {
  name: string;
  success: boolean;
  packaged: boolean;
  error: string;
}

export function createMessageHandler(
  send: (frame: Uint8Array) => void,
  setStatus: (status: string) => void,
  showPrompt?: (options: PromptOptions) => void,
): {
  submitProject: (input: string) => void;
  createProject: (path: string, choice: number, onResult: (result: ProjectCreateReply) => void) => void;
  closeProject: (packageProject: boolean, onResult: (result: ProjectCloseReply) => void, targetProject?: string) => void;
  requestPrompt: (options: Omit<PromptOptions, 'onResponse'>, callback: (value: string | null, error?: string) => void) => void;
  onMessage: (incoming: IncomingMessage<Uint8Array>) => void;
  onReady: () => void;
  onPeerReady: (kind: number) => void;
  cancelPending: (reason: string) => void;
} {
  const frames = createFrameBuilder(SELF, 1, buildFrame, processName);
  let latestRequestId = '';
  const projectRequests = new Map<string, { path: string; onResult: (result: ProjectCreateReply) => void }>();
  const closeRequests = new Map<string, (result: ProjectCloseReply) => void>();
  const promptRequests = new Map<string, {
    options: Omit<PromptOptions, 'onResponse'>;
    callback: (value: string | null, error?: string) => void;
  }>();
  let mainReady = false;

  function announceReady(): void {
    send(frames.build({ command: Command.COMMAND_READY, destination: ProcessKind.PROCESS_KIND_BROADCAST }));
    send(frames.build({ command: Command.COMMAND_REQUEST_READY, destination: ProcessKind.PROCESS_KIND_BROADCAST }));
  }

  return {
    cancelPending(reason) {
      const prompts = [...promptRequests.values()];
      const projects = [...projectRequests.values()];
      const closes = [...closeRequests.values()];
      promptRequests.clear();
      projectRequests.clear();
      closeRequests.clear();
      for (const { callback } of prompts) callback(null, reason);
      for (const { path, onResult } of projects) onResult({ path, status: 0, error: reason });
      for (const onResult of closes) onResult({ name: '', success: false, packaged: false, error: reason });
    },
    closeProject(packageProject, onResult, targetProject) {
      const payload = ProjectCloseRequest.encode(ProjectCloseRequest.fromObject({ package: packageProject })).finish();
      const frame = frames.build({
        destination: ProcessKind.PROCESS_KIND_ENGINE, command: Command.COMMAND_CLOSE_PROJECT,
        targetProject, payload, payloadType: PayloadType.PAYLOAD_TYPE_PROTOBUF,
        messageType: MessageType.MESSAGE_TYPE_PROJECT_CLOSE_REQUEST,
      });
      const id = parseFrame(frame).header.messageId;
      closeRequests.set(id, onResult);
      try {
        send(frame);
      } catch (error) {
        closeRequests.delete(id);
        throw error;
      }
    },
    requestPrompt(options, callback) {
      if (!options.title.trim() || !options.buttons.length || options.buttons.some((button) => !button.label.trim()))
        throw new Error('Prompt requires a title and labeled buttons.');
      const request = { ...options, description: options.description ?? '' };
      const payload = PromptRequest.encode(PromptRequest.fromObject(request)).finish();
      const frame = frames.build({
        destination: SELF, command: Command.COMMAND_PROMPT_REQUEST,
        payload, payloadType: PayloadType.PAYLOAD_TYPE_PROTOBUF, messageType: MessageType.MESSAGE_TYPE_PROMPT_REQUEST,
      });
      const id = parseFrame(frame).header.messageId;
      promptRequests.set(id, { options, callback });
      try {
        send(frame);
      } catch (error) {
        promptRequests.delete(id);
        throw error;
      }
    },
    createProject(path, choice, onResult) {
      const payload = ProjectCreateRequest.encode(ProjectCreateRequest.fromObject({ path, choice })).finish();
      const frame = frames.build({
        destination: ProcessKind.PROCESS_KIND_ENGINE, command: Command.COMMAND_CREATE_PROJECT,
        payload, payloadType: PayloadType.PAYLOAD_TYPE_PROTOBUF,
        messageType: MessageType.MESSAGE_TYPE_PROJECT_CREATE_REQUEST,
      });
      const id = parseFrame(frame).header.messageId;
      projectRequests.set(id, { path, onResult });
      try {
        send(frame);
      } catch (error) {
        projectRequests.delete(id);
        throw error;
      }
    },
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
      if (prefix.commandId === Command.COMMAND_PROMPT_REQUEST) {
        const reply = (value: string | null, error = '') => {
          const response = PromptResponse.encode(PromptResponse.fromObject({
            requestId: header.messageId, dismissed: value === null, value: value ?? '', error,
          })).finish();
          send(frames.build({
            destination: prefix.senderKind, destinationId: prefix.senderId, command: Command.COMMAND_PROMPT_RESPONSE,
            payload: response, payloadType: PayloadType.PAYLOAD_TYPE_PROTOBUF,
            messageType: MessageType.MESSAGE_TYPE_PROMPT_RESPONSE,
          }));
        };
        try {
          if (prefix.destinationKind !== SELF ||
              (prefix.senderKind !== ProcessKind.PROCESS_KIND_ENGINE &&
               prefix.senderKind !== ProcessKind.PROCESS_KIND_ELECTRON_MAIN && prefix.senderKind !== SELF) ||
              header.payloadType !== PayloadType.PAYLOAD_TYPE_PROTOBUF ||
              header.messageType !== MessageType.MESSAGE_TYPE_PROMPT_REQUEST)
            throw new Error('Invalid prompt request format or sender.');
          if (!showPrompt) throw new Error('Prompt UI is unavailable.');
          const request = PromptRequest.decode(payload);
          if (!request.title.trim() || !request.buttons.length ||
              request.buttons.some((button) => !button.label.trim()))
            throw new Error('Prompt requires a title and labeled buttons.');
          showPrompt({
            title: request.title,
            description: request.description || undefined,
            buttons: request.buttons,
            dismissible: Object.hasOwn(request, 'dismissible') ? request.dismissible : true,
            onResponse: (value) => reply(value),
          });
        } catch (error) {
          const message = `Cannot show prompt: ${(error as Error).message}`;
          console.error(message);
          if (prefix.senderKind === ProcessKind.PROCESS_KIND_ENGINE ||
              prefix.senderKind === ProcessKind.PROCESS_KIND_ELECTRON_MAIN || prefix.senderKind === SELF) reply(null, message);
        }
      }
      if (prefix.commandId === Command.COMMAND_PROMPT_RESPONSE && prefix.senderKind === SELF) {
        try {
          if (prefix.destinationKind !== SELF || prefix.senderId !== 0 ||
              header.payloadType !== PayloadType.PAYLOAD_TYPE_PROTOBUF ||
              header.messageType !== MessageType.MESSAGE_TYPE_PROMPT_RESPONSE)
            throw new Error('Invalid prompt response format or sender.');
          const response = PromptResponse.decode(payload);
          const id = String(response.requestId);
          const request = promptRequests.get(id);
          if (!request) throw new Error('Unknown prompt response.');
          if (!response.error && (response.dismissed
            ? request.options.dismissible === false
            : !request.options.buttons.some((button) => button.value === response.value)))
            throw new Error('Prompt response is not an allowed choice.');
          promptRequests.delete(id);
          request.callback(response.dismissed ? null : response.value, response.error || undefined);
        } catch (error) {
          console.error(`Cannot handle prompt response: ${(error as Error).message}`);
        }
      }
      if (prefix.commandId === Command.COMMAND_PROJECT_CREATE_RESULT && prefix.senderKind === ProcessKind.PROCESS_KIND_ENGINE) {
        try {
          if (header.payloadType !== PayloadType.PAYLOAD_TYPE_PROTOBUF ||
              header.messageType !== MessageType.MESSAGE_TYPE_PROJECT_CREATE_RESULT)
            throw new Error('Unexpected project creation result format.');
          const result = ProjectCreateResult.decode(payload);
          const id = String(result.requestId);
          const pending = projectRequests.get(id);
          if (!pending) throw new Error('Unknown project creation request.');
          projectRequests.delete(id);
          if (result.path !== pending.path) {
            pending.onResult({ path: pending.path, status: 0, error: 'Project result path does not match the request.' });
          } else {
            pending.onResult({ path: result.path, status: result.status, error: result.error });
          }
        } catch (error) {
          const status = `Invalid project creation result: ${(error as Error).message}`;
          console.error(status);
          setStatus(status);
        }
      }
      if (prefix.commandId === Command.COMMAND_PROJECT_CLOSE_RESULT && prefix.senderKind === ProcessKind.PROCESS_KIND_ENGINE) {
        try {
          if (header.payloadType !== PayloadType.PAYLOAD_TYPE_PROTOBUF ||
              header.messageType !== MessageType.MESSAGE_TYPE_PROJECT_CLOSE_RESULT)
            throw new Error('Unexpected project close result format.');
          const result = ProjectCloseResult.decode(payload);
          const id = String(result.requestId);
          const onResult = closeRequests.get(id);
          if (!onResult) throw new Error('Unknown project close request.');
          closeRequests.delete(id);
          onResult({ name: result.name, success: result.success, packaged: result.packaged, error: result.error });
        } catch (error) {
          const status = `Invalid project close result: ${(error as Error).message}`;
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
