import { createContext, useContext } from 'react';
import type { PromptOptions } from './prompts';
import type { PromptResult } from '../shared/types';

export interface PromptMessages {
  requestPrompt: (options: Omit<PromptOptions, 'onResponse'>) => string;
  takePromptResult: (requestId: string) => PromptResult | undefined;
}

export const PromptMessagesContext = createContext<PromptMessages | null>(null);

export function usePromptMessages(): PromptMessages {
  const messages = useContext(PromptMessagesContext);
  if (!messages) throw new Error('Prompt messaging is unavailable.');
  return messages;
}
