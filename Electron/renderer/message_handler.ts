import { buildFrame, Command, MessageType, parseFrame, PayloadType, processName, ProcessKind } from './message';
import { ProjectOpenRequest, ProjectOpenResult, ProjectCreateRequest, ProjectCreateResult,
  ProjectCloseRequest, ProjectCloseResult, PromptRequest, PromptResponse, ProjectCreateChoice,
  ProjectCreateStatus } from './message_schema';
import { createFrameBuilder } from '../shared/frame_builder';
import type { FrayBridge, IncomingMessage, ProjectPathResult, ProjectSelection, PromptResult } from '../shared/types';
import type { PromptOptions } from './prompts';
import type { NotificationOptions } from './notifications';

const SELF = ProcessKind.PROCESS_KIND_ELECTRON_RENDERER;
type ProjectPrompt = Omit<PromptOptions, 'onResponse'>;

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
  packageRequested?: boolean;
}

export function createProjectWorkflow(
  choosePath: (previousPath?: string) => void,
  send: (path: string, choice: number) => string,
  requestPrompt: (options: ProjectPrompt) => string,
  notify: (options: NotificationOptions) => void,
): { start: () => void; onResult: (id: string, result: ProjectCreateReply) => boolean;
     onPath: (result: ProjectPathResult<string>) => void;
     onPromptResult: (id: string, value: string | null, error?: string) => boolean } {
  const requests = new Set<string>();
  const prompts = new Map<string, { path: string; both: boolean; stage: 'conflict' | 'source' }>();

  function reportError(error: string): void {
    notify({ type: 'error', title: 'Could not create or open project', description: error });
  }

  function prompt(options: ProjectPrompt, state: { path: string; both: boolean; stage: 'conflict' | 'source' }): void {
    try {
      prompts.set(requestPrompt(options), state);
    } catch (error) {
      reportError((error as Error).message);
    }
  }

  function sendRequest(path: string, choice: number): void {
    try {
      requests.add(send(path, choice));
    } catch (error) {
      reportError((error as Error).message);
    }
  }

  function handleResult(id: string, result: ProjectCreateReply): boolean {
    if (!requests.delete(id)) return false;
    const { path, status, error } = result;
    if (status === ProjectCreateStatus.PROJECT_CREATE_SUCCEEDED || status === ProjectCreateStatus.PROJECT_OPEN_SUCCEEDED) {
      notify({
        type: 'success',
        title: status === ProjectCreateStatus.PROJECT_CREATE_SUCCEEDED ? 'Project created' : 'Project opened',
        description: path,
      });
      return true;
    }
    if (status === ProjectCreateStatus.PROJECT_FOLDER_CONFLICT ||
        status === ProjectCreateStatus.PROJECT_ARCHIVE_CONFLICT ||
        status === ProjectCreateStatus.PROJECT_BOTH_CONFLICT) {
      const exists = status === ProjectCreateStatus.PROJECT_BOTH_CONFLICT ? 'a working folder and archive' :
        status === ProjectCreateStatus.PROJECT_FOLDER_CONFLICT ? 'a working folder' : 'an archive';
      prompt({
        title: 'Project already exists',
        description: `There is already ${exists} at ${path}.`,
        buttons: [
          { label: 'Open Existing', value: 'open' },
          { label: 'Choose Another Name', value: 'rename' },
        ],
      }, { path, both: status === ProjectCreateStatus.PROJECT_BOTH_CONFLICT, stage: 'conflict' });
      return true;
    }
    reportError(error || 'The Engine returned an unknown project result.');
    return true;
  }

  function choose(previousPath?: string): void {
    try {
      choosePath(previousPath);
    } catch (error) {
      reportError((error as Error).message);
    }
  }

  function onPath(result: ProjectPathResult<string>): void {
    if (result.error) reportError(result.error);
    else if (result.selection !== null) sendRequest(result.selection, ProjectCreateChoice.PROJECT_CREATE_NEW);
  }

  function onPromptResult(id: string, value: string | null, error?: string): boolean {
    const pending = prompts.get(id);
    if (!pending) return false;
    prompts.delete(id);
    if (error) {
      reportError(error);
      return true;
    }
    const { path, both, stage } = pending;
    if (stage === 'source') {
      if (value === 'archive') sendRequest(path, ProjectCreateChoice.PROJECT_OPEN_ARCHIVE);
      else if (value === 'folder') sendRequest(path, ProjectCreateChoice.PROJECT_OPEN_FOLDER);
    } else if (value === 'rename') choose(path);
    else if (value === 'open' && both) {
      prompt({
        title: 'Choose a project to open',
        description: 'Opening one will rename the other so both are preserved.',
        buttons: [
          { label: 'Open Archive', value: 'archive' },
          { label: 'Open Working Folder', value: 'folder' },
        ],
      }, { path, both, stage: 'source' });
    } else if (value === 'open') sendRequest(path, ProjectCreateChoice.PROJECT_OPEN_EXISTING);
    return true;
  }

  return { start: () => choose(), onResult: handleResult, onPath, onPromptResult };
}

