import { createOpenProjectWorkflow } from '../renderer/project_opening';
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
  const prompts: PromptOptions[] = [];
  const notifications: NotificationOptions[] = [];
  const start = createOpenProjectWorkflow(
    async (kind) => { pickerKinds.push(kind); return selections.shift() ?? null; },
    (path, choice, reply) => requests.push({ path, choice, reply }),
    (prompt) => prompts.push(prompt),
    (notification) => notifications.push(notification),
    'darwin',
  );
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  start();
  await tick();
  check(pickerKinds[0] === 'both' && requests[0]?.choice === ProjectCreateChoice.PROJECT_SELECT_FOLDER,
    'Folder selection did not reach the Engine.');
  requests[0].reply({ path: '/projects/folder', status: ProjectCreateStatus.PROJECT_INVALID_DATABASE, error: 'invalid' });
  check(prompts[0]?.title === 'No valid project database', 'Missing database prompt was not shown.');
  prompts[0].onResponse('create');
  check(requests[1]?.choice === ProjectCreateChoice.PROJECT_CREATE_IN_FOLDER,
    'Creating in the existing folder was not requested.');
  requests[1].reply({ path: '/projects/folder', status: ProjectCreateStatus.PROJECT_CREATE_SUCCEEDED, error: '' });
  check(notifications[0]?.title === 'Project created', 'Creation was not notified.');
  start();
  await tick();
  requests[2].reply({ path: '/projects/both', status: ProjectCreateStatus.PROJECT_BOTH_CONFLICT, error: '' });
  check(prompts[1]?.title === 'Choose a project to open', 'Both-existing prompt was not shown.');
  prompts[1].onResponse('folder');
  check(requests[3]?.choice === ProjectCreateChoice.PROJECT_OPEN_FOLDER, 'Conflict choice was not sent.');
  requests[3].reply({ path: '/projects/both', status: ProjectCreateStatus.PROJECT_INVALID_DATABASE, error: 'invalid' });
  prompts[2].onResponse('create');
  check(requests[4]?.choice === ProjectCreateChoice.PROJECT_CREATE_IN_FOLDER_RESOLVE,
    'Confirmed archive conflict was not preserved for creation.');
  start();
  await tick();
  requests[5].reply({ path: '/projects/broken', status: ProjectCreateStatus.PROJECT_INVALID_DATABASE, error: 'invalid archive' });
  check(notifications[1]?.type === 'error' && prompts.length === 3, 'Invalid archive did not report an error.');
  start();
  await tick();
  check(requests.length === 6, 'Cancelled picker opened a project.');
  start();
  await tick();
  requests[6].reply({ path: '/projects/cancelled', status: ProjectCreateStatus.PROJECT_INVALID_DATABASE, error: 'invalid' });
  prompts[3].onResponse('cancel');
  check(requests.length === 7, 'Cancelled database prompt created a project.');

  const otherPrompts: PromptOptions[] = [];
  const otherKinds: string[] = [];
  const other = createOpenProjectWorkflow(
    async (kind) => { otherKinds.push(kind); return null; },
    () => { throw new Error('Cancelled picker sent a request.'); },
    (prompt) => otherPrompts.push(prompt),
    (notification) => { throw new Error(notification.title); },
    'win32',
  );
  other();
  check(otherPrompts[0]?.buttons.length === 2, 'Platform requiring separate pickers did not ask for type.');
  otherPrompts[0].onResponse('archive');
  await tick();
  check(otherKinds[0] === 'archive', 'Archive picker was not selected.');
}
