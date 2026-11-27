import React from 'react';
import { createRoot } from 'react-dom/client';
import { NotificationProvider, useNotifications, type NotificationOptions } from '../renderer/notifications';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function testNotifications(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const clipboard = navigator.clipboard;
  check(clipboard, 'Clipboard API is unavailable.');
  const originalWriteText = Object.getOwnPropertyDescriptor(clipboard, 'writeText');
  const copied: string[] = [];
  let rejectCopy = false;
  Object.defineProperty(clipboard, 'writeText', {
    configurable: true,
    value: async (text: string) => {
      if (rejectCopy) throw new Error('Clipboard unavailable');
      copied.push(text);
    },
  });
  let notify: ((options: NotificationOptions) => void) | undefined;
  function Capture(): null {
    notify = useNotifications();
    return null;
  }
  const cards = () => [...host.querySelectorAll<HTMLElement>('[data-notification-id]')];
  const card = (title: string) => cards().find((element) => element.querySelector('.notification-title')?.textContent === title);
  const waitFor = async (condition: () => boolean, message: string) => {
    for (let attempt = 0; attempt < 100 && !condition(); attempt++) await delay(20);
    check(condition(), message);
  };

  try {
    root.render(<NotificationProvider><Capture /></NotificationProvider>);
    await waitFor(() => notify !== undefined, 'Notification provider did not mount.');
    check(notify, 'Notification API is unavailable.');

    notify({ type: 'info', title: 'First arrival', timeoutMs: null });
    await waitFor(() => !!card('First arrival'), 'First arrival did not appear.');
    const stack = host.querySelector<HTMLElement>('.notification-stack');
    check(stack, 'Notification stack was not found.');
    check(getComputedStyle(stack).scrollbarWidth === 'none', 'Notification scrollbar is visible.');
    check(getComputedStyle(stack).pointerEvents === 'none', 'Empty stack space intercepts pointer input.');
    await delay(400);
    const first = card('First arrival');
    check(first, 'First arrival disappeared.');
    check(first.querySelector('.notification-icon svg[data-testid="InfoIcon"]'), 'Info icon was not rendered.');
    check(getComputedStyle(first.querySelector<HTMLElement>('.notification-icon')!).color === 'rgb(230, 230, 230)',
      'Info icon color is incorrect.');
    const firstCopy = first.querySelector<HTMLButtonElement>('[aria-label="Copy First arrival"]');
    check(firstCopy, 'Copy button was not found.');
    check(firstCopy.querySelector('svg[data-testid="ContentCopyIcon"]'), 'Copy icon was not rendered.');
    const firstDismiss = first.querySelector<HTMLButtonElement>('[aria-label="Dismiss First arrival"]');
    check(firstDismiss?.querySelector('svg[data-testid="CloseIcon"]'), 'Close icon was not rendered.');
    check(firstDismiss && firstCopy.getBoundingClientRect().right <= firstDismiss.getBoundingClientRect().left,
      'Copy button is not to the left of the close button.');
    firstCopy.click();
    await waitFor(() => copied.length === 1, 'Notification was not copied.');
    check(copied[0] === 'First arrival', 'Title-only notification was copied incorrectly.');
    rejectCopy = true;
    firstCopy.click();
    await waitFor(() => !!first.querySelector('.notification-copy-error[role="alert"]'), 'Clipboard failure was not displayed.');
    rejectCopy = false;
    firstCopy.click();
    await waitFor(() => !first.querySelector('.notification-copy-error'), 'Copy error was not cleared after retry.');
    const initialTop = first.getBoundingClientRect().top;
    notify({ type: 'info', title: 'Second arrival', description: 'Second description', timeoutMs: null });
    await waitFor(() => !!card('Second arrival'), 'Second arrival did not appear.');
    const second = card('Second arrival');
    check(second, 'Second arrival disappeared.');
    const secondCopy = second.querySelector<HTMLButtonElement>('[aria-label="Copy Second arrival"]');
    check(secondCopy, 'Second copy button was not found.');
    secondCopy.click();
    await waitFor(() => copied.length === 3, 'Notification description was not copied.');
    check(copied[2] === 'Second arrival\nSecond description', 'Notification title and description were copied incorrectly.');
    await delay(100);
    const movingTop = first.getBoundingClientRect().top;
    check(stack.scrollHeight <= stack.clientHeight, 'Moving notifications caused unnecessary scrolling.');
    check(Number(getComputedStyle(second).opacity) > 0 && Number(getComputedStyle(second).opacity) < 1,
      'New notification did not animate in.');
    await delay(350);
    const finalTop = first.getBoundingClientRect().top;
    check(finalTop < movingTop && movingTop < initialTop, 'Previous notification did not ease upward.');
    check(finalTop < second.getBoundingClientRect().top, 'New notification was not at the bottom.');
    stack.style.maxHeight = '50px';
    check(stack.scrollHeight > stack.clientHeight, 'Overflowing notification stack was not scrollable.');
    stack.scrollTop = -30;
    check(stack.scrollTop < 0, 'Hidden scrollbar prevented scrolling.');
    stack.style.maxHeight = '';
    stack.scrollTop = 0;
    const secondClose = second.querySelector<HTMLButtonElement>('[aria-label="Dismiss Second arrival"]');
    check(secondClose, 'Second arrival dismiss button was not found.');
    secondClose.click();
    await delay(100);
    const fadingOpacity = Number(getComputedStyle(second).opacity);
    check(card('Second arrival') && fadingOpacity > 0 && fadingOpacity < 1, 'Dismissed notification did not fade out.');
    await waitFor(() => !card('Second arrival'), 'Faded notification was not removed.');
    await delay(60);
    check(stack.scrollHeight <= stack.clientHeight, 'Notifications sliding down caused unnecessary scrolling.');
    check(getComputedStyle(stack).scrollbarWidth === 'none', 'Scrollbar appeared while notifications slid down.');
    const firstClose = first.querySelector<HTMLButtonElement>('[aria-label="Dismiss First arrival"]');
    check(firstClose, 'First arrival dismiss button was not found.');
    firstClose.click();
    await waitFor(() => !card('First arrival'), 'First arrival was not removed.');

    notify({ type: 'info', title: 'Hovered', description: 'Long description', timeoutMs: 1200 });
    notify({ type: 'success', title: 'Other', timeoutMs: 900 });
    await waitFor(() => cards().length === 2, 'Initial notifications did not appear.');
    const hovered = card('Hovered');
    check(hovered, 'Hovered notification was not found.');
    check(hovered.querySelector('.notification-description')?.textContent === 'Long description',
      'Notification description was not rendered.');
    check(getComputedStyle(hovered).backgroundColor === 'rgb(26, 26, 26)', 'Notification background is incorrect.');
    check(getComputedStyle(hovered).color === 'rgb(230, 230, 230)', 'Notification text color is incorrect.');
    const progress = hovered.querySelector<HTMLElement>('.notification-progress');
    check(progress, 'Timed notification has no progress bar.');
    check(getComputedStyle(progress).visibility === 'visible', 'Progress bar is not initially visible.');
    const otherProgress = card('Other')?.querySelector<HTMLElement>('.notification-progress');
    check(otherProgress, 'Other timed notification has no progress bar.');
    check(card('Other')?.querySelector('.notification-icon svg[data-testid="CheckBoxIcon"]'), 'Success icon was not rendered.');
    check(getComputedStyle(card('Other')!.querySelector<HTMLElement>('.notification-icon')!).color === 'rgb(13, 242, 5)',
      'Success icon color is incorrect.');
    check(getComputedStyle(otherProgress).backgroundColor === 'rgb(13, 242, 5)', 'Success progress color is incorrect.');
    check(getComputedStyle(progress).backgroundColor === 'rgb(230, 230, 230)', 'Info progress color is incorrect.');
    check(getComputedStyle(progress).animationDuration === '1.2s', 'Custom timeout is not reflected in the progress bar.');
    const closeDisplay = getComputedStyle(hovered.querySelector<HTMLElement>('button')!).display;
    check(closeDisplay === 'flex' || closeDisplay === 'inline-flex', `MUI button styles were not applied: ${closeDisplay}.`);
    await delay(700);
    hovered.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    await delay(60);
    check(getComputedStyle(progress).visibility === 'hidden', 'Progress bar remained visible while hovered.');
    check(getComputedStyle(otherProgress).visibility === 'visible', 'Hover hid another notification progress bar.');
    const pausedAt = getComputedStyle(progress).transform;
    await delay(300);
    check(getComputedStyle(progress).transform === pausedAt, 'Progress continued while hovered.');
    await waitFor(() => {
      const other = card('Other');
      const opacity = other && Number(getComputedStyle(other).opacity);
      return opacity !== undefined && opacity > 0 && opacity < 1;
    }, 'Expired notification did not fade out.');
    await waitFor(() => !card('Other'), 'Another notification did not time out during hover.');

    for (let index = 1; index <= 5; index++) {
      notify({ type: 'warning', title: `Pending ${index}`, timeoutMs: index === 2 ? 8000 : null,
        icon: index === 1 ? <span data-probe-icon="true" /> : index === 3 ? null : undefined });
    }
    await delay(60);
    check(cards().length === 1 && card('Hovered'), 'New notifications appeared during hover.');

    hovered.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    await waitFor(() => cards().length === 5, 'Pending notifications did not fill available slots.');
    const restartedProgress = hovered.querySelector<HTMLElement>('.notification-progress');
    check(restartedProgress && restartedProgress !== progress, 'Progress did not restart after hover.');
    check(getComputedStyle(restartedProgress).visibility === 'visible', 'Progress bar did not reappear after hover.');
    check(!card('Pending 5'), 'The visible notification limit was exceeded.');
    check(card('Pending 1')?.querySelector('[data-probe-icon]'), 'Optional notification icon was not rendered.');
    check(!card('Pending 1')?.querySelector('.notification-icon svg'), 'Custom icon did not replace the default.');
    check(card('Pending 2')?.querySelector('.notification-icon svg[data-testid="WarningIcon"]'), 'Warning icon was not rendered.');
    check(getComputedStyle(card('Pending 2')!.querySelector<HTMLElement>('.notification-icon')!).color === 'rgb(242, 226, 5)',
      'Warning icon color is incorrect.');
    check(getComputedStyle(card('Pending 2')!.querySelector<HTMLElement>('.notification-progress')!).backgroundColor === 'rgb(242, 226, 5)',
      'Warning progress color is incorrect.');
    check(!card('Pending 3')?.querySelector('.notification-icon'), 'Null icon did not hide the default.');
    check(!card('Pending 1')?.querySelector('.notification-progress'), 'Persistent notification has a progress bar.');
    check(cards()[0].getBoundingClientRect().top > cards()[4].getBoundingClientRect().top,
      'Notifications did not stack with the newest at the bottom.');
    const close = card('Pending 1')?.querySelector<HTMLButtonElement>('[aria-label="Dismiss Pending 1"]');
    check(close, 'Dismiss button was not found.');
    close.click();
    await delay(100);
    check(card('Pending 1') && !card('Pending 5'), 'Fading notification released its slot too early.');
    await waitFor(() => !!card('Pending 5'), 'Dismissing a notification did not release the next pending item.');
    check(cards().length === 5 && !card('Pending 1'), 'Dismissal did not preserve the visible limit.');
    await delay(700);
    check(card('Hovered'), 'The hovered notification did not restart its full timeout.');
    await waitFor(() => !card('Hovered'), 'The restarted timeout did not dismiss the notification.');
    check(card('Pending 4'), 'Persistent notification was dismissed automatically.');

    notify({ type: 'error', title: 'Default timeout' });
    await waitFor(() => !!card('Default timeout'), 'Default-timeout notification was not shown.');
    check(card('Default timeout')?.querySelector('.notification-icon svg[data-testid="ErrorIcon"]'), 'Error icon was not rendered.');
    check(getComputedStyle(card('Default timeout')!.querySelector<HTMLElement>('.notification-icon')!).color === 'rgb(242, 5, 5)',
      'Error icon color is incorrect.');
    const defaultProgress = card('Default timeout')?.querySelector<HTMLElement>('.notification-progress');
    check(defaultProgress && getComputedStyle(defaultProgress).animationDuration === '4s', 'Default timeout is not four seconds.');
    check(getComputedStyle(defaultProgress).backgroundColor === 'rgb(242, 5, 5)', 'Error progress color is incorrect.');
    check(!card('Default timeout')?.querySelector('.notification-description'), 'Absent description was rendered.');
    const persistentClose = card('Pending 2')?.querySelector<HTMLButtonElement>('[aria-label="Dismiss Pending 2"]');
    check(persistentClose, 'Persistent notification dismiss button was not found.');
    persistentClose.click();
    notify({ type: 'info', title: 'Long timeout', timeoutMs: 8000 });
    await waitFor(() => !!card('Long timeout'), 'Long-timeout notification was not shown.');
    const longProgress = card('Long timeout')?.querySelector<HTMLElement>('.notification-progress');
    check(longProgress && getComputedStyle(longProgress).animationDuration === '8s', 'Long timeout was not applied.');
    let rejected = false;
    try {
      notify({ type: 'info', title: 'Invalid', timeoutMs: 0 });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      rejected = true;
    }
    check(rejected, 'Invalid timeout was not rejected.');
  } finally {
    root.unmount();
    host.remove();
    if (originalWriteText) Object.defineProperty(clipboard, 'writeText', originalWriteText);
    else Reflect.deleteProperty(clipboard, 'writeText');
  }
}
