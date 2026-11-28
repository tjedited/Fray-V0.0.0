import React, { useEffect, useMemo, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { IPCManager } from './ipc_manager';
import { createMessageHandler } from './message_handler';
import { NotificationProvider, useNotifications } from './notifications';
import { PromptProvider, usePrompts } from './prompts';
import { PromptMessagesContext, type PromptMessages } from './prompt_messages';

function RendererMessaging({ children }: { children: React.ReactNode }): React.JSX.Element {
  const showPrompt = usePrompts();
  const notify = useNotifications();
  const requester = useRef<PromptMessages | null>(null);
  const promptMessages = useMemo<PromptMessages>(() => ({
    requestPrompt(options) {
      if (!requester.current) throw new Error('Prompt messaging is unavailable.');
      return requester.current.requestPrompt(options);
    },
    takePromptResult(requestId) {
      if (!requester.current) throw new Error('Prompt messaging is unavailable.');
      return requester.current.takePromptResult(requestId);
    },
  }), []);
  useEffect(() => {
    const bridge = window.frayBridge;
    if (!bridge) {
      console.error('Engine connection is unavailable: renderer bridge is missing.');
      return;
    }
    let ipc: IPCManager;
    const messages = createMessageHandler((frame) => ipc.send(frame), (status) => {
      console.info(status);
      if (status.startsWith('Invalid project creation result:') || status.startsWith('Invalid project close result:'))
        notify({ type: 'error', title: 'Project request failed', description: status });
    }, showPrompt);
    ipc = new IPCManager(bridge, messages.onMessage, messages.onReady, messages.onPeerReady);
    requester.current = messages;
    const removeProjectActions = messages.bindProjectActions(bridge, window.platform, notify);
    const removeShutdown = bridge.onShutdown(() => messages.cancelPending('Application is shutting down.'));
    return () => {
      removeProjectActions();
      removeShutdown();
      requester.current = null;
      messages.cancelPending('Renderer messaging stopped.');
      ipc.close().catch((error) => console.error(`Failed to stop renderer IPC: ${(error as Error).message}`));
    };
  }, [notify, showPrompt]);
  return <PromptMessagesContext.Provider value={promptMessages}>{children}</PromptMessagesContext.Provider>;
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(
  <NotificationProvider>
    <PromptProvider>
      <RendererMessaging>
        <App />
      </RendererMessaging>
    </PromptProvider>
  </NotificationProvider>,
);
