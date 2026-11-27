import { useCallback, useEffect } from 'react';
import { usePrompts } from './prompts';

export default function PromptPreview(): null {
  const showPrompt = usePrompts();
  const showPreview = useCallback(() => {
    showPrompt({
      title: 'Example prompt',
      description: 'This is an example of a prompt with multiple choices.',
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Continue', value: 'continue' },
      ],
      onResponse: (value) => console.info('Prompt preview response:', value),
    });
  }, [showPrompt]);

  useEffect(() => {
    showPreview();
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'p' && !event.repeat) {
        event.preventDefault();
        showPreview();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showPreview]);

  return null;
}
