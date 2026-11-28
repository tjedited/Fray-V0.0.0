import { createOpenProjectWorkflow } from '../renderer/message_handler';
import { ProjectCreateChoice, ProjectCreateStatus } from '../renderer/message_schema';
import type { ProjectCreateReply } from '../renderer/message_handler';
import type { NotificationOptions } from '../renderer/notifications';
import type { PromptOptions } from '../renderer/prompts';
import type { ProjectSelection } from '../shared/types';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function testProjectOpening(): Promise<void> {
  const selections: (ProjectSelection | null)[] = [
    { path: '/projects/folder', kind: 'folder' },
    { path: '/projects/both', kind: 'archive' },
    { path: '/projects/broken', kind: 'archive' },
    null,
    { path: '/projects/cancelled', kind: 'folder' },
  ];
  const pickerKinds: string[] = [];
  const requests: { path: string; choice: number; reply: (result: ProjectCreateReply) => void }[] = [];
  const prompts: Omit<PromptOptions, 'onResponse'>[] = [];
  const notifications: NotificationOptions[] = [];
  const workflow = createOpenProjectWorkflow(
    (kind) => {
      pickerKinds.push(kind);
      const selection = selections.shift() ?? null;
      queueMicrotask(() => workflow.onPath({ selection }));
    },
    (path, choice) => {
      const id = String(requests.length);
      requests.push({ path, choice, reply: (result) => { workflow.onResult(id, result); } });
      return id;
    },
    (prompt) => { prompts.push(prompt); return String(prompts.length - 1); },
    (notification) => notifications.push(notification),
    'darwin',
  );
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  workflow.start();
  await tick();
  check(pickerKinds[0] === 'both' && requests[0]?.choice === ProjectCreateChoice.PROJECT_SELECT_FOLDER,
    'Folder selection did not reach the Engine.');
  requests[0].reply({ path: '/projects/folder', status: ProjectCreateStatus.PROJECT_INVALID_DATABASE, error: 'invalid' });
  check(prompts[0]?.title === 'No valid project database', 'Missing database prompt was not shown.');
  workflow.onPromptResult('0', 'create');
  check(requests[1]?.choice === ProjectCreateChoice.PROJECT_CREATE_IN_FOLDER,
    'Creating in the existing folder was not requested.');
  requests[1].reply({ path: '/projects/folder', status: ProjectCreateStatus.PROJECT_CREATE_SUCCEEDED, error: '' });
  check(notifications[0]?.title === 'Project created', 'Creation was not notified.');
  workflow.start();
  await tick();
  requests[2].reply({ path: '/projects/both', status: ProjectCreateStatus.PROJECT_BOTH_CONFLICT, error: '' });
  check(prompts[1]?.title === 'Choose a project to open', 'Both-existing prompt was not shown.');
  workflow.onPromptResult('1', 'folder');
  check(requests[3]?.choice === ProjectCreateChoice.PROJECT_OPEN_FOLDER, 'Conflict choice was not sent.');
  requests[3].reply({ path: '/projects/both', status: ProjectCreateStatus.PROJECT_INVALID_DATABASE, error: 'invalid' });
  workflow.onPromptResult('2', 'create');
  check(requests[4]?.choice === ProjectCreateChoice.PROJECT_CREATE_IN_FOLDER_RESOLVE,
    'Confirmed archive conflict was not preserved for creation.');
  workflow.start();
  await tick();
  requests[5].reply({ path: '/projects/broken', status: ProjectCreateStatus.PROJECT_INVALID_DATABASE, error: 'invalid archive' });
  check(notifications[1]?.type === 'error' && prompts.length === 3, 'Invalid archive did not report an error.');
  workflow.start();
  await tick();
  check(requests.length === 6, 'Cancelled picker opened a project.');
  workflow.start();
  await tick();
  requests[6].reply({ path: '/projects/cancelled', status: ProjectCreateStatus.PROJECT_INVALID_DATABASE, error: 'invalid' });
  workflow.onPromptResult('3', 'cancel');
  check(requests.length === 7, 'Cancelled database prompt created a project.');

  const otherPrompts: Omit<PromptOptions, 'onResponse'>[] = [];
  const otherKinds: string[] = [];
  const other = createOpenProjectWorkflow(
    (kind) => { otherKinds.push(kind); queueMicrotask(() => other.onPath({ selection: null })); },
    () => { throw new Error('Cancelled picker sent a request.'); },
    (prompt) => { otherPrompts.push(prompt); return String(otherPrompts.length - 1); },
    (notification) => { throw new Error(notification.title); },
    'win32',
  );
  other.start();
  check(otherPrompts[0]?.buttons.length === 2, 'Platform requiring separate pickers did not ask for type.');
  other.onPromptResult('0', 'archive');
  await tick();
  check(otherKinds[0] === 'archive', 'Archive picker was not selected.');
  workflow.onPath({ selection: null, error: 'Picker failed' });
  check(notifications.at(-1)?.description === 'Picker failed', 'Picker failure was not notified.');
}
