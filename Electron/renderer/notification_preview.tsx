import { useCallback, useEffect } from 'react';
import { useNotifications } from './notifications';

export default function NotificationPreview(): null {
  const notify = useNotifications();
  const showPreview = useCallback(() => {
    notify({ type: 'info', title: 'Information', description: 'This is an informational notification.' });
    notify({ type: 'success', title: 'Success', description: 'This is a success notification.' });
    notify({ type: 'warning', title: 'Warning', description: 'This is a warning notification.' });
    notify({ type: 'error', title: 'Error', description: 'This is an error notification.' });
  }, [notify]);

  useEffect(() => {
    showPreview();
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'n' && !event.repeat) {
        event.preventDefault();
        showPreview();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showPreview]);

  return null;
}
