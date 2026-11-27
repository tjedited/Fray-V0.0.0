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

  export namespace fray {
    const Header: HeaderStatic;
    const HealthReport: HealthStatic;
    const ProjectOpenRequest: ProjectOpenRequestStatic;
    const ProjectOpenResult: ProjectOpenResultStatic;
    const ProcessKind: EnumValues;
    const PayloadType: EnumValues;
    const MessageType: EnumValues;
    const Command: EnumValues;
  }
}
