import { type ClassValue, clsx } from 'clsx';
import type { ReactNode } from 'react';

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function parseBold(text: string): ReactNode {
  const parts = text.split(/(\*\*.*?\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}
