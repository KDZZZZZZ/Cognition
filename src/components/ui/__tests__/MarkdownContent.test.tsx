import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from '../MarkdownContent';

describe('MarkdownContent', () => {
  it('renders note callouts as dedicated cards without the raw marker', () => {
    const { container } = render(
      <MarkdownContent content={'> [!NOTE] Callout body with **bold** text'} />
    );

    expect(screen.getByText('Note')).toBeInTheDocument();
    expect(container.textContent).toContain('Callout body with bold text');
    expect(screen.getByText('bold')).toBeInTheDocument();
    expect(container.textContent).not.toContain('[!NOTE]');
    expect(container.querySelector('aside')).not.toBeNull();
  });
});
