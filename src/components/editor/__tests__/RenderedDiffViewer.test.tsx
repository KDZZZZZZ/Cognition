import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RenderedDiffViewer } from '../RenderedDiffViewer';

describe('RenderedDiffViewer', () => {
  it('renders pending diff as unified block cards while keeping line actions', () => {
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

    expect(screen.queryByText('Rendered Original')).not.toBeInTheDocument();
    expect(screen.queryByText('Rendered Modified')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Accept line 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Reject line 3')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="diff-block-card"]').length).toBe(2);
    expect(container.querySelector('[data-diff-op="insert"]')).not.toBeNull();
    expect(container.querySelector('.katex')).not.toBeNull();

    fireEvent.click(screen.getByLabelText('Accept line 2'));
    expect(onApplyLineDecision).toHaveBeenCalledWith('line-2', 'accepted');
  });

  it('renders history diff as a single unified block instead of split panes', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'line A\nline B'}
        newContent={'line A\nline C\nline D'}
        mode="split"
      />
    );

    expect(screen.queryByText('Rendered Original')).not.toBeInTheDocument();
    expect(screen.queryByText('Rendered Modified')).not.toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="diff-block-card"]').length).toBe(2);
    expect(container.querySelector('[data-diff-op="delete"]')).not.toBeNull();
    expect(container.querySelector('[data-diff-op="insert"]')).not.toBeNull();
  });

  it('normalizes serialized math html into rendered math diff nodes', () => {
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
    expect(container.querySelectorAll('[data-testid="diff-block-card"]').length).toBe(1);
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('[data-diff-op="delete"]')).not.toBeNull();
    expect(container.querySelector('[data-diff-op="insert"]')).not.toBeNull();
  });

  it('keeps table rows renderable and applies cell-level inline diff', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'| Dataset | Score |\n| --- | --- |\n| MMLU | 54.1 |'}
        newContent={'| Dataset | Score |\n| --- | --- |\n| MMLU | 54.0 |'}
        mode="split"
      />
    );

    expect(container.querySelector('table')).not.toBeNull();
    expect(Array.from(container.querySelectorAll('[data-diff-op="delete"]')).some((element) => element.textContent === '1')).toBe(true);
    expect(Array.from(container.querySelectorAll('[data-diff-op="insert"]')).some((element) => element.textContent === '0')).toBe(true);
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
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('keeps fenced code blocks renderable by using code-style line diff', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'```ts\nconst answer = 42;\n```'}
        newContent={'```ts\nconst answer = 43;\nconsole.log(answer);\n```'}
        mode="split"
      />
    );

    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.textContent).toContain('const answer = 43;');
    expect(container.textContent).not.toContain('```');
  });

  it('renders callouts as dedicated cards instead of raw blockquote markers', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'> [!NOTE]\n> Old note'}
        newContent={'> [!NOTE]\n> Updated note'}
        mode="split"
      />
    );

    expect(container.textContent).not.toContain('[!NOTE]');
    expect(container.querySelector('aside')).not.toBeNull();
    expect(container.textContent).toContain('Updated note');
  });

  it('keeps plain blockquotes on line-level review instead of block-level review', () => {
    const onApplyLineDecision = vi.fn();

    render(
      <RenderedDiffViewer
        oldContent={'> Old quote'}
        newContent={'> Updated quote'}
        mode="split"
        pendingLines={[
          {
            id: 'quote-line',
            line_no: 5,
            old_line: '> Old quote',
            new_line: '> Updated quote',
            decision: 'pending',
          },
        ]}
        onApplyLineDecision={onApplyLineDecision}
      />
    );

    expect(screen.getByLabelText('Accept line 1')).toBeInTheDocument();
    expect(screen.queryByLabelText('Accept block')).not.toBeInTheDocument();
  });

  it('treats display math as a single block review without per-line formula actions', () => {
    const onApplyLineDecision = vi.fn();

    render(
      <RenderedDiffViewer
        oldContent={''}
        newContent={'Display math:\n$$\nx+y\n$$'}
        mode="split"
        pendingLines={[
          { id: 'line-1', line_no: 1, old_line: null, new_line: 'Display math:', decision: 'pending' },
          { id: 'line-2', line_no: 2, old_line: null, new_line: '$$', decision: 'pending' },
          { id: 'line-3', line_no: 3, old_line: null, new_line: 'x+y', decision: 'pending' },
          { id: 'line-4', line_no: 4, old_line: null, new_line: '$$', decision: 'pending' },
        ]}
        onApplyLineDecision={onApplyLineDecision}
      />
    );

    expect(screen.getByLabelText('Accept line 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Accept Formula block')).toBeInTheDocument();
    expect(screen.queryByLabelText('Accept line 2')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Accept line 3')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Accept line 4')).not.toBeInTheDocument();
  });

  it('keeps changed fenced-code markers inside code-line review controls', () => {
    const onApplyLineDecision = vi.fn();

    render(
      <RenderedDiffViewer
        oldContent={'`ts\nconst answer = 42;\n```'}
        newContent={'```ts\nconst answer = 43;\nconsole.log(answer);\n```'}
        mode="split"
        pendingLines={[
          { id: 'line-1', line_no: 15, old_line: '`ts', new_line: '```ts', decision: 'pending' },
          { id: 'line-2', line_no: 16, old_line: 'const answer = 42;', new_line: 'const answer = 43;', decision: 'pending' },
          { id: 'line-3', line_no: 17, old_line: null, new_line: 'console.log(answer);', decision: 'pending' },
          { id: 'line-4', line_no: 18, old_line: '```', new_line: '```', decision: 'accepted' },
        ]}
        onApplyLineDecision={onApplyLineDecision}
      />
    );

    expect(screen.getByLabelText('Accept line 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Accept line 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Accept line 3')).toBeInTheDocument();
  });

  it('renders frontmatter as key/value metadata diff', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'---\ntitle: Old\ntags: [a]\n---'}
        newContent={'---\ntitle: New\ntags: [a, b]\n---'}
        mode="split"
      />
    );

    expect(container.textContent).toContain('Key');
    expect(container.textContent).toContain('title');
    expect(container.querySelectorAll('table').length).toBeGreaterThan(0);
  });

  it('renders footnote definitions as dedicated diff sections', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'[^1]: old note'}
        newContent={'[^1]: new note'}
        mode="split"
      />
    );

    expect(container.textContent).toContain('Footnote 1');
    expect(container.textContent).toContain('new note');
  });

  it('treats html blocks as atomic structural content', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'<div class="note">old</div>'}
        newContent={'<div class="note">new</div>'}
        mode="split"
      />
    );

    expect(container.querySelector('pre')).not.toBeNull();
    expect(container.textContent).toContain('new');
    expect(container.querySelector('[data-diff-op="delete"]')).not.toBeNull();
  });
});
