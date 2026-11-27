// The module is generated from Schemas/fray.proto by the fraySchema Vite plugin (see vite.schema.ts).
declare module 'virtual:fray-schema' {
  type EnumValues = Readonly<Record<string, number>>;

  interface HeaderMessage {
    readonly __header: unique symbol;
  }

  interface HeaderStatic {
    fromObject(object: object): HeaderMessage;
    verify(message: object): string | null;
    encode(message: HeaderMessage): { finish(): Uint8Array };
    decode(bytes: Uint8Array): HeaderMessage;
    toObject(message: HeaderMessage, options?: { defaults?: boolean; longs?: StringConstructor }): object;
  }

  interface HealthMessage {
    readonly __health: unique symbol;
  }
  interface HealthStatic {
    fromObject(object: object): HealthMessage;
    encode(message: HealthMessage): { finish(): Uint8Array };
    decode(bytes: Uint8Array): HealthMessage;
    toObject(message: HealthMessage, options?: { defaults?: boolean; longs?: StringConstructor }): object;
  }

  interface ProjectOpenRequestStatic {
    fromObject(object: { name: string }): object;
    encode(message: object): { finish(): Uint8Array };
  }
  interface ProjectOpenResultMessage {
    name: string;
    success: boolean;
    error: string;
    requestId: number | { toString(): string };
  }
  interface ProjectOpenResultStatic {
    decode(bytes: Uint8Array): ProjectOpenResultMessage;
  }

  interface PromptRequestMessage {
    title: string;
    description: string;
    buttons: { label: string; value: string }[];
    dismissible?: boolean;
  }
  interface PromptRequestStatic {
    fromObject(object: PromptRequestMessage): object;
    encode(message: object): { finish(): Uint8Array };
    decode(bytes: Uint8Array): PromptRequestMessage;
  }
  interface PromptResponseMessage {
    requestId: number | { toString(): string };
    dismissed: boolean;
    value: string;
    error: string;
  }
  interface PromptResponseStatic {
    fromObject(object: { requestId: string; dismissed: boolean; value: string; error: string }): object;
    encode(message: object): { finish(): Uint8Array };
    decode(bytes: Uint8Array): PromptResponseMessage;
  }
  interface ProjectCreateRequestStatic {
    fromObject(object: { path: string; choice: number }): object;
    encode(message: object): { finish(): Uint8Array };
  }
  interface ProjectCreateResultMessage {
    requestId: number | { toString(): string };
    path: string;
    status: number;
    error: string;
  }
  interface ProjectCreateResultStatic {
    decode(bytes: Uint8Array): ProjectCreateResultMessage;
  }
  interface ProjectCloseRequestStatic {
    fromObject(object: { package: boolean }): object;
    encode(message: object): { finish(): Uint8Array };
  }
  interface ProjectCloseResultMessage {
    requestId: number | { toString(): string };
    name: string;
    success: boolean;
    packaged: boolean;
    error: string;
  }
  interface ProjectCloseResultStatic {
    decode(bytes: Uint8Array): ProjectCloseResultMessage;
  }

  export namespace fray {
    const Header: HeaderStatic;
    const HealthReport: HealthStatic;
    const ProjectOpenRequest: ProjectOpenRequestStatic;
    const ProjectOpenResult: ProjectOpenResultStatic;
    const PromptRequest: PromptRequestStatic;
    const PromptResponse: PromptResponseStatic;
    const ProjectCreateRequest: ProjectCreateRequestStatic;
    const ProjectCreateResult: ProjectCreateResultStatic;
    const ProjectCloseRequest: ProjectCloseRequestStatic;
    const ProjectCloseResult: ProjectCloseResultStatic;
    const ProjectCreateChoice: EnumValues;
    const ProjectCreateStatus: EnumValues;
    const ProcessKind: EnumValues;
    const PayloadType: EnumValues;
    const MessageType: EnumValues;
    const Command: EnumValues;
  }
}
