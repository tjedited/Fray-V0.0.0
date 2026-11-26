/* message_router.js */

import { ProcessKind } from './message';
import type { Prefix } from '../shared/types';

export type Target = 'electron-main' | 'electron-renderer' | 'engine';

// Returns every place Electron Main must deliver this frame, never including the sender.
// An empty list means the frame cannot be routed.
export function routeMessage(prefix: Prefix): Target[] {
    const kind = prefix.destinationKind;
    let targets: Target[];
    if (kind === ProcessKind.PROCESS_KIND_ELECTRON_MAIN) targets = ['electron-main'];
    else if (kind === ProcessKind.PROCESS_KIND_ELECTRON_RENDERER && prefix.destinationId === 0)
        targets = ['electron-renderer'];
    else if (kind === ProcessKind.PROCESS_KIND_ENGINE) targets = ['engine'];
    else if (kind === ProcessKind.PROCESS_KIND_BROADCAST) targets = ['electron-main', 'electron-renderer', 'engine'];
    else return [];
    return targets.filter((target) => target !== senderTarget(prefix.senderKind));
}

function senderTarget(senderKind: number): Target | null {
    if (senderKind === ProcessKind.PROCESS_KIND_ELECTRON_MAIN) return 'electron-main';
    if (senderKind === ProcessKind.PROCESS_KIND_ELECTRON_RENDERER) return 'electron-renderer';
    if (senderKind === ProcessKind.PROCESS_KIND_ENGINE) return 'engine';
    return null;
}
