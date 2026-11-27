import { createContext, useContext } from 'react';
import type { PromptOptions } from './prompts';

export type RequestPrompt = (
  options: Omit<PromptOptions, 'onResponse'>,
  callback: (value: string | null, error?: string) => void,
) => void;

export const PromptMessagesContext = createContext<RequestPrompt | null>(null);

export function usePromptMessages(): RequestPrompt {
  const request = useContext(PromptMessagesContext);
  if (!request) throw new Error('Prompt messaging is unavailable.');
  return request;
}
