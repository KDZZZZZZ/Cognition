import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RenderedDiffViewer } from '../RenderedDiffViewer';

describe('RenderedDiffViewer', () => {
  it('renders merged markdown diff rows with line-level actions for pending changes', () => {
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
    expect(container.querySelectorAll('[data-testid="diff-merged-markdown"]').length).toBe(2);
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelectorAll('code').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('del').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('new');
    expect(container.textContent).toContain('paragraph');
    expect(container.textContent).toContain('$$x+y$$');

    fireEvent.click(screen.getByLabelText('Accept line 2'));
    expect(onApplyLineDecision).toHaveBeenCalledWith('line-2', 'accepted');
  });

  it('renders split mode as a single merged markdown review stream', () => {
    const { container } = render(
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
    expect(container.querySelectorAll('[data-testid="diff-merged-markdown"]').length).toBe(2);
    expect(container.querySelector('pre')).toBeNull();
    expect(Array.from(container.querySelectorAll('del')).some((element) => element.textContent === 'B')).toBe(true);
    expect(Array.from(container.querySelectorAll('code')).some((element) => element.textContent === 'C')).toBe(true);
    expect(Array.from(container.querySelectorAll('code')).some((element) => element.textContent === 'line D')).toBe(true);
  });

  it('normalizes serialized math html before rendering merged diff markdown', () => {
    const { container } = render(
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

    expect(container.innerHTML).not.toContain('data-type="inlineMath"');
    expect(container.querySelectorAll('[data-testid="diff-merged-markdown"]').length).toBe(1);
    expect(container.querySelectorAll('code').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('del').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('c');
    expect(container.textContent).toContain('d');
  });

  it('keeps table rows renderable by including required markdown context', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'| Dataset | Score |\n| --- | --- |\n| MMLU | 54.1 |'}
        newContent={'| Dataset | Score |\n| --- | --- |\n| MMLU | 54.0 |'}
        mode="split"
      />
    );

    expect(container.querySelector('table')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('del')).some((element) => element.textContent === '1')).toBe(true);
    expect(Array.from(container.querySelectorAll('code')).some((element) => element.textContent === '0')).toBe(true);
  });

  it('renders formatting-only markdown changes without leaking raw markers', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'- 时变风险规避阈值 $\\tau(t)$'}
        newContent={'- **时变风险规避阈值** $\\tau(t)$'}
        mode="split"
      />
    );

    expect(container.textContent).not.toContain('**');
    expect(container.querySelector('strong')).not.toBeNull();
  });

  it('keeps fenced code blocks renderable by carrying code fence context', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'```ts\nconst answer = 42;\n```'}
        newContent={'```ts\nconst answer = 43;\n```'}
        mode="split"
      />
    );

    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.textContent).toContain('const answer = 43;');
    expect(container.textContent).not.toContain('```');
  });
});
