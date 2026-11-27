import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import ErrorIcon from '@mui/icons-material/Error';
import WarningIcon from '@mui/icons-material/Warning';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import InfoIcon from '@mui/icons-material/Info';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CloseIcon from '@mui/icons-material/Close';
import { gsap } from 'gsap';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface NotificationOptions {
  type: NotificationType;
  title: string;
  description?: string;
  icon?: React.ReactNode;
  timeoutMs?: number | null;
}

interface Notification extends NotificationOptions {
  id: number;
  timeoutMs: number | null;
}

interface NotificationState {
  visible: Notification[];
  pending: Notification[];
  hoveredId: number | null;
}

const maximumVisible = 5;
const animationDuration = 0.3;
const defaultIcons: Record<NotificationType, React.JSX.Element> = {
  info: <InfoIcon />,
  success: <CheckBoxIcon />,
  warning: <WarningIcon />,
  error: <ErrorIcon />,
};
const NotificationContext = createContext<((options: NotificationOptions) => void) | null>(null);

function reduceMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function fillVisible(state: NotificationState): NotificationState {
  if (state.hoveredId !== null) return state;
  const count = Math.max(0, maximumVisible - state.visible.length);
  return {
    ...state,
    visible: [...state.visible, ...state.pending.slice(0, count)],
    pending: state.pending.slice(count),
  };
}

function NotificationCard({ notification, hovered, onHover, onDismiss }: {
  notification: Notification;
  hovered: boolean;
  onHover: (id: number | null) => void;
  onDismiss: (id: number) => void;
}): React.JSX.Element {
  const [timerCycle, setTimerCycle] = useState(0);
  const [exiting, setExiting] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const icon = notification.icon === undefined ? defaultIcons[notification.type] : notification.icon;

  const copyNotification = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(
        notification.description ? `${notification.title}\n${notification.description}` : notification.title,
      );
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  };

  useLayoutEffect(() => {
    if (!exiting || !cardRef.current) return;
    if (reduceMotion()) {
      onDismiss(notification.id);
      return;
    }
    const tween = gsap.to(cardRef.current, {
      opacity: 0,
      duration: animationDuration,
      ease: 'power2.inOut',
      overwrite: 'auto',
      onComplete: () => onDismiss(notification.id),
    });
    return () => { tween.kill(); };
  }, [exiting, notification.id, onDismiss]);

  useEffect(() => {
    const timeoutMs = notification.timeoutMs;
    if (hovered || exiting || timeoutMs === null) return;
    const start = performance.now();
    let timer: number;
    const tick = () => {
      const remaining = timeoutMs - (performance.now() - start);
      if (remaining <= 0) setExiting(true);
      else timer = window.setTimeout(tick, Math.min(remaining, 2147483647));
    };
    timer = window.setTimeout(tick, Math.min(timeoutMs, 2147483647));
    return () => window.clearTimeout(timer);
  }, [hovered, exiting, notification.timeoutMs, timerCycle]);

  return (
    <Paper
      ref={cardRef}
      className="notification"
      elevation={0}
      data-notification-id={notification.id}
      data-notification-type={notification.type}
      onMouseEnter={() => { if (!exiting) onHover(notification.id); }}
      onMouseLeave={(event) => {
        const next = event.relatedTarget instanceof Element
          ? event.relatedTarget.closest<HTMLElement>('[data-notification-id]')
          : null;
        const nextId = next?.dataset.notificationId;
        onHover(nextId === undefined ? null : Number(nextId));
        setTimerCycle((cycle) => cycle + 1);
      }}
    >
      <div className="notification-content" role={notification.type === 'error' || notification.type === 'warning' ? 'alert' : 'status'}>
        {icon != null && <span className="notification-icon" aria-hidden="true">{icon}</span>}
        <div className="notification-text">
          <div className="notification-title">{notification.title}</div>
          {notification.description && <div className="notification-description">{notification.description}</div>}
          {copyFailed && <div className="notification-copy-error" role="alert">Could not copy notification.</div>}
        </div>
      </div>
      <div className="notification-actions">
        <IconButton
          aria-label={`Copy ${notification.title}`}
          size="small"
          disabled={exiting}
          onClick={() => { void copyNotification(); }}
        >
          <ContentCopyIcon />
        </IconButton>
        <IconButton
          aria-label={`Dismiss ${notification.title}`}
          size="small"
          disabled={exiting}
          onClick={() => setExiting(true)}
        >
          <CloseIcon />
        </IconButton>
      </div>
      {notification.timeoutMs !== null && (
        <div className="notification-progress-track" aria-hidden="true" style={{ visibility: hovered ? 'hidden' : 'visible' }}>
          <div
            key={timerCycle}
            className="notification-progress"
            style={{
              animationDuration: `${notification.timeoutMs}ms`,
              animationPlayState: hovered ? 'paused' : 'running',
            }}
          />
        </div>
      )}
    </Paper>
  );
}