export function createOpenProjectWorkflow(
  choosePath: (kind: 'archive' | 'folder' | 'both') => void,
  send: (path: string, choice: number) => string,
  requestPrompt: (options: ProjectPrompt) => string,
  notify: (options: NotificationOptions) => void,
  platform: string,
): { start: () => void; onResult: (id: string, result: ProjectCreateReply) => boolean;
     onPath: (result: ProjectPathResult<ProjectSelection>) => void;
     onPromptResult: (id: string, value: string | null, error?: string) => boolean } {
  const requests = new Map<string, { path: string; choice: number; kind: 'archive' | 'folder'; resolveConflict: boolean }>();
  type PromptState = { stage: 'picker' } | { stage: 'conflict'; path: string } |
    { stage: 'invalid'; path: string; resolveConflict: boolean };
  const prompts = new Map<string, PromptState>();

  function reportError(error: string): void {
    notify({ type: 'error', title: 'Could not open project', description: error });
  }

  function prompt(options: ProjectPrompt, state: PromptState): void {
    try {
      prompts.set(requestPrompt(options), state);
    } catch (error) {
      reportError((error as Error).message);
    }
  }

  function request(path: string, choice: number, kind: 'archive' | 'folder', resolveConflict = false): void {
    try {
      requests.set(send(path, choice), { path, choice, kind, resolveConflict });
    } catch (error) {
      reportError((error as Error).message);
    }
  }

  function onResult(id: string, result: ProjectCreateReply): boolean {
    const pending = requests.get(id);
    if (!pending) return false;
    requests.delete(id);
    const { path, choice, kind, resolveConflict } = pending;
    if (result.status === ProjectCreateStatus.PROJECT_OPEN_SUCCEEDED ||
        result.status === ProjectCreateStatus.PROJECT_CREATE_SUCCEEDED) {
      notify({
        type: 'success',
        title: result.status === ProjectCreateStatus.PROJECT_OPEN_SUCCEEDED ? 'Project opened' : 'Project created',
        description: path,
      });
    } else if (result.status === ProjectCreateStatus.PROJECT_BOTH_CONFLICT &&
               choice !== ProjectCreateChoice.PROJECT_CREATE_IN_FOLDER &&
               choice !== ProjectCreateChoice.PROJECT_CREATE_IN_FOLDER_RESOLVE) {
      prompt({
        title: 'Choose a project to open',
        description: 'Both a working folder and archive exist. Opening one will rename the other so both are preserved.',
        buttons: [
          { label: 'Open Archive', value: 'archive' },
          { label: 'Open Working Folder', value: 'folder' },
        ],
      }, { stage: 'conflict', path });
    } else if (result.status === ProjectCreateStatus.PROJECT_INVALID_DATABASE && kind === 'folder') {
      prompt({
        title: 'No valid project database',
        description: 'This folder does not contain a valid Fray database. Create a new project here?',
        buttons: [
          { label: 'Cancel', value: 'cancel' },
          { label: 'Create Project', value: 'create' },
        ],
      }, { stage: 'invalid', path, resolveConflict });
    } else if (result.status === ProjectCreateStatus.PROJECT_FOLDER_CONFLICT ||
               result.status === ProjectCreateStatus.PROJECT_BOTH_CONFLICT) {
      reportError('The selected folder changed. Please open it again.');
    } else {
      reportError(result.error || 'The Engine returned an unknown project result.');
    }
    return true;
  }

  function choose(kind: 'archive' | 'folder' | 'both'): void {
    try {
      choosePath(kind);
    } catch (error) {
      reportError((error as Error).message);
    }
  }

  function onPath(result: ProjectPathResult<ProjectSelection>): void {
    if (result.error) reportError(result.error);
    else if (result.selection) {
      const selected = result.selection;
      request(selected.path, selected.kind === 'archive'
        ? ProjectCreateChoice.PROJECT_SELECT_ARCHIVE : ProjectCreateChoice.PROJECT_SELECT_FOLDER, selected.kind);
    }
  }

  function start(): void {
    if (platform === 'darwin') choose('both');
    else {
      prompt({
        title: 'Open Project',
        description: 'Choose a project archive or working folder.',
        buttons: [
          { label: 'Choose Archive', value: 'archive' },
          { label: 'Choose Working Folder', value: 'folder' },
        ],
      }, { stage: 'picker' });
    }
  }

  function onPromptResult(id: string, value: string | null, error?: string): boolean {
    const pending = prompts.get(id);
    if (!pending) return false;
    prompts.delete(id);
    if (error) {
      reportError(error);
      return true;
    }
    if (pending.stage === 'picker') {
      if (value === 'archive' || value === 'folder') choose(value);
    } else if (pending.stage === 'conflict') {
      if (value === 'archive') request(pending.path, ProjectCreateChoice.PROJECT_OPEN_ARCHIVE, 'archive', true);
      else if (value === 'folder') request(pending.path, ProjectCreateChoice.PROJECT_OPEN_FOLDER, 'folder', true);
    } else if (value === 'create') {
      request(pending.path, pending.resolveConflict
        ? ProjectCreateChoice.PROJECT_CREATE_IN_FOLDER_RESOLVE
        : ProjectCreateChoice.PROJECT_CREATE_IN_FOLDER, 'folder', pending.resolveConflict);
    }
    return true;
  }
  return { start, onResult, onPath, onPromptResult };
}

