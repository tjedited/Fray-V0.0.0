import { ProcessKind } from './message_schema';
import type { Prefix } from '../shared/types';

// The renderer only receives from Electron Main, which delivers broadcasts here too and never echoes the renderer's own.
export function routeMessage(prefix: Prefix): 'electron-renderer' | 'unsupported' {
  if (prefix.destinationKind === ProcessKind.PROCESS_KIND_BROADCAST) return 'electron-renderer';
  if (prefix.destinationKind === ProcessKind.PROCESS_KIND_ELECTRON_RENDERER && prefix.destinationId === 0)
    return 'electron-renderer';
  return 'unsupported';
}
