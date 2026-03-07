import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RenderedDiffViewer } from '../RenderedDiffViewer';

describe('RenderedDiffViewer', () => {
  it('renders rendered proposal preview and line-level actions for pending diff rows', () => {
    const onApplyLineDecision = vi.fn();

    const { container } = render(
      <RenderedDiffViewer
        oldContent={['# Title', '', 'old paragraph'].join('\n')}
        newContent={[
          '# Title',
          '',
          'new paragraph with `code`',
          '',
          '$$x+y$$',
        ].join('\n')}
        mode="inline"
        pendingLines={[
          { id: 'line-1', line_no: 1, old_line: '# Title', new_line: '# Title', decision: 'accepted' },
          {
            id: 'line-2',
            line_no: 2,
            old_line: 'old paragraph',
            new_line: 'new paragraph with `code`',
            decision: 'pending',
          },
          { id: 'line-3', line_no: 3, old_line: null, new_line: '$$x+y$$', decision: 'pending' },
        ]}
        onApplyLineDecision={onApplyLineDecision}
      />
    );

    expect(screen.queryByText('Rendered Proposal')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Modified$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Added$/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Accept line 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Reject line 3')).toBeInTheDocument();
    expect(screen.getAllByText((_, element) => element?.textContent?.includes('new paragraph with code') ?? false).length).toBeGreaterThan(0);
    expect(document.querySelector('.katex')).not.toBeNull();

    fireEvent.click(screen.getByLabelText('Accept line 2'));
    expect(onApplyLineDecision).toHaveBeenCalledWith('line-2', 'accepted');

    const highlightedChar = Array.from(container.querySelectorAll('pre span')).find((element) =>
      element.getAttribute('style')?.includes('background-color')
    );
    expect(highlightedChar).not.toBeUndefined();
  });

  it('renders split mode preview with old and new content plus changed lines only', () => {
    render(
      <RenderedDiffViewer
        oldContent={'line A\nline B'}
        newContent={'line A\nline C\nline D'}
        mode="split"
      />
    );

    expect(screen.queryByText('Rendered Original')).not.toBeInTheDocument();
    expect(screen.queryByText('Rendered Modified')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Modified$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Added$/)).not.toBeInTheDocument();
    expect(screen.getAllByText((_, element) => element?.textContent === 'line B').length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, element) => element?.textContent?.includes('line C') ?? false).length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, element) => element?.textContent === 'line D').length).toBeGreaterThan(0);
  });

  it('normalizes serialized math html before rendering diff previews and rows', () => {
    render(
      <RenderedDiffViewer
        oldContent={'Before <span data-type="inlineMath" data-latex="a+b" /> text'}
        newContent={'After <span data-type="inlineMath" data-latex="c+d" /> text'}
        mode="split"
        pendingLines={[
          {
            id: 'line-1',
            line_no: 1,
            old_line: 'Before <span data-type="inlineMath" data-latex="a+b" /> text',
            new_line: 'After <span data-type="inlineMath" data-latex="c+d" /> text',
            decision: 'pending',
          },
        ]}
      />
    );

    expect(document.querySelectorAll('.katex').length).toBeGreaterThan(0);
    expect(screen.queryByText(/data-type="inlineMath"/)).not.toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === 'Before $a+b$ text')).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === 'After $c+d$ text')).toBeInTheDocument();
  });
});
