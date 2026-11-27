import { createProjectWorkflow } from '../renderer/project_creation';
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
  const prompts: PromptOptions[] = [];
  const notifications: NotificationOptions[] = [];
  const pickerDefaults: (string | undefined)[] = [];
  const start = createProjectWorkflow(
    async (previousPath) => {
      pickerDefaults.push(previousPath);
      return paths.shift() ?? null;
    },
    (path, choice, reply) => requests.push({ path, choice, reply }),
    (prompt) => prompts.push(prompt),
    (notification) => notifications.push(notification),
  );
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  start();
  await tick();
  check(requests[0] && requests[0].choice === ProjectCreateChoice.PROJECT_CREATE_NEW,
    'New project request was not sent.');
  requests[0].reply({ path: '/projects/existing', status: ProjectCreateStatus.PROJECT_BOTH_CONFLICT, error: '' });
  check(prompts.length === 1 && prompts[0].buttons.length === 2, 'Collision choice was not shown.');
  prompts[0].onResponse('open');
  check(prompts[1], 'Both-existing conflict did not ask which to open.');
  prompts[1].onResponse('folder');
  check(requests[1] && requests[1].choice === ProjectCreateChoice.PROJECT_OPEN_FOLDER,
    'Folder choice was not sent to the Engine.');
  requests[1].reply({ path: '/projects/existing', status: ProjectCreateStatus.PROJECT_CREATE_FAILED, error: 'Invalid project' });
  check(notifications[0]?.type === 'error' && notifications[0].description === 'Invalid project',
    'Project failure was not notified.');
  requests[0].reply({ path: '/projects/existing', status: ProjectCreateStatus.PROJECT_FOLDER_CONFLICT, error: '' });
  prompts[2].onResponse('rename');
  await tick();
  check(requests[2]?.path === '/projects/renamed' && requests[2].choice === ProjectCreateChoice.PROJECT_CREATE_NEW,
    'Rename did not reopen the path picker.');
  check(pickerDefaults[0] === undefined && pickerDefaults[1] === '/projects/existing',
    'Rename did not reuse the conflicting project location.');
  requests[2].reply({ path: '/projects/renamed', status: ProjectCreateStatus.PROJECT_CREATE_SUCCEEDED, error: '' });
  check(notifications[1]?.type === 'success' && notifications[1].description === '/projects/renamed',
    'Project creation was not notified.');
  start();
  await tick();
  check(requests.length === 3 && notifications.length === 2, 'Cancelled dialog started a project.');
  check(pickerDefaults[2] === undefined, 'A new project unexpectedly reused an earlier path.');

  paths.push('/projects/archive');
  start();
  await tick();
  requests[3].reply({ path: '/projects/archive', status: ProjectCreateStatus.PROJECT_ARCHIVE_CONFLICT, error: '' });
  check(prompts[3]?.description?.includes('an archive'), 'Archive conflict was not shown.');
  prompts[3].onResponse('open');
  check(requests[4]?.choice === ProjectCreateChoice.PROJECT_OPEN_EXISTING, 'Archive open was not requested.');
  requests[4].reply({ path: '/projects/archive', status: ProjectCreateStatus.PROJECT_BOTH_CONFLICT, error: '' });
  check(prompts[4]?.description?.includes('working folder and archive'), 'Changed conflict was not rechecked.');
  prompts[4].onResponse('open');
  prompts[5].onResponse('archive');
  check(requests[5]?.choice === ProjectCreateChoice.PROJECT_OPEN_ARCHIVE, 'Archive selection was not sent.');
  requests[5].reply({ path: '/projects/archive', status: ProjectCreateStatus.PROJECT_OPEN_SUCCEEDED, error: '' });
  check(notifications[2]?.title === 'Project opened', 'Opening an existing project was not notified.');

  paths.push('/projects/cancelled');
  start();
  await tick();
  requests[6].reply({ path: '/projects/cancelled', status: ProjectCreateStatus.PROJECT_FOLDER_CONFLICT, error: '' });
  prompts[6].onResponse(null);
  check(requests.length === 7 && notifications.length === 3, 'Dismissed conflict started a project.');
}
