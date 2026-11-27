import { ProjectCreateChoice, ProjectCreateStatus } from './message_schema';
import type { ProjectCreateReply } from './message_handler';
import type { NotificationOptions } from './notifications';
import type { PromptOptions } from './prompts';

export function createProjectWorkflow(
  choosePath: (previousPath?: string) => Promise<string | null>,
  send: (path: string, choice: number, onResult: (result: ProjectCreateReply) => void) => void,
  showPrompt: (options: PromptOptions) => void,
  notify: (options: NotificationOptions) => void,
): () => void {
  let choosing = false;

  function reportError(error: string): void {
    notify({ type: 'error', title: 'Could not create or open project', description: error });
  }

  function sendRequest(path: string, choice: number): void {
    try {
      send(path, choice, handleResult);
    } catch (error) {
      reportError((error as Error).message);
    }
  }

  function handleResult(result: ProjectCreateReply): void {
    const { path, status, error } = result;
    if (status === ProjectCreateStatus.PROJECT_CREATE_SUCCEEDED || status === ProjectCreateStatus.PROJECT_OPEN_SUCCEEDED) {
      notify({
        type: 'success',
        title: status === ProjectCreateStatus.PROJECT_CREATE_SUCCEEDED ? 'Project created' : 'Project opened',
        description: path,
      });
      return;
    }
    if (status === ProjectCreateStatus.PROJECT_FOLDER_CONFLICT ||
        status === ProjectCreateStatus.PROJECT_ARCHIVE_CONFLICT ||
        status === ProjectCreateStatus.PROJECT_BOTH_CONFLICT) {
      const exists = status === ProjectCreateStatus.PROJECT_BOTH_CONFLICT ? 'a working folder and archive' :
        status === ProjectCreateStatus.PROJECT_FOLDER_CONFLICT ? 'a working folder' : 'an archive';
      showPrompt({
        title: 'Project already exists',
        description: `There is already ${exists} at ${path}.`,
        buttons: [
          { label: 'Open Existing', value: 'open' },
          { label: 'Choose Another Name', value: 'rename' },
        ],
        onResponse: (value) => {
          if (value === 'rename') void choose(path);
          else if (value === 'open' && status === ProjectCreateStatus.PROJECT_BOTH_CONFLICT) {
            showPrompt({
              title: 'Choose a project to open',
              description: 'Opening one will rename the other so both are preserved.',
              buttons: [
                { label: 'Open Archive', value: 'archive' },
                { label: 'Open Working Folder', value: 'folder' },
              ],
              onResponse: (selected) => {
                if (selected === 'archive') sendRequest(path, ProjectCreateChoice.PROJECT_OPEN_ARCHIVE);
                else if (selected === 'folder') sendRequest(path, ProjectCreateChoice.PROJECT_OPEN_FOLDER);
              },
            });
          } else if (value === 'open') sendRequest(path, ProjectCreateChoice.PROJECT_OPEN_EXISTING);
        },
      });
      return;
    }
    reportError(error || 'The Engine returned an unknown project result.');
  }

  async function choose(previousPath?: string): Promise<void> {
    if (choosing) return;
    choosing = true;
    try {
      const path = await choosePath(previousPath);
      if (path !== null) sendRequest(path, ProjectCreateChoice.PROJECT_CREATE_NEW);
    } catch (error) {
      reportError((error as Error).message);
    } finally {
      choosing = false;
    }
  }

  return () => { void choose(); };
}
