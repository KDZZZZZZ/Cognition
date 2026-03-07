import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownDocumentEditor } from '../MarkdownDocumentEditor';

vi.mock('../TiptapMarkdownEditor', () => ({
  TiptapMarkdownEditor: ({
    content,
    onChange,
  }: {
    content?: string;
    onChange?: (value: string) => void;
  }) => (
    <div data-testid="mock-tiptap-editor">
      <div>{content}</div>
      <button onClick={() => onChange?.('updated block from mock tiptap')}>mock-tiptap-change</button>
    </div>
  ),
}));

vi.mock('@uiw/react-codemirror', () => ({
  default: ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (value: string) => void;
  }) => (
    <div data-testid="mock-codemirror">
      <div>{value}</div>
      <button onClick={() => onChange?.('const answer = 43;')}>mock-codemirror-change</button>
    </div>
  ),
}));

describe('MarkdownDocumentEditor', () => {
  it('keeps a text block active after the first content change', async () => {
    function Harness() {
      const initial = '---\ntitle: Example\n---\n\nParagraph text';
      const [content, setContent] = useState(initial);
      return (
        <MarkdownDocumentEditor
          fileId="f-active"
          fileName="active.md"
          baseContent={initial}
          content={content}
          onChange={setContent}
        />
      );
    }

    const { container } = render(<Harness />);

    const paragraphBlock = container.querySelector('[data-block-kind="paragraph"] [role="button"]');
    expect(paragraphBlock).toBeTruthy();
    fireEvent.click(paragraphBlock!);

    expect(await screen.findByTestId('mock-tiptap-editor')).toBeInTheDocument();
    fireEvent.click(screen.getByText('mock-tiptap-change'));

    await waitFor(() => {
      expect(screen.getByTestId('mock-tiptap-editor')).toBeInTheDocument();
      expect(screen.getByText('updated block from mock tiptap')).toBeInTheDocument();
    });
  });

  it('renders rich markdown through the structured block editor shell', async () => {
    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-rich"
        fileName="rich.md"
        baseContent={'---\ntitle: Example\n---\n\n> [!NOTE] Callout body\n\n- [ ] task\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n'}
        content={'---\ntitle: Example\n---\n\n> [!NOTE] Callout body\n\n- [ ] task\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n'}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('markdown-block-editor')).toBeInTheDocument();
    expect(container.querySelector('[data-block-kind="frontmatter"]')).toBeTruthy();
    expect(container.querySelector('[data-block-kind="callout"]')).toBeTruthy();
    expect(container.querySelector('[data-block-kind="task_list"]')).toBeTruthy();
    expect(container.querySelector('[data-block-kind="table"]')).toBeTruthy();
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(screen.queryByText('Live Diff')).not.toBeInTheDocument();
    expect(screen.queryByText('Document')).not.toBeInTheDocument();
  });

  it('keeps multiline callouts on the dedicated callout editor path', async () => {
    const markdown = '> [!NOTE] Draft callout title\n> Callout body with a second line.';
    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-callout"
        fileName="callout.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    const calloutBlock = container.querySelector('[data-block-kind="callout"] [role="button"]');
    expect(calloutBlock).toBeTruthy();
    fireEvent.click(calloutBlock!);

    expect(await screen.findByPlaceholderText('Callout title')).toBeInTheDocument();
  });

  it('renders inline red-green diff markers in pending draft preview', () => {
    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-pending"
        fileName="pending.md"
        baseContent={'Paragraph with old text'}
        content={'Paragraph with new text'}
        pendingDiffEvent={{ id: 'evt-1' } as any}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('markdown-block-editor')).toBeInTheDocument();
    expect(container.querySelector('[data-diff-op="delete"]')).toBeTruthy();
    expect(container.querySelector('[data-diff-op="insert"]')).toBeTruthy();
  });

  it('edits display math blocks through a formula-only input', async () => {
    const onChange = vi.fn();

    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-math"
        fileName="math.md"
        baseContent={'$$\na+b\n$$\n\n<div>anchor</div>'}
        content={'$$\nx+y\n$$\n\n<div>anchor</div>'}
        onChange={onChange}
      />
    );

    const mathBlock = container.querySelector('[data-block-kind="math"] [role="button"]');
    expect(mathBlock).toBeTruthy();
    fireEvent.click(mathBlock!);
    const input = await screen.findByTestId('math-formula-input');
    expect(input).toHaveValue('x+y');

    fireEvent.change(input, { target: { value: 'x+y+z' } });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('$$x+y+z$$\n\n<div>anchor</div>');
    });
  });

  it('keeps html blocks in block-local source editing with live preview', async () => {
    const onChange = vi.fn();

    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-html"
        fileName="html.md"
        baseContent={'<div>old</div>'}
        content={'<div>hello</div>'}
        onChange={onChange}
      />
    );

    const htmlBlock = container.querySelector('[data-block-kind="html"] [role="button"]');
    expect(htmlBlock).toBeTruthy();
    fireEvent.click(htmlBlock!);
    expect(await screen.findByTestId('raw-markdown-editor')).toBeInTheDocument();
    expect(screen.getByText('This block stays source editable in place.')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('raw-markdown-editor'), { target: { value: '<div>updated</div>' } });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('<div>updated</div>');
    });
  });

  it('renames footnote identifiers across references and definitions', async () => {
    const onChange = vi.fn();

    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-footnote"
        fileName="footnote.md"
        baseContent={'Paragraph[^1]\n\n[^1]: note'}
        content={'Paragraph[^1]\n\n[^1]: note'}
        onChange={onChange}
      />
    );

    const footnoteBlock = container.querySelector('[data-block-kind="footnote"] [role="button"]');
    expect(footnoteBlock).toBeTruthy();
    fireEvent.click(footnoteBlock!);
    const identifierInput = await screen.findByDisplayValue('1');
    fireEvent.change(identifierInput, { target: { value: '2' } });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('Paragraph[^2]\n\n[^2]: note');
    });
  });

  it('renders footnote references as superscripts in block preview', () => {
    render(
      <MarkdownDocumentEditor
        fileId="f-footnote-preview"
        fileName="footnote-preview.md"
        baseContent={'Paragraph with footnote[^1].\n\n[^1]: note'}
        content={'Paragraph with footnote[^1].\n\n[^1]: note'}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText((content, element) => element?.tagName.toLowerCase() === 'p' && content.includes('Paragraph with footnote'))).toBeInTheDocument();
    expect(screen.queryByText('Paragraph with footnote[^1].')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '1' })).toBeInTheDocument();
  });

  it('edits image blocks without exposing markdown syntax', async () => {
    const onChange = vi.fn();

    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-image"
        fileName="image.md"
        baseContent={'![old alt](https://example.com/image.png "Old caption")'}
        content={'![old alt](https://example.com/image.png "Old caption")'}
        onChange={onChange}
      />
    );

    const imageBlock = container.querySelector('[data-block-kind="image"] [role="button"]');
    expect(imageBlock).toBeTruthy();
    fireEvent.click(imageBlock!);

    fireEvent.change(await screen.findByPlaceholderText('Alt text'), { target: { value: 'new alt' } });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('![new alt](https://example.com/image.png "Old caption")');
    });
  });

  it('edits code blocks through CodeMirror', async () => {
    const onChange = vi.fn();

    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-code"
        fileName="code.md"
        baseContent={'```ts\nconst answer = 42;\n```'}
        content={'```ts\nconst answer = 42;\n```'}
        onChange={onChange}
      />
    );

    const codeBlock = container.querySelector('[data-block-kind="code"] [role="button"]');
    expect(codeBlock).toBeTruthy();
    fireEvent.click(codeBlock!);

    expect(await screen.findByTestId('mock-codemirror')).toBeInTheDocument();
    fireEvent.click(screen.getByText('mock-codemirror-change'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('```ts\nconst answer = 43;\n```');
    });
  });

  it('supports removing table rows and columns', async () => {
    function Harness() {
      const initial = `---
title: Table
---

| A | B |
| --- | --- |
| 1 | 2 |
| 3 | 4 |`;
      const [content, setContent] = useState(initial);
      return (
        <MarkdownDocumentEditor
          fileId="f-table"
          fileName="table.md"
          baseContent={initial}
          content={content}
          onChange={setContent}
        />
      );
    }

    const { container } = render(<Harness />);

    const tableBlock = container.querySelector('[data-block-kind="table"] [role="button"]');
    expect(tableBlock).toBeTruthy();
    fireEvent.click(tableBlock!);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove row 1' }));
    await waitFor(() => {
      expect(screen.queryByDisplayValue('1')).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue('2')).not.toBeInTheDocument();
      expect(screen.getByDisplayValue('3')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove column 2' }));
    await waitFor(() => {
      expect(screen.queryByDisplayValue('B')).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue('4')).not.toBeInTheDocument();
      expect(screen.getByDisplayValue('A')).toBeInTheDocument();
      expect(screen.getByDisplayValue('3')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Remove column 2' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove last column' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Remove column 2' })).not.toBeInTheDocument();
    });
  });
});
