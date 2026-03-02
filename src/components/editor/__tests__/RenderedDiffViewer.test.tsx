import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RenderedDiffViewer } from '../RenderedDiffViewer';

describe('RenderedDiffViewer', () => {
  it('renders inline mode with added/removed blocks and markdown features', () => {
    render(
      <RenderedDiffViewer
        oldContent={['# Title', '', 'old paragraph', '', '```ts', 'const a = 1', '```'].join('\n')}
        newContent={[
          '# Title',
          '',
          'new paragraph with `code`',
          '',
          '<span data-latex="x+y" data-display="yes"></span>',
        ].join('\n')}
        mode="inline"
      />
    );

    expect(screen.getAllByText('Added').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Removed').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText((_, element) => element?.textContent?.includes('new paragraph with code') ?? false).length
    ).toBeGreaterThan(0);
  });

  it('renders split mode and empty side placeholders', () => {
    render(
      <RenderedDiffViewer
        oldContent={'line A\n\nline B'}
        newContent={'line A\n\nline C\n\nline D'}
        mode="split"
      />
    );

    expect(screen.getByText('Original')).toBeInTheDocument();
    expect(screen.getByText('Modified')).toBeInTheDocument();
    expect(screen.getByText('line B')).toBeInTheDocument();
    expect(screen.getByText('line C')).toBeInTheDocument();
  });
});