export function createMessageHandler(
  send: (frame: Uint8Array) => void,
  setStatus: (status: string) => void,
  showPrompt?: (options: PromptOptions) => void,
): {
  submitProject: (input: string) => void;
  createProject: (path: string, choice: number) => string;
  closeProject: (packageProject: boolean, targetProject?: string) => void;
  requestPrompt: (options: Omit<PromptOptions, 'onResponse'>) => string;
  takePromptResult: (requestId: string) => PromptResult | undefined;
  onMessage: (incoming: IncomingMessage<Uint8Array>) => void;
  onReady: () => void;
  onPeerReady: (kind: number) => void;
  cancelPending: (reason: string) => void;
  bindProjectActions: (bridge: FrayBridge, platform: string, notify: (options: NotificationOptions) => void) => () => void;
} {
  const frames = createFrameBuilder(SELF, 1, buildFrame, processName);
  let latestRequestId = '';
  const projectRequests = new Map<string, string>();
  const projectCloseModes = new Map<string, boolean>();
  const promptRequests = new Map<string, {
    options: Omit<PromptOptions, 'onResponse'>;
    result?: PromptResult;
  }>();
  let onProjectCreateResult: ((id: string, result: ProjectCreateReply) => void) | undefined;
  let onProjectCloseResult: ((result: ProjectCloseReply) => void) | undefined;
  let onProjectPromptResult: ((id: string, value: string | null, error?: string) => boolean) | undefined;

  function announceReady(): void {
    send(frames.build({ command: Command.COMMAND_READY, destination: ProcessKind.PROCESS_KIND_BROADCAST }));
    send(frames.build({ command: Command.COMMAND_REQUEST_READY, destination: ProcessKind.PROCESS_KIND_BROADCAST }));
  }

  function closeProject(packageProject: boolean, targetProject?: string): void {
    const payload = ProjectCloseRequest.encode(ProjectCloseRequest.fromObject({ package: packageProject })).finish();
    const frame = frames.build({
      destination: ProcessKind.PROCESS_KIND_ENGINE, command: Command.COMMAND_CLOSE_PROJECT,
      targetProject, payload, payloadType: PayloadType.PAYLOAD_TYPE_PROTOBUF,
      messageType: MessageType.MESSAGE_TYPE_PROJECT_CLOSE_REQUEST,
    });
    const id = parseFrame(frame).header.messageId;
    projectCloseModes.set(id, packageProject);
    try {
      send(frame);
    } catch (error) {
      projectCloseModes.delete(id);
      throw error;
    }
  }

  function createProject(path: string, choice: number): string {
    const payload = ProjectCreateRequest.encode(ProjectCreateRequest.fromObject({ path, choice })).finish();
    const frame = frames.build({
      destination: ProcessKind.PROCESS_KIND_ENGINE, command: Command.COMMAND_CREATE_PROJECT,
      payload, payloadType: PayloadType.PAYLOAD_TYPE_PROTOBUF,
      messageType: MessageType.MESSAGE_TYPE_PROJECT_CREATE_REQUEST,
    });
    const id = parseFrame(frame).header.messageId;
    projectRequests.set(id, path);
    try {
      send(frame);
    } catch (error) {
      projectRequests.delete(id);
      throw error;
    }
    return id;
  }

  function requestPrompt(options: ProjectPrompt): string {
    if (!options.title.trim() || !options.buttons.length || options.buttons.some((button) => !button.label.trim()))
      throw new Error('Prompt requires a title and labeled buttons.');
    const request = { ...options, description: options.description ?? '' };
    const payload = PromptRequest.encode(PromptRequest.fromObject(request)).finish();
    const frame = frames.build({
      destination: SELF, command: Command.COMMAND_PROMPT_REQUEST,
      payload, payloadType: PayloadType.PAYLOAD_TYPE_PROTOBUF, messageType: MessageType.MESSAGE_TYPE_PROMPT_REQUEST,
    });
    const id = parseFrame(frame).header.messageId;
    promptRequests.set(id, { options });
    try {
      send(frame);
    } catch (error) {
      promptRequests.delete(id);
      throw error;
    }
    return id;
  }

  return {
    cancelPending(reason) {
      projectRequests.clear();
      projectCloseModes.clear();
      for (const prompt of promptRequests.values())
        if (!prompt.result) prompt.result = { value: null, error: reason };
    },
    closeProject,
    requestPrompt,
    takePromptResult(requestId) {
      const request = promptRequests.get(requestId);
      if (!request?.result) return undefined;
      promptRequests.delete(requestId);
      return request.result;
    },
    createProject,
    bindProjectActions(bridge, platform, notify) {
      if (!showPrompt) throw new Error('Prompt UI is unavailable.');
      const creation = createProjectWorkflow((path) => bridge.chooseNewProjectPath(path), createProject, requestPrompt, notify);
      const opening = createOpenProjectWorkflow((kind) => bridge.chooseOpenProjectPath(kind),
        createProject, requestPrompt, notify, platform);
      onProjectPromptResult = (id, value, error) =>
        creation.onPromptResult(id, value, error) || opening.onPromptResult(id, value, error);
      onProjectCreateResult = (id, result) => {
        if (!creation.onResult(id, result) && !opening.onResult(id, result))
          console.error(`Unknown project workflow request: ${id}`);
      };
      onProjectCloseResult = (result) => {
        if (!result.success) notify({
          type: 'error', title: result.packageRequested ? 'Could not package project' : 'Could not close project',
          description: result.error || 'The Engine could not close the project.',
        });
        else notify({
          type: 'success', title: result.packaged ? 'Project packaged' : 'Project closed', description: result.name,
        });
      };
      const removeNewProject = bridge.onNewProject(creation.start);
      const removeNewProjectPath = bridge.onNewProjectPath(creation.onPath);
      const removeOpenProject = bridge.onOpenProject(opening.start);
      const removeOpenProjectPath = bridge.onOpenProjectPath(opening.onPath);
      const removeCloseProject = bridge.onCloseProject((packageProject) => {
        try {
          closeProject(packageProject);
        } catch (error) {
          notify({
            type: 'error', title: packageProject ? 'Could not package project' : 'Could not close project',
            description: (error as Error).message,
          });
        }
      });
      return () => {
        removeNewProject();
        removeNewProjectPath();
        removeOpenProject();
        removeOpenProjectPath();
        removeCloseProject();
        onProjectCreateResult = undefined;
        onProjectCloseResult = undefined;
        onProjectPromptResult = undefined;
      };
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
          if (!request || request.result) throw new Error('Unknown prompt response.');
          if (!response.error && (response.dismissed
            ? request.options.dismissible === false
            : !request.options.buttons.some((button) => button.value === response.value)))
            throw new Error('Prompt response is not an allowed choice.');
          request.result = response.error ? { value: null, error: response.error } :
            { value: response.dismissed ? null : response.value };
          if (onProjectPromptResult?.(id, request.result.value, request.result.error)) {
            promptRequests.delete(id);
          }
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
          if (pending === undefined) throw new Error('Unknown project creation request.');
          projectRequests.delete(id);
          if (!onProjectCreateResult) throw new Error('Project creation result handler is unavailable.');
          if (result.path !== pending) {
            onProjectCreateResult(id, { path: pending, status: 0, error: 'Project result path does not match the request.' });
          } else {
            onProjectCreateResult(id, { path: result.path, status: result.status, error: result.error });
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
          const packageRequested = projectCloseModes.get(id);
          projectCloseModes.delete(id);
          if (!onProjectCloseResult) throw new Error('Project close result handler is unavailable.');
          onProjectCloseResult({ name: result.name, success: result.success, packaged: result.packaged,
            error: result.error, packageRequested });
        } catch (error) {
          const status = `Invalid project close result: ${(error as Error).message}`;
          console.error(status);
          setStatus(status);
        }
      }
      const sender = prefix.senderKind;
      if (prefix.commandId === Command.COMMAND_REQUEST_READY && sender !== SELF && sender !== ProcessKind.PROCESS_KIND_BROADCAST)
        send(frames.build({ command: Command.COMMAND_READY,
          destination: sender === ProcessKind.PROCESS_KIND_ELECTRON_MAIN ? ProcessKind.PROCESS_KIND_BROADCAST : sender,
          destinationId: sender === ProcessKind.PROCESS_KIND_ELECTRON_MAIN ? 0 : prefix.senderId }));
    },
    onReady() {
      announceReady();
    },
    onPeerReady(kind) {
      console.info(`${processName(kind)} is ready.`);
      send(frames.build({ command: Command.COMMAND_READY, destination: kind }));
    },
  };
}
