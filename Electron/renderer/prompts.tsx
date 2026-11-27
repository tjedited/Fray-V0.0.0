import React, { createContext, useCallback, useContext, useId, useRef, useState } from 'react';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import CloseIcon from '@mui/icons-material/Close';

export interface PromptOptions {
  title: string;
  description?: string;
  buttons: { label: string; value: string }[];
  dismissible?: boolean;
  onResponse: (value: string | null) => void;
}

interface PromptRequest {
  id: number;
  options: PromptOptions;
  responded: boolean;
}

const PromptContext = createContext<((options: PromptOptions) => void) | null>(null);

function PromptCard({ prompt, onResponse }: {
  prompt: PromptRequest;
  onResponse: (prompt: PromptRequest, value: string | null) => void;
}): React.JSX.Element {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; left: number; top: number } | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  return (
    <Paper
      className="prompt"
      elevation={0}
      role="dialog"
      aria-labelledby={titleId}
      aria-describedby={prompt.options.description ? descriptionId : undefined}
      style={position ? { left: position.x, top: position.y, transform: 'none' } : undefined}
      onPointerDown={(event) => {
        if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: bounds.left, top: bounds.top };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        setPosition({
          x: Math.max(0, Math.min(window.innerWidth - bounds.width, active.left + event.clientX - active.startX)),
          y: Math.max(0, Math.min(window.innerHeight - bounds.height, active.top + event.clientY - active.startY)),
        });
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      <div className="prompt-heading">
        <div className="prompt-title" id={titleId}>{prompt.options.title}</div>
        {prompt.options.dismissible !== false && (
          <IconButton
            className="prompt-close"
            aria-label={`Dismiss ${prompt.options.title}`}
            size="small"
            onClick={() => onResponse(prompt, null)}
          >
            <CloseIcon />
          </IconButton>
        )}
      </div>
      {prompt.options.description && (
        <div className="prompt-description" id={descriptionId}>{prompt.options.description}</div>
      )}
      <div className="prompt-buttons">
        {prompt.options.buttons.map((button, index) => (
          <Button key={index} variant="outlined" onClick={() => onResponse(prompt, button.value)}>
            {button.label}
          </Button>
        ))}
      </div>
    </Paper>
  );
}

export function PromptProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const nextId = useRef(0);
  const [queue, setQueue] = useState<PromptRequest[]>([]);

  const showPrompt = useCallback((options: PromptOptions): void => {
    if (!options.title.trim()) throw new Error('Prompt title must not be empty.');
    if (options.buttons.length === 0 || options.buttons.some((button) => !button.label.trim()))
      throw new Error('A prompt must have at least one labeled button.');
    const prompt = { id: ++nextId.current, options, responded: false };
    setQueue((current) => [...current, prompt]);
  }, []);

  const onResponse = useCallback((prompt: PromptRequest, value: string | null): void => {
    if (prompt.responded) return;
    prompt.responded = true;
    setQueue((current) => current.filter((entry) => entry.id !== prompt.id));
    prompt.options.onResponse(value);
  }, []);

  return (
    <PromptContext.Provider value={showPrompt}>
      {children}
      {queue[0] && <PromptCard key={queue[0].id} prompt={queue[0]} onResponse={onResponse} />}
    </PromptContext.Provider>
  );
}

export function usePrompts(): (options: PromptOptions) => void {
  const showPrompt = useContext(PromptContext);
  if (!showPrompt) throw new Error('usePrompts must be used inside PromptProvider.');
  return showPrompt;
}
