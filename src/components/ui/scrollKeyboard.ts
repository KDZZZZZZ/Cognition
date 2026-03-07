import type { KeyboardEvent } from 'react';

export function handleScrollableKeyDown(event: KeyboardEvent<HTMLElement>) {
  const element = event.currentTarget;
  const pageStep = Math.max(80, Math.round(element.clientHeight * 0.85));

  if (event.key === 'PageDown' || (event.key === ' ' && !event.shiftKey)) {
    element.scrollBy({ top: pageStep, left: 0 });
    event.preventDefault();
    return;
  }

  if (event.key === 'PageUp' || (event.key === ' ' && event.shiftKey)) {
    element.scrollBy({ top: -pageStep, left: 0 });
    event.preventDefault();
    return;
  }

  if (event.key === 'Home') {
    element.scrollTo({ top: 0, left: 0 });
    event.preventDefault();
    return;
  }

  if (event.key === 'End') {
    element.scrollTo({ top: element.scrollHeight, left: 0 });
    event.preventDefault();
  }
}
