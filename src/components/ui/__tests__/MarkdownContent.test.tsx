import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from '../MarkdownContent';

describe('MarkdownContent', () => {
  it('renders note callouts as dedicated cards without the raw marker', () => {
    const { container } = render(
      <MarkdownContent content={'> [!NOTE] Draft note\n> Callout body with **bold** text'} />
    );

    expect(screen.getByText('Note')).toBeInTheDocument();
    expect(container.textContent).toContain('Callout body with bold text');
    expect(screen.getByText('bold')).toBeInTheDocument();
    expect(container.textContent).not.toContain('[!NOTE]');
    expect(container.querySelector('aside')).not.toBeNull();
  });

  it('renders fenced code blocks with syntax highlight classes', () => {
    const { container } = render(
      <MarkdownContent content={'```ts\nconst answer = 42;\n```'} />
    );

    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.querySelector('code.hljs')).not.toBeNull();
    expect(container.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(container.querySelector('.hljs-number')?.textContent).toBe('42');
  });
});
