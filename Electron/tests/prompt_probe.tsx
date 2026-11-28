import React from 'react';
import { createRoot } from 'react-dom/client';
import { PromptProvider, usePrompts, type PromptOptions } from '../renderer/prompts';
import { createMessageHandler } from '../renderer/message_handler';
import { parseFrame } from '../renderer/message';

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function testPrompts(): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let worker: Worker | undefined;
  let showPrompt: ((options: PromptOptions) => void) | undefined;
  const responses: (string | null)[] = [];
  function Capture(): null {
    showPrompt = usePrompts();
    return null;
  }
  const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]');
  const waitFor = async (condition: () => boolean, message: string) => {
    for (let attempt = 0; attempt < 100 && !condition(); attempt++) await delay(20);
    check(condition(), message);
  };
  const makePrompt = (title: string, extra: Partial<PromptOptions> = {}): PromptOptions => ({
    title,
    buttons: [{ label: 'Choose', value: 'chosen' }],
    onResponse: (value) => responses.push(value),
    ...extra,
  });

  try {
    root.render(<PromptProvider><Capture /></PromptProvider>);
    await waitFor(() => showPrompt !== undefined, 'Prompt provider did not mount.');
    check(showPrompt, 'Prompt API is unavailable.');
    showPrompt(makePrompt('First prompt', { description: 'First description' }));
    showPrompt(makePrompt('Second prompt', { dismissible: false }));
    await waitFor(() => !!dialog(), 'Prompt was not displayed.');
    const first = dialog();
    check(first, 'First prompt was not found.');
    check(host.querySelectorAll('[role="dialog"]').length === 1, 'More than one prompt was displayed.');
    check(first.textContent?.includes('First description') && !first.textContent.includes('Second prompt'),
      'Prompt queue or description is incorrect.');
    check(!first.hasAttribute('aria-modal'), 'Non-modal prompt was marked as modal.');
    check(getComputedStyle(first).backgroundColor === 'rgb(26, 26, 26)', 'Prompt background is incorrect.');
    const initial = first.getBoundingClientRect();
    check(Math.abs(initial.left + initial.width / 2 - window.innerWidth / 2) < 1 &&
      Math.abs(initial.top + initial.height / 2 - window.innerHeight / 2) < 1, 'Prompt is not centered.');

    first.setPointerCapture = () => {};
    first.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, pointerId: 987, button: 0, clientX: initial.left + 20, clientY: initial.top + 20,
    }));
    first.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, pointerId: 987, clientX: initial.left + 80, clientY: initial.top + 50,
    }));
    await waitFor(() => first.getBoundingClientRect().left > initial.left + 50, 'Prompt did not drag.');
    first.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 987 }));
    const moved = first.getBoundingClientRect();
    check(Math.abs(moved.top - initial.top - 30) < 1, `Prompt dragged to the wrong position: ${initial.top} -> ${moved.top}.`);

    const choose = [...first.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Choose');
    check(choose, 'Choice button was not found.');
    choose.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, button: 0 }));
    first.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 2, clientX: 0, clientY: 0 }));
    await delay(20);
    check(Math.abs(first.getBoundingClientRect().left - moved.left) < 1, 'Button interaction dragged the prompt.');
    choose.click();
    choose.click();
    await waitFor(() => !!dialog()?.textContent?.includes('Second prompt'), 'Queued prompt did not appear.');
    check(responses.length === 1 && responses[0] === 'chosen', 'Choice response was incorrect or repeated.');
    const second = dialog();
    check(second && !second.querySelector('[aria-label^="Dismiss "]'), 'Non-dismissible prompt has a close button.');
    check(!second.querySelector('.prompt-description'), 'Absent description was rendered.');
    const secondBounds = second.getBoundingClientRect();
    check(Math.abs(secondBounds.left + secondBounds.width / 2 - window.innerWidth / 2) < 1,
      'Queued prompt did not start centered.');
    const secondButton = second.querySelector<HTMLButtonElement>('button');
    check(secondButton, 'Second choice button was not found.');
    secondButton.click();
    await waitFor(() => !dialog(), 'Second prompt did not close.');
    check(responses[1] === 'chosen', 'Queued prompt response was incorrect.');

    showPrompt(makePrompt('Closable prompt'));
    await waitFor(() => !!dialog(), 'Closable prompt was not displayed.');
    const close = dialog()?.querySelector<HTMLButtonElement>('[aria-label="Dismiss Closable prompt"]');
    check(close, 'Default close button was not displayed.');
    close.click();
    await waitFor(() => !dialog(), 'Close button did not dismiss prompt.');
    check(responses[2] === null, 'Close button did not report cancellation.');

    worker = new Worker(new URL('../renderer/message_worker.ts', import.meta.url), { type: 'module' });
    const handler = createMessageHandler((frame) => {
      const bytes = Uint8Array.from(frame);
      worker!.postMessage({ type: 'send', frame: bytes.buffer }, [bytes.buffer]);
    }, () => {}, showPrompt);
    worker.addEventListener('message', ({ data }) => {
      if (data.type === 'message') handler.onMessage(parseFrame(new Uint8Array(data.frame)));
    });
    const requestId = handler.requestPrompt({
      title: 'Local prompt',
      buttons: [{ label: 'Local choice', value: 'local-value' }],
    });
    await waitFor(() => !!dialog()?.textContent?.includes('Local prompt'), 'Renderer prompt message did not reach the UI.');
    const localButton = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Local choice');
    check(localButton, 'Local prompt button was not found.');
    localButton.click();
    let localResult = handler.takePromptResult(requestId);
    await waitFor(() => {
      localResult ??= handler.takePromptResult(requestId);
      return localResult !== undefined;
    }, 'Renderer did not receive its prompt response.');
    check(localResult?.value === 'local-value', 'Renderer prompt response was incorrect.');
  } finally {
    worker?.terminate();
    root.unmount();
    host.remove();
  }
}
