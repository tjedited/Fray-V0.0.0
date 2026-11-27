import { ProjectCreateChoice, ProjectCreateStatus } from './message_schema';
import type { ProjectCreateReply } from './message_handler';
import type { NotificationOptions } from './notifications';
import type { PromptOptions } from './prompts';
import type { ProjectSelection } from '../shared/types';

export function createOpenProjectWorkflow(
  choosePath: (kind: 'archive' | 'folder' | 'both') => Promise<ProjectSelection | null>,
  send: (path: string, choice: number, onResult: (result: ProjectCreateReply) => void) => void,
  showPrompt: (options: PromptOptions) => void,
  notify: (options: NotificationOptions) => void,
  platform: string,
): () => void {
  let choosing = false;

  function reportError(error: string): void {
    notify({ type: 'error', title: 'Could not open project', description: error });
  }

  function request(path: string, choice: number, kind: 'archive' | 'folder', resolveConflict = false): void {
    try {
      send(path, choice, (result) => {
        if (result.status === ProjectCreateStatus.PROJECT_OPEN_SUCCEEDED ||
            result.status === ProjectCreateStatus.PROJECT_CREATE_SUCCEEDED) {
          notify({
            type: 'success',
            title: result.status === ProjectCreateStatus.PROJECT_OPEN_SUCCEEDED ? 'Project opened' : 'Project created',
            description: path,
          });
        } else if (result.status === ProjectCreateStatus.PROJECT_BOTH_CONFLICT &&
                   choice !== ProjectCreateChoice.PROJECT_CREATE_IN_FOLDER &&
                   choice !== ProjectCreateChoice.PROJECT_CREATE_IN_FOLDER_RESOLVE) {
          showPrompt({
            title: 'Choose a project to open',
            description: 'Both a working folder and archive exist. Opening one will rename the other so both are preserved.',
            buttons: [
              { label: 'Open Archive', value: 'archive' },
              { label: 'Open Working Folder', value: 'folder' },
            ],
            onResponse: (value) => {
              if (value === 'archive') request(path, ProjectCreateChoice.PROJECT_OPEN_ARCHIVE, 'archive', true);
              else if (value === 'folder') request(path, ProjectCreateChoice.PROJECT_OPEN_FOLDER, 'folder', true);
            },
          });
        } else if (result.status === ProjectCreateStatus.PROJECT_INVALID_DATABASE && kind === 'folder') {
          showPrompt({
            title: 'No valid project database',
            description: 'This folder does not contain a valid Fray database. Create a new project here?',
            buttons: [
              { label: 'Cancel', value: 'cancel' },
              { label: 'Create Project', value: 'create' },
            ],
            onResponse: (value) => {
              if (value === 'create') request(path, resolveConflict
                ? ProjectCreateChoice.PROJECT_CREATE_IN_FOLDER_RESOLVE
                : ProjectCreateChoice.PROJECT_CREATE_IN_FOLDER, 'folder', resolveConflict);
            },
          });
        } else if (result.status === ProjectCreateStatus.PROJECT_FOLDER_CONFLICT ||
                   result.status === ProjectCreateStatus.PROJECT_BOTH_CONFLICT) {
          reportError('The selected folder changed. Please open it again.');
        } else {
          reportError(result.error || 'The Engine returned an unknown project result.');
        }
      });
    } catch (error) {
      reportError((error as Error).message);
    }
  }

  async function choose(kind: 'archive' | 'folder' | 'both'): Promise<void> {
    if (choosing) return;
    choosing = true;
    try {
      const selected = await choosePath(kind);
      if (selected) request(selected.path, selected.kind === 'archive'
        ? ProjectCreateChoice.PROJECT_SELECT_ARCHIVE : ProjectCreateChoice.PROJECT_SELECT_FOLDER, selected.kind);
    } catch (error) {
      reportError((error as Error).message);
    } finally {
      choosing = false;
    }
  }

  return () => {
    if (platform === 'darwin') void choose('both');
    else showPrompt({
      title: 'Open Project',
      description: 'Choose a project archive or working folder.',
      buttons: [
        { label: 'Choose Archive', value: 'archive' },
        { label: 'Choose Working Folder', value: 'folder' },
      ],
      onResponse: (value) => {
        if (value === 'archive' || value === 'folder') void choose(value);
      },
    });
  };
}
