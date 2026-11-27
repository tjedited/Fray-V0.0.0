/* Types shared by Electron Main, the preload script and the renderer. Nothing here exists at runtime. */

/** The fixed binary routing prefix that sits in front of every frame. */
export interface Prefix {
  version: number;
  destinationKind: number;
  destinationId: number;
  senderKind: number;
  senderId: number;
  commandId: number;
  /** Bytes after the prefix (header + payload). */
  length: number;
  /** Bytes of the protobuf header. */
  headerLength: number;
}

/** The routing fields a sender chooses; the lengths are filled in when the frame is built. */
export interface PrefixFields {
  destinationKind: number;
  /** 0 = default or broadcast. */
  destinationId?: number;
  senderKind: number;
  senderId?: number;
  /** 0 = none. */
  commandId?: number;
}

/** Fields of fray.Header as the application sets them. */
export interface HeaderFields {
  protocolVersion?: number;
  messageId?: number | string;
  timestamp?: number | string;
  flags?: number;
  senderName?: string;
  destinationName?: string;
  targetProject?: string;
  payloadType?: number;
  messageType?: number;
  /** How long a router may hold the message while its destination is not ready, in milliseconds. 0 = forever. */
  ttlMs?: number;
}

/** A decoded fray.Header (defaults filled in, 64-bit integers as strings). */
export interface DecodedHeader {
  protocolVersion: number;
  messageId: string;
  timestamp: string;
  flags: number;
  senderName: string;
  destinationName: string;
  targetProject?: string;
  payloadType: number;
  messageType: number;
  ttlMs: number;
}

/** What a handler receives for every frame addressed to this process. */
export interface IncomingMessage<TPayload> {
  prefix: Prefix;
  header: DecodedHeader;
  payload: TPayload;
}

/** The lifecycle states the renderer reports to Electron Main. */
export type RendererState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export type ProjectSelection = { path: string; kind: 'archive' | 'folder' };

/** The API the preload script exposes to the renderer as `window.frayBridge`. */
export interface FrayBridge {
  sendFrame(frame: Uint8Array): void;
  reportState(state: RendererState, threads: string[]): void;
  /** Returns a function that removes the handler. */
  onFrame(handler: (frame: Uint8Array) => void): () => void;
  /** Returns a function that removes the handler. */
  onShutdown(handler: () => void): () => void;
  onNewProject(handler: () => void): () => void;
  chooseNewProjectPath(previousPath?: string): Promise<string | null>;
  onOpenProject(handler: () => void): () => void;
  chooseOpenProjectPath(kind: 'archive' | 'folder' | 'both'): Promise<ProjectSelection | null>;
  onCloseProject(handler: (packageProject: boolean) => void): () => void;
}
