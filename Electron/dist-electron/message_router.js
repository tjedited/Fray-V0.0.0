"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const message = require("./message.js");
function routeMessage(prefix) {
  const kind = prefix.destinationKind;
  let targets;
  if (kind === message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN) targets = ["electron-main"];
  else if (kind === message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER && prefix.destinationId === 0)
    targets = ["electron-renderer"];
  else if (kind === message.ProcessKind.PROCESS_KIND_ENGINE) targets = ["engine"];
  else if (kind === message.ProcessKind.PROCESS_KIND_BROADCAST) targets = ["electron-main", "electron-renderer", "engine"];
  else return [];
  return targets.filter((target) => target !== senderTarget(prefix.senderKind));
}
function senderTarget(senderKind) {
  if (senderKind === message.ProcessKind.PROCESS_KIND_ELECTRON_MAIN) return "electron-main";
  if (senderKind === message.ProcessKind.PROCESS_KIND_ELECTRON_RENDERER) return "electron-renderer";
  if (senderKind === message.ProcessKind.PROCESS_KIND_ENGINE) return "engine";
  return null;
}
exports.routeMessage = routeMessage;
//# sourceMappingURL=message_router.js.map
