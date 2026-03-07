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
    expect(container.querySelectorAll('[data-testid="diff-block-card"]').length).toBe(0);
    expect(container.querySelectorAll('[data-testid="diff-review-unit"]').length).toBe(2);
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
    expect(container.querySelectorAll('[data-testid="diff-block-card"]').length).toBe(0);
    expect(container.querySelectorAll('[data-testid="diff-review-unit"]').length).toBe(2);
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
    expect(container.querySelectorAll('[data-testid="diff-block-card"]').length).toBe(0);
    expect(container.querySelectorAll('[data-testid="diff-review-unit"]').length).toBe(1);
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

  it('uses word-level text diff for prose so replacements do not collapse into merged fragments', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'summary: baseline metadata\n\nOld callout body.'}
        newContent={'summary: refined metadata\n\nUpdated callout body.'}
        mode="split"
      />
    );

    expect(container.textContent).not.toContain('basrelfined');
    expect(container.textContent).not.toContain('OlUpdated');
    expect(container.querySelector('[data-diff-op="delete"]')).not.toBeNull();
    expect(container.querySelector('[data-diff-op="insert"]')).not.toBeNull();
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
    expect(container.querySelectorAll('[data-diff-op="delete"]').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('[data-diff-op="insert"]').length).toBeGreaterThanOrEqual(1);
  });

  it('renders footnote references as references instead of raw markdown syntax', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'Paragraph with ref[^1].'}
        newContent={'Paragraph with better ref[^1] and another[^2].'}
        mode="split"
      />
    );

    expect(container.textContent).not.toContain('[^1]');
    expect(container.textContent).not.toContain('[^2]');
    expect(container.querySelectorAll('sup').length).toBeGreaterThan(0);
  });

  it('treats html blocks as rendered atomic structural content', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'<div class="note">old</div>'}
        newContent={'<div class="note">new</div>'}
        mode="split"
      />
    );

    expect(container.querySelector('pre')).toBeNull();
    expect(container.textContent).toContain('new');
    expect(container.querySelector('.note')).not.toBeNull();
    expect(container.querySelector('[data-diff-op="delete"]')).not.toBeNull();
  });

  it('renders inline html as actual inline content instead of raw tag tokens', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'Inline <span data-kind="old">html</span> update.'}
        newContent={'Inline <span data-kind="new">html</span> update.'}
        mode="split"
      />
    );

    expect(container.textContent).not.toContain('<span data-kind');
    expect(container.querySelector('[data-kind="new"]')).not.toBeNull();
    expect(container.querySelector('[data-diff-op="delete"]')).not.toBeNull();
    expect(container.querySelector('[data-diff-op="insert"]')).not.toBeNull();
  });

  it('renders relative-path markdown images as placeholders instead of broken image tags', () => {
    const { container } = render(
      <RenderedDiffViewer
        oldContent={'![chart](old-chart.png)'}
        newContent={'![chart v2](new-chart.png)'}
        mode="split"
      />
    );

    expect(container.querySelector('figure')).toBeNull();
    expect(container.querySelectorAll('img').length).toBe(0);
    expect(container.textContent).toContain('chart v2');
  });

  it('renders previewable markdown images as image diffs instead of placeholders', () => {
    const oldSvg = 'https://placehold.co/64x40/fca5a5/7f1d1d.png?text=v1';
    const newSvg = 'https://placehold.co/64x40/86efac/166534.png?text=v2';
    const { container } = render(
      <RenderedDiffViewer
        oldContent={`![chart old](${oldSvg})`}
        newContent={`![chart new](${newSvg})`}
        mode="split"
      />
    );

    expect(container.querySelectorAll('img').length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain('chart new');
  });
});
