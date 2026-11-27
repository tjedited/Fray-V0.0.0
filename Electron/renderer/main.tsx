import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { IPCManager } from './ipc_manager';
import { createMessageHandler } from './message_handler';
import { NotificationProvider } from './notifications';
import NotificationPreview from './notification_preview';
import { PromptProvider } from './prompts';
import PromptPreview from './prompt_preview';

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <NotificationProvider>
    <PromptProvider>
      <App />
      <NotificationPreview />
      <PromptPreview />
    </PromptProvider>
  </NotificationProvider>,
);

const bridge = window.frayBridge;
if (bridge) {
  let ipc: IPCManager;
  const messages = createMessageHandler((frame) => ipc.send(frame), (status) => console.info(status));
  ipc = new IPCManager(bridge, messages.onMessage, messages.onReady, messages.onPeerReady);
} else {
  console.error('Engine connection is unavailable: renderer bridge is missing.');
}