export function NotificationProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const nextId = useRef(0);
  const stackRef = useRef<HTMLElement>(null);
  const previousPositions = useRef<Map<string, number> | null>(null);
  const [state, setState] = useState<NotificationState>({ visible: [], pending: [], hoveredId: null });

  const capturePositions = useCallback((): void => {
    const cards = stackRef.current?.querySelectorAll<HTMLElement>('[data-notification-id]');
    previousPositions.current = new Map(
      Array.from(cards ?? [], (card) => [card.dataset.notificationId!, card.getBoundingClientRect().top]),
    );
  }, []);

  useLayoutEffect(() => {
    const stack = stackRef.current;
    const positions = previousPositions.current;
    previousPositions.current = null;
    if (!stack || !positions || reduceMotion()) return;
    const cards = Array.from(stack.querySelectorAll<HTMLElement>('[data-notification-id]'));
    for (const card of cards) {
      gsap.killTweensOf(card, 'y');
      gsap.set(card, { y: 0 });
    }
    for (const card of cards) {
      const previousTop = positions.get(card.dataset.notificationId!);
      if (previousTop === undefined) {
        gsap.fromTo(card, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: animationDuration, ease: 'power2.inOut' });
      } else {
        const offset = previousTop - card.getBoundingClientRect().top;
        if (offset) gsap.fromTo(card, { y: offset }, { y: 0, duration: animationDuration, ease: 'power2.inOut' });
      }
    }
  }, [state.visible]);

  useLayoutEffect(() => {
    const stack = stackRef.current;
    return () => { if (stack) gsap.killTweensOf(stack.querySelectorAll('[data-notification-id]')); };
  }, []);

  const notify = useCallback((options: NotificationOptions): void => {
    const timeoutMs = options.timeoutMs === undefined ? 4000 : options.timeoutMs;
    if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
      throw new RangeError('Notification timeout must be a positive finite number or null.');
    if (!options.title.trim()) throw new Error('Notification title must not be empty.');
    const notification: Notification = { ...options, timeoutMs, id: ++nextId.current };
    capturePositions();
    setState((current) => fillVisible({ ...current, pending: [...current.pending, notification] }));
  }, [capturePositions]);

  const onHover = useCallback((hoveredId: number | null): void => {
    capturePositions();
    setState((current) => fillVisible({ ...current, hoveredId }));
  }, [capturePositions]);

  const onDismiss = useCallback((id: number): void => {
    capturePositions();
    setState((current) => fillVisible({
      ...current,
      visible: current.visible.filter((notification) => notification.id !== id),
      hoveredId: current.hoveredId === id ? null : current.hoveredId,
    }));
  }, [capturePositions]);

  return (
    <NotificationContext.Provider value={notify}>
      {children}
      <section ref={stackRef} className="notification-stack" aria-label="Notifications">
        {[...state.visible].reverse().map((notification) => (
          <NotificationCard
            key={notification.id}
            notification={notification}
            hovered={state.hoveredId === notification.id}
            onHover={onHover}
            onDismiss={onDismiss}
          />
        ))}
      </section>
    </NotificationContext.Provider>
  );
}

export function useNotifications(): (options: NotificationOptions) => void {
  const notify = useContext(NotificationContext);
  if (!notify) throw new Error('useNotifications must be used inside NotificationProvider.');
  return notify;
}
