import { dialog, type BrowserWindow, type IpcMainEvent } from 'electron';
import * as path from 'node:path';
import { lstat } from 'node:fs/promises';
import * as log from './log_manager';
import * as message from './message';
import type { FrameOptions } from '../shared/frame_builder';
import type { IncomingMessage, ProjectSelection, PromptResult } from '../shared/types';

const SELF = message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN;

export interface PromptRequest {
  title: string;
  description?: string;
  buttons: { label: string; value: string }[];
  dismissible?: boolean;
}

export function createPromptClient(
  frames: { build(options: FrameOptions): Buffer },
  send: (frame: Buffer) => void,
): {
  request: (prompt: PromptRequest) => string;
  takeResult: (requestId: string) => PromptResult | undefined;
  onMessage: (incoming: IncomingMessage<Buffer>) => boolean;
  cancel: (reason?: string) => void;
} {
  const pending = new Map<string, { prompt: PromptRequest; result?: PromptResult }>();
  return {
    request(prompt) {
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
      pending.set(id, { prompt });
      try {
        send(frame);
      } catch (error) {
        pending.delete(id);
        throw error;
      }
      return id;
    },
    takeResult(requestId) {
      const request = pending.get(requestId);
      if (!request?.result) return undefined;
      pending.delete(requestId);
      return request.result;
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
      if (!request || request.result) throw new Error('Unknown prompt response.');
      if (!response.error && (response.dismissed
        ? request.prompt.dismissible === false
        : !request.prompt.buttons.some((button) => button.value === response.value)))
        throw new Error('Prompt response is not an allowed choice.');
      request.result = response.error ? { value: null, error: response.error } :
        { value: response.dismissed ? null : response.value };
      return true;
    },
    cancel(reason = 'Application is shutting down.') {
      for (const request of pending.values())
        if (!request.result) request.result = { value: null, error: reason };
    },
  };
}

export function createMessageHandler(
  frames: { build(options: FrameOptions): Buffer },
  send: (frame: Buffer) => void,
  sendPrompt: (frame: Buffer) => void = send,
  getWindow: () => BrowserWindow | null = () => null,
  isShuttingDown: () => boolean = () => false,
): {
  announceReady: () => void;
  onPeerReady: (kind: number) => void;
  onMessage: (incoming: IncomingMessage<Buffer>) => void;
  requestPrompt: (prompt: PromptRequest) => string;
  takePromptResult: (requestId: string) => PromptResult | undefined;
  cancelPrompts: (reason?: string) => void;
  onChooseNewProjectPath: (event: IpcMainEvent, previousPath: unknown) => void;
  onChooseOpenProjectPath: (event: IpcMainEvent, kind: unknown) => void;
} {
  const prompts = createPromptClient(frames, sendPrompt);
  return {
    requestPrompt(prompt) {
      return prompts.request(prompt);
    },
    takePromptResult: prompts.takeResult,
    cancelPrompts: prompts.cancel,
    onChooseNewProjectPath(event, previousPath) {
      const win = getWindow();
      if (!win || win.isDestroyed() || event.sender !== win.webContents || isShuttingDown())
        return log.electronError('Cannot choose a project path from this renderer.');
      const choose = async (): Promise<string | null> => {
        if (previousPath !== undefined &&
            (typeof previousPath !== 'string' || !path.isAbsolute(previousPath) || previousPath.includes('\0')))
          throw new Error('Cannot choose a project path: invalid previous path.');
        const result = await dialog.showSaveDialog(win, {
          title: 'New Project',
          buttonLabel: 'Create Project',
          defaultPath: previousPath === undefined ? undefined : path.dirname(previousPath),
        });
        if (result.canceled || !result.filePath) return null;
        return result.filePath.endsWith('.fry') ? result.filePath.slice(0, -4) : result.filePath;
      };
      void choose().then((selection) => {
        if (!win.isDestroyed() && !isShuttingDown()) win.webContents.send('fray:new-project-path', { selection });
      }).catch((error: Error) => {
        log.electronError('Cannot choose a project path: %s', error.message);
        if (!win.isDestroyed() && !isShuttingDown()) win.webContents.send('fray:new-project-path', { selection: null, error: error.message });
      });
    },
    onChooseOpenProjectPath(event, kind) {
      const win = getWindow();
      if (!win || win.isDestroyed() || event.sender !== win.webContents || isShuttingDown())
        return log.electronError('Cannot choose a project from this renderer.');
      const choose = async (): Promise<ProjectSelection | null> => {
        if (kind !== 'archive' && kind !== 'folder' && !(kind === 'both' && process.platform === 'darwin'))
          throw new Error('Cannot choose a project: invalid picker type.');
        const properties: ('openFile' | 'openDirectory')[] = kind === 'both'
          ? ['openFile', 'openDirectory'] : [kind === 'archive' ? 'openFile' : 'openDirectory'];
        const result = await dialog.showOpenDialog(win, {
          title: 'Open Project',
          properties,
          ...(kind === 'folder' ? {} : { filters: [{ name: 'Fray projects', extensions: ['fry'] }] }),
        });
        if (result.canceled) return null;
        const selected = result.filePaths[0];
        if (!selected || !path.isAbsolute(selected) || selected.includes('\0'))
          throw new Error('The selected project path is invalid.');
        const status = await lstat(selected);
        if (status.isDirectory() && kind !== 'archive')
          return { path: selected, kind: 'folder' };
        if (status.isFile() && kind !== 'folder' && path.extname(selected) === '.fry')
          return { path: selected.slice(0, -4), kind: 'archive' };
        throw new Error('Select a working folder or a .fry project archive.');
      };
      void choose().then((selection) => {
        if (!win.isDestroyed() && !isShuttingDown()) win.webContents.send('fray:open-project-path', { selection });
      }).catch((error: Error) => {
        log.electronError('Cannot choose a project: %s', error.message);
        if (!win.isDestroyed() && !isShuttingDown()) win.webContents.send('fray:open-project-path', { selection: null, error: error.message });
      });
    },
    announceReady() {
      send(frames.build({ command: message.Command.COMMAND_READY, destination: message.ProcessKind.PROCESS_KIND_BROADCAST }));
      send(frames.build({ command: message.Command.COMMAND_REQUEST_READY, destination: message.ProcessKind.PROCESS_KIND_BROADCAST }));
    },
    onPeerReady(kind) {
      log.electronInfo('%s is ready.', message.processName(kind));
      send(frames.build({ command: message.Command.COMMAND_READY, destination: kind }));
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
          sender !== message.ProcessKind.PROCESS_KIND_BROADCAST)
        send(frames.build({ command: message.Command.COMMAND_READY, destination: sender, destinationId: prefix.senderId }));
    },
  };
}
