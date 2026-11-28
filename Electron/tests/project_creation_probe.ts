import { createProjectWorkflow } from '../renderer/message_handler';
import { ProjectCreateChoice, ProjectCreateStatus } from '../renderer/message_schema';
import type { ProjectCreateReply } from '../renderer/message_handler';
import type { NotificationOptions } from '../renderer/notifications';
import type { PromptOptions } from '../renderer/prompts';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function testProjectCreation(): Promise<void> {
  const paths = ['/projects/existing', '/projects/renamed', null];
  const requests: { path: string; choice: number; reply: (result: ProjectCreateReply) => void }[] = [];
  const prompts: Omit<PromptOptions, 'onResponse'>[] = [];
  const notifications: NotificationOptions[] = [];
  const pickerDefaults: (string | undefined)[] = [];
  const workflow = createProjectWorkflow(
    (previousPath) => {
      pickerDefaults.push(previousPath);
      const selection = paths.shift() ?? null;
      queueMicrotask(() => workflow.onPath({ selection }));
    },
    (path, choice) => {
      const id = String(requests.length);
      requests.push({ path, choice, reply: (result) => { workflow.onResult(id, result); } });
      return id;
    },
    (prompt) => { prompts.push(prompt); return String(prompts.length - 1); },
    (notification) => notifications.push(notification),
  );
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  workflow.start();
  await tick();
  check(requests[0] && requests[0].choice === ProjectCreateChoice.PROJECT_CREATE_NEW,
    'New project request was not sent.');
  requests[0].reply({ path: '/projects/existing', status: ProjectCreateStatus.PROJECT_BOTH_CONFLICT, error: '' });
  check(prompts.length === 1 && prompts[0].buttons.length === 2, 'Collision choice was not shown.');
  workflow.onPromptResult('0', 'open');
  check(prompts[1], 'Both-existing conflict did not ask which to open.');
  workflow.onPromptResult('1', 'folder');
  check(requests[1] && requests[1].choice === ProjectCreateChoice.PROJECT_OPEN_FOLDER,
    'Folder choice was not sent to the Engine.');
  requests[1].reply({ path: '/projects/existing', status: ProjectCreateStatus.PROJECT_FOLDER_CONFLICT, error: '' });
  workflow.onPromptResult('2', 'rename');
  await tick();
  check(requests[2]?.path === '/projects/renamed' && requests[2].choice === ProjectCreateChoice.PROJECT_CREATE_NEW,
    'Rename did not reopen the path picker.');
  check(pickerDefaults[0] === undefined && pickerDefaults[1] === '/projects/existing',
    'Rename did not reuse the conflicting project location.');
  requests[2].reply({ path: '/projects/renamed', status: ProjectCreateStatus.PROJECT_CREATE_SUCCEEDED, error: '' });
  check(notifications[0]?.type === 'success' && notifications[0].description === '/projects/renamed',
    'Project creation was not notified.');
  workflow.start();
  await tick();
  check(requests.length === 3 && notifications.length === 1, 'Cancelled dialog started a project.');
  check(pickerDefaults[2] === undefined, 'A new project unexpectedly reused an earlier path.');

  paths.push('/projects/archive');
  workflow.start();
  await tick();
  requests[3].reply({ path: '/projects/archive', status: ProjectCreateStatus.PROJECT_ARCHIVE_CONFLICT, error: '' });
  check(prompts[3]?.description?.includes('an archive'), 'Archive conflict was not shown.');
  workflow.onPromptResult('3', 'open');
  check(requests[4]?.choice === ProjectCreateChoice.PROJECT_OPEN_EXISTING, 'Archive open was not requested.');
  requests[4].reply({ path: '/projects/archive', status: ProjectCreateStatus.PROJECT_BOTH_CONFLICT, error: '' });
  check(prompts[4]?.description?.includes('working folder and archive'), 'Changed conflict was not rechecked.');
  workflow.onPromptResult('4', 'open');
  workflow.onPromptResult('5', 'archive');
  check(requests[5]?.choice === ProjectCreateChoice.PROJECT_OPEN_ARCHIVE, 'Archive selection was not sent.');
  requests[5].reply({ path: '/projects/archive', status: ProjectCreateStatus.PROJECT_OPEN_SUCCEEDED, error: '' });
  check(notifications[1]?.title === 'Project opened', 'Opening an existing project was not notified.');

  paths.push('/projects/cancelled');
  workflow.start();
  await tick();
  requests[6].reply({ path: '/projects/cancelled', status: ProjectCreateStatus.PROJECT_FOLDER_CONFLICT, error: '' });
  workflow.onPromptResult('6', null);
  check(requests.length === 7 && notifications.length === 2, 'Dismissed conflict started a project.');

  paths.push('/projects/first', '/projects/second');
  workflow.start();
  workflow.start();
  await tick();
  check(requests[7]?.path === '/projects/first' && requests[8]?.path === '/projects/second',
    'A new project command was blocked by an unanswered earlier command.');
  workflow.onPath({ selection: null, error: 'Picker failed' });
  check(notifications.at(-1)?.description === 'Picker failed', 'Picker failure was not notified.');
}
