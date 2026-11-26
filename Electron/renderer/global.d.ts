import type { FrayBridge } from '../shared/types';

declare global {
  interface Window {
    /** Exposed by the preload script; absent when the page runs outside Electron. */
    frayBridge?: FrayBridge;
    platform: string;
    versions: { node(): string; chrome(): string; electron(): string };
  }
}

export {};
