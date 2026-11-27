import React, { useCallback, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { IPCManager } from './ipc_manager';
import { createMessageHandler } from './message_handler';
import { NotificationProvider, useNotifications } from './notifications';
import { PromptProvider, usePrompts } from './prompts';
import { createProjectWorkflow } from './project_creation';
import { createOpenProjectWorkflow } from './project_opening';
import { PromptMessagesContext, type RequestPrompt } from './prompt_messages';

function RendererMessaging({ children }: { children: React.ReactNode }): React.JSX.Element {
  const showPrompt = usePrompts();
  const notify = useNotifications();
  const requester = useRef<RequestPrompt | null>(null);
  const requestPrompt = useCallback<RequestPrompt>((options, callback) => {
    if (!requester.current) throw new Error('Prompt messaging is unavailable.');
    requester.current(options, callback);
  }, []);
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
    requester.current = messages.requestPrompt;
    const startProject = createProjectWorkflow((path) => bridge.chooseNewProjectPath(path), messages.createProject, showPrompt, notify);
    const removeNewProject = bridge.onNewProject(startProject);
    const openProject = createOpenProjectWorkflow((kind) => bridge.chooseOpenProjectPath(kind),
      messages.createProject, showPrompt, notify, window.platform);
    const removeOpenProject = bridge.onOpenProject(openProject);
    let closingProject = false;
    const removeCloseProject = bridge.onCloseProject((packageProject) => {
      const fail = (error: string) => notify({
        type: 'error', title: packageProject ? 'Could not package project' : 'Could not close project', description: error,
      });
      if (closingProject) {
        fail('A project is already being closed.');
        return;
      }
      closingProject = true;
      try {
        messages.closeProject(packageProject, (result) => {
          closingProject = false;
          if (!result.success) fail(result.error || 'The Engine could not close the project.');
          else notify({
            type: 'success', title: result.packaged ? 'Project packaged' : 'Project closed', description: result.name,
          });
        });
      } catch (error) {
        closingProject = false;
        fail((error as Error).message);
      }
    });
    const removeShutdown = bridge.onShutdown(() => messages.cancelPending('Application is shutting down.'));
    return () => {
      removeNewProject();
      removeOpenProject();
      removeCloseProject();
      removeShutdown();
      requester.current = null;
      messages.cancelPending('Renderer messaging stopped.');
      ipc.close().catch((error) => console.error(`Failed to stop renderer IPC: ${(error as Error).message}`));
    };
  }, [notify, showPrompt]);
  return <PromptMessagesContext.Provider value={requestPrompt}>{children}</PromptMessagesContext.Provider>;
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
