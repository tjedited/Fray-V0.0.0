/* message_router.js */

const { ProcessKind } = require('./message');

// Returns every place Electron Main must deliver this frame, never including the sender.
// An empty list means the frame cannot be routed.
function routeMessage(prefix) {
    const kind = prefix.destinationKind;
    let targets;
    if (kind === ProcessKind.PROCESS_KIND_ELECTRON_MAIN) targets = ['electron-main'];
    else if (kind === ProcessKind.PROCESS_KIND_ELECTRON_RENDERER && prefix.destinationId === 0)
        targets = ['electron-renderer'];
    else if (kind === ProcessKind.PROCESS_KIND_ENGINE) targets = ['engine'];
    else if (kind === ProcessKind.PROCESS_KIND_BROADCAST) targets = ['electron-main', 'electron-renderer', 'engine'];
    else return [];
    return targets.filter((target) => target !== senderTarget(prefix.senderKind));
}

function senderTarget(senderKind) {
    if (senderKind === ProcessKind.PROCESS_KIND_ELECTRON_MAIN) return 'electron-main';
    if (senderKind === ProcessKind.PROCESS_KIND_ELECTRON_RENDERER) return 'electron-renderer';
    if (senderKind === ProcessKind.PROCESS_KIND_ENGINE) return 'engine';
    return null;
}

module.exports = { routeMessage };
