import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownDocumentEditor } from '../MarkdownDocumentEditor';

vi.mock('../TiptapMarkdownEditor', () => ({
  TiptapMarkdownEditor: ({
    content,
    onChange,
    onBlur,
    autofocus,
    editable = true,
    inlineDiffBaseMarkdown,
    placeholder,
    showPlaceholderWhenReadonly,
  }: {
    content?: string;
    onChange?: (value: string) => void;
    onBlur?: () => void;
    autofocus?: boolean;
    editable?: boolean;
    inlineDiffBaseMarkdown?: string | null;
    placeholder?: string;
    showPlaceholderWhenReadonly?: boolean;
  }) => {
    const editorRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      if (autofocus && editable) {
        editorRef.current?.focus();
      }
    }, [autofocus, editable]);

    return (
      <div data-testid="mock-tiptap-editor" data-editable={editable ? 'true' : 'false'}>
        <div
          ref={editorRef}
          contentEditable={editable}
          suppressContentEditableWarning
          data-testid="mock-tiptap-contenteditable"
          role="textbox"
          aria-readonly={!editable}
          tabIndex={0}
          onBlur={onBlur}
        >
          {content}
        </div>
        {(!content && placeholder && (editable || showPlaceholderWhenReadonly)) ? (
          <div data-testid="mock-tiptap-placeholder">{placeholder}</div>
        ) : null}
        {inlineDiffBaseMarkdown && inlineDiffBaseMarkdown !== content ? (
          <div data-testid="mock-inline-diff">
            <span data-diff-op="delete">{inlineDiffBaseMarkdown}</span>
            <span data-diff-op="insert">{content}</span>
          </div>
        ) : null}
        <button onClick={() => onChange?.('updated block from mock tiptap')}>mock-tiptap-change</button>
        <button onClick={() => onChange?.('')}>mock-tiptap-clear</button>
      </div>
    );
  },
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

vi.mock('../../ui/MermaidDiagram', () => ({
  MermaidDiagram: ({ chart, title }: { chart: string; title?: string | null }) => (
    <div data-testid="mock-mermaid-diagram">
      <div>{title || 'mermaid'}</div>
      <div>{chart}</div>
    </div>
  ),
}));

describe('MarkdownDocumentEditor', () => {
  function getRenderedBlock(container: HTMLElement, kind: string) {
    return container.querySelector(`[data-block-kind="${kind}"] [data-block-render-surface="true"]`);
  }

  function getActiveMockTiptapEditor(container: ParentNode = document.body) {
    return container.querySelector('[data-testid="mock-tiptap-editor"][data-editable="true"]') as HTMLElement | null;
  }

  function getActiveMockTiptapContent(container: ParentNode = document.body) {
    return container.querySelector(
      '[data-testid="mock-tiptap-editor"][data-editable="true"] [data-testid="mock-tiptap-contenteditable"]'
    ) as HTMLElement | null;
  }

  function getTextboxByText(text: string, label?: string) {
    const matches = label ? screen.getAllByLabelText(label) : screen.getAllByRole('textbox');
    return matches.find((element) => (element.textContent || '').trim() === text) as HTMLElement | undefined;
  }

  function inputContentEditable(element: HTMLElement, value: string) {
    element.textContent = value;
    fireEvent.input(element, { target: element, currentTarget: element });
  }

  function setDocumentCaretRangeFromPoint(factory: (() => Range | null) | null) {
    const documentWithCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const documentWithCaretRecord = documentWithCaret as unknown as Record<string, unknown>;
    const original = documentWithCaret.caretRangeFromPoint;
    const hadOwnProperty = Object.prototype.hasOwnProperty.call(documentWithCaretRecord, 'caretRangeFromPoint');
    if (factory) {
      Object.defineProperty(documentWithCaret, 'caretRangeFromPoint', {
        configurable: true,
        value: factory,
      });
    } else if (hadOwnProperty) {
      delete documentWithCaretRecord.caretRangeFromPoint;
    }
    return () => {
      if (hadOwnProperty) {
        Object.defineProperty(documentWithCaret, 'caretRangeFromPoint', {
          configurable: true,
          value: original,
        });
      } else {
        delete documentWithCaretRecord.caretRangeFromPoint;
      }
    };
  }

  function setRangeBoundingClientRect(factory: (() => DOMRect) | null) {
    const rangePrototype = Range.prototype as Range & {
      getBoundingClientRect?: () => DOMRect;
    };
    const rangePrototypeRecord = rangePrototype as unknown as Record<string, unknown>;
    const original = rangePrototype.getBoundingClientRect;
    const hadOwnProperty = Object.prototype.hasOwnProperty.call(rangePrototypeRecord, 'getBoundingClientRect');
    if (factory) {
      Object.defineProperty(rangePrototype, 'getBoundingClientRect', {
        configurable: true,
        value: factory,
      });
    } else if (hadOwnProperty) {
      delete rangePrototypeRecord.getBoundingClientRect;
    }
    return () => {
      if (hadOwnProperty) {
        Object.defineProperty(rangePrototype, 'getBoundingClientRect', {
          configurable: true,
          value: original,
        });
      } else {
        delete rangePrototypeRecord.getBoundingClientRect;
      }
    };
  }

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

    const paragraphBlock = getRenderedBlock(container, 'paragraph');
    expect(paragraphBlock).toBeTruthy();
    fireEvent.mouseDown(paragraphBlock!);

    await waitFor(() => {
      expect(getActiveMockTiptapEditor()).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('mock-tiptap-change'));

    await waitFor(() => {
      expect(getActiveMockTiptapEditor()).toBeInTheDocument();
      expect(screen.getByText('updated block from mock tiptap')).toBeInTheDocument();
    });
  });

  it('exits edit mode when clicking the document blank area', async () => {
    function Harness() {
      const initial = 'Paragraph text';
      const [content, setContent] = useState(initial);
      return (
        <MarkdownDocumentEditor
          fileId="f-blank-exit"
          fileName="blank-exit.md"
          baseContent={initial}
          content={content}
          onChange={setContent}
        />
      );
    }

    const { container } = render(<Harness />);

    const paragraphBlock = getRenderedBlock(container, 'paragraph');
    expect(paragraphBlock).toBeTruthy();
    fireEvent.mouseDown(paragraphBlock!);

    await waitFor(() => {
      expect(getActiveMockTiptapEditor()).toBeInTheDocument();
    });
    fireEvent.mouseDown(screen.getByTestId('markdown-document-scroll'));

    await waitFor(() => {
      expect(getActiveMockTiptapEditor()).toBeNull();
    });
  });

  it('appends a real empty paragraph line from the bottom blank area and materializes typed text', async () => {
    function Harness() {
      const initial = '# Heading';
      const [content, setContent] = useState(initial);
      return (
        <>
          <MarkdownDocumentEditor
            fileId="f-trailing"
            fileName="trailing.md"
            baseContent={initial}
            content={content}
            onChange={setContent}
          />
          <div data-testid="current-markdown">{content}</div>
        </>
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByTestId('markdown-trailing-hitbox'));
    await waitFor(() => {
      expect(screen.getByTestId('current-markdown').textContent).toBe('# Heading\n');
      expect(getActiveMockTiptapEditor()).toBeInTheDocument();
      expect(getActiveMockTiptapContent()).toHaveFocus();
      expect(screen.getByTestId('mock-tiptap-placeholder')).toHaveTextContent('Type / for commands, or start writing...');
    });

    fireEvent.click(getActiveMockTiptapEditor()!.querySelector('button') as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByTestId('current-markdown').textContent).toBe('# Heading\n\nupdated block from mock tiptap');
      expect(screen.getByText('updated block from mock tiptap')).toBeInTheDocument();
      expect(getActiveMockTiptapContent()).toHaveFocus();
      expect(getActiveMockTiptapContent()).toHaveTextContent('updated block from mock tiptap');
      expect(screen.queryByTestId('markdown-trailing-hitbox')).toBeInTheDocument();
    });
  });

  it('inserts a real empty paragraph line from the bottom hitbox when pressing Enter', async () => {
    function Harness() {
      const [content, setContent] = useState('');
      return (
        <>
          <MarkdownDocumentEditor
            fileId="f-trailing-enter"
            fileName="trailing-enter.md"
            baseContent=""
            content={content}
            onChange={setContent}
          />
          <div data-testid="current-markdown">{content}</div>
        </>
      );
    }

    render(<Harness />);

    const hitbox = screen.getByTestId('markdown-trailing-hitbox');
    hitbox.focus();
    fireEvent.keyDown(hitbox, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByTestId('current-markdown').textContent).toBe('\n');
      expect(getActiveMockTiptapEditor()).toBeInTheDocument();
      expect(getActiveMockTiptapContent()).toHaveFocus();
      expect(screen.getByTestId('mock-tiptap-placeholder')).toHaveTextContent('Type / for commands, or start writing...');
    });
  });

  it('inserts a real empty paragraph line when double-clicking between two blocks', async () => {
    function Harness() {
      const initial = '# Heading\n\nParagraph after heading';
      const [content, setContent] = useState(initial);
      return (
        <>
          <MarkdownDocumentEditor
            fileId="f-insert-between"
            fileName="insert-between.md"
            baseContent={initial}
            content={content}
            onChange={setContent}
          />
          <div data-testid="current-markdown">{content}</div>
        </>
      );
    }

    render(<Harness />);
    const handles = screen.getAllByRole('button', { name: 'Insert paragraph' });
    fireEvent.doubleClick(handles[1]);

    await waitFor(() => {
      expect(screen.getByTestId('current-markdown').textContent).toBe('# Heading\n\n\nParagraph after heading');
      expect(getActiveMockTiptapEditor()).toBeInTheDocument();
      expect(getActiveMockTiptapContent()).toHaveFocus();
      expect(screen.getByTestId('mock-tiptap-placeholder')).toHaveTextContent('Type / for commands, or start writing...');
    });

    fireEvent.click(getActiveMockTiptapEditor()!.querySelector('button') as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByTestId('current-markdown').textContent).toBe(
        '# Heading\n\nupdated block from mock tiptap\n\nParagraph after heading'
      );
      expect(getActiveMockTiptapContent()).toHaveFocus();
      expect(getActiveMockTiptapContent()).toHaveTextContent('updated block from mock tiptap');
    });
  });

  it('mutates markdown immediately when inserting an empty paragraph line, then materializes typed text', async () => {
    function Harness() {
      const initial = '# Heading';
      const [content, setContent] = useState(initial);
      return (
        <>
          <MarkdownDocumentEditor
            fileId="f-trailing-local"
            fileName="trailing-local.md"
            baseContent={initial}
            content={content}
            onChange={setContent}
          />
          <div data-testid="current-markdown">{content}</div>
        </>
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByTestId('markdown-trailing-hitbox'));
    await waitFor(() => {
      expect(screen.getByTestId('current-markdown').textContent).toBe('# Heading\n');
      expect(getActiveMockTiptapEditor()).toBeInTheDocument();
    });

    fireEvent.click(getActiveMockTiptapEditor()!.querySelector('button') as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByTestId('current-markdown').textContent).toBe('# Heading\n\nupdated block from mock tiptap');
      expect(screen.getByText('updated block from mock tiptap')).toBeInTheDocument();
      expect(getActiveMockTiptapContent()).toHaveFocus();
    });
  });

  it('returns focus to the previous block when deleting an active empty paragraph line', async () => {
    function Harness() {
      const initial = '# Heading\n\nParagraph after heading';
      const [content, setContent] = useState(initial);
      return (
        <>
          <MarkdownDocumentEditor
            fileId="f-empty-remove-focus"
            fileName="empty-remove-focus.md"
            baseContent={initial}
            content={content}
            onChange={setContent}
          />
          <div data-testid="current-markdown">{content}</div>
        </>
      );
    }

    render(<Harness />);

    fireEvent.doubleClick(screen.getAllByRole('button', { name: 'Insert paragraph' })[1]);

    const activeEmptyLine = await waitFor(() => {
      const element = getActiveMockTiptapContent();
      expect(element).toBeInTheDocument();
      return element!;
    });

    fireEvent.keyDown(activeEmptyLine, { key: 'Backspace' });

    await waitFor(() => {
      expect(screen.getByTestId('current-markdown').textContent).toBe('# Heading\n\nParagraph after heading');
      expect(getActiveMockTiptapContent()).toHaveFocus();
      expect(getActiveMockTiptapContent()).toHaveTextContent('# Heading');
    });
  });

  it('moves focus to the previous empty paragraph line when deleting within a run of empty lines', async () => {
    function Harness() {
      const initial = '# Heading\n\n\n\nParagraph after heading';
      const [content, setContent] = useState(initial);
      return (
        <>
          <MarkdownDocumentEditor
            fileId="f-empty-run-remove-focus"
            fileName="empty-run-remove-focus.md"
            baseContent={initial}
            content={content}
            onChange={setContent}
          />
          <div data-testid="current-markdown">{content}</div>
        </>
      );
    }

    render(<Harness />);

    const emptyLines = screen.getAllByTestId('markdown-empty-paragraph-line');
    fireEvent.mouseDown(within(emptyLines[1]).getByTestId('mock-tiptap-contenteditable'));

    const activeEmptyLine = await waitFor(() => {
      const element = getActiveMockTiptapContent();
      expect(element).toBeInTheDocument();
      return element!;
    });

    fireEvent.keyDown(activeEmptyLine, { key: 'Backspace' });

    await waitFor(() => {
      expect(screen.getByTestId('current-markdown').textContent).toBe('# Heading\n\n\nParagraph after heading');
      expect(screen.getAllByTestId('markdown-empty-paragraph-line')).toHaveLength(1);
      expect(getActiveMockTiptapContent()).toHaveFocus();
      expect(getActiveMockTiptapContent()).toHaveTextContent('');
    });
  });

  it('keeps an empty inserted paragraph visible after blur so it does not get swallowed immediately', async () => {
    function Harness() {
      const initial = '# Heading\n\nParagraph after heading';
      const [content, setContent] = useState(initial);
      return (
        <>
          <MarkdownDocumentEditor
            fileId="f-empty-insert"
            fileName="empty-insert.md"
            baseContent={initial}
            content={content}
            onChange={setContent}
          />
          <div data-testid="current-markdown">{content}</div>
        </>
      );
    }

    render(<Harness />);

    const handles = screen.getAllByRole('button', { name: 'Insert paragraph' });
    fireEvent.doubleClick(handles[1]);

    const activeDraft = await waitFor(() => {
      const element = getActiveMockTiptapContent();
      expect(element).toBeInTheDocument();
      return element!;
    });

    fireEvent.blur(activeDraft);
    fireEvent.mouseDown(screen.getByTestId('markdown-document-scroll'));

    await waitFor(() => {
      const emptyLine = screen.getByTestId('markdown-empty-paragraph-line');
      expect(emptyLine).toBeInTheDocument();
      expect(screen.getByTestId('current-markdown').textContent).toBe('# Heading\n\n\nParagraph after heading');
    });

    fireEvent.mouseDown(within(screen.getByTestId('markdown-empty-paragraph-line')).getByTestId('mock-tiptap-contenteditable'));

    await waitFor(() => {
      expect(getActiveMockTiptapEditor()).toBeInTheDocument();
      expect(getActiveMockTiptapContent()).toHaveFocus();
      expect(screen.getByTestId('mock-tiptap-placeholder')).toHaveTextContent('Type / for commands, or start writing...');
    });
  });

  it('clears transient empty paragraph state when switching files', async () => {
    const { rerender } = render(
      <MarkdownDocumentEditor
        fileId="f-switch-a"
        fileName="switch-a.md"
        baseContent={'First paragraph\n'}
        content={'First paragraph\n'}
        onChange={vi.fn()}
      />
    );

    fireEvent.mouseDown(within(screen.getByTestId('markdown-empty-paragraph-line')).getByTestId('mock-tiptap-contenteditable'));

    const activeDraft = await waitFor(() => {
      const element = getActiveMockTiptapContent();
      expect(element).toBeInTheDocument();
      return element!;
    });

    fireEvent.blur(activeDraft);

    await waitFor(() => {
      expect(screen.getByTestId('markdown-empty-paragraph-line')).toBeInTheDocument();
    });

    rerender(
      <MarkdownDocumentEditor
        fileId="f-switch-b"
        fileName="switch-b.md"
        baseContent={'Second paragraph'}
        content={'Second paragraph'}
        onChange={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.queryByTestId('markdown-empty-paragraph-line')).not.toBeInTheDocument();
      expect(screen.getByText('Second paragraph')).toBeInTheDocument();
    });
  });

  it('uses caret boundary navigation to activate the next block editor directly', async () => {
    const markdown = '$$\nx+y\n$$\n\nParagraph text';
    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-boundary-nav"
        fileName="boundary-nav.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    const mathBlock = getRenderedBlock(container, 'math');
    expect(mathBlock).toBeTruthy();
    fireEvent.mouseDown(mathBlock!);

    const input = (await screen.findByTestId('math-formula-input')) as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.keyDown(input, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(screen.queryByTestId('math-formula-input')).not.toBeInTheDocument();
      expect(getActiveMockTiptapEditor()).toBeInTheDocument();
      expect(getActiveMockTiptapContent()?.textContent || '').toContain('Paragraph text');
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

    const calloutBlock = getRenderedBlock(container, 'callout');
    expect(calloutBlock).toBeTruthy();
    fireEvent.mouseDown(calloutBlock!);

    await waitFor(() => {
      expect(getTextboxByText('Draft callout title', 'Callout title')).toBeInTheDocument();
      expect(getActiveMockTiptapContent()?.textContent || '').toContain('Callout body with a second line.');
    });
  });

  it('focuses the clicked frontmatter value cell instead of the first field', async () => {
    const markdown = ['---', 'title: Example', 'tags: [alpha, beta]', 'summary: baseline', '---'].join('\n');

    render(
      <MarkdownDocumentEditor
        fileId="f-frontmatter-click"
        fileName="frontmatter-click.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    fireEvent.mouseDown(screen.getByText('[alpha, beta]'));

    await waitFor(() => {
      expect(getTextboxByText('[alpha, beta]', 'Metadata value')).toHaveFocus();
    });
  });

  it('focuses the clicked paragraph offset instead of resetting to the first character', async () => {
    const markdown = ['# Heading', '', 'Second paragraph text'].join('\n');

    render(
      <MarkdownDocumentEditor
        fileId="f-paragraph-click-offset"
        fileName="paragraph-click-offset.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    const paragraph = screen.getByText('Second paragraph text');
    const textNode = paragraph.firstChild;
    expect(textNode).toBeTruthy();

    const restoreCaretRangeFromPoint = setDocumentCaretRangeFromPoint(() => {
      const range = document.createRange();
      range.setStart(textNode!, 6);
      range.collapse(true);
      return range;
    });

    try {
      fireEvent.mouseDown(paragraph, { clientX: 64, clientY: 20 });

      await waitFor(() => {
        expect(getActiveMockTiptapContent()).toHaveFocus();
        expect(window.getSelection()?.anchorNode?.textContent).toContain('Second paragraph text');
        expect(window.getSelection()?.anchorOffset).toBe(6);
      });
    } finally {
      restoreCaretRangeFromPoint();
    }
  });

  it('places the paragraph caret at the end when clicking to the right of the preview text', async () => {
    const markdown = 'Paragraph text sample';

    render(
      <MarkdownDocumentEditor
        fileId="f-paragraph-click-end"
        fileName="paragraph-click-end.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    const paragraph = screen.getByText('Paragraph text sample');
    const restoreCaretRangeFromPoint = setDocumentCaretRangeFromPoint(() => null);
    const restoreBoundingRect = setRangeBoundingClientRect(() => {
      return {
        x: 20,
        y: 20,
        width: 120,
        height: 24,
        top: 20,
        right: 140,
        bottom: 44,
        left: 20,
        toJSON: () => ({}),
      } as DOMRect;
    });

    try {
      fireEvent.mouseDown(paragraph, { clientX: 220, clientY: 24 });

      await waitFor(() => {
        expect(getActiveMockTiptapContent()).toHaveFocus();
        expect(window.getSelection()?.anchorNode?.textContent).toContain('Paragraph text sample');
        expect(window.getSelection()?.anchorOffset).toBe('Paragraph text sample'.length);
      });
    } finally {
      restoreBoundingRect();
      restoreCaretRangeFromPoint();
    }
  });

  it('places the active paragraph caret at the end when clicking the block right side', async () => {
    const markdown = 'ssss';

    render(
      <MarkdownDocumentEditor
        fileId="f-active-paragraph-click-end"
        fileName="active-paragraph-click-end.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    const paragraph = screen.getByText('ssss');
    const textNode = paragraph.firstChild;
    expect(textNode).toBeTruthy();

    const restoreBoundingRect = setRangeBoundingClientRect(() => {
      return {
        x: 20,
        y: 20,
        width: 40,
        height: 24,
        top: 20,
        right: 60,
        bottom: 44,
        left: 20,
        toJSON: () => ({}),
      } as DOMRect;
    });

    const restoreCaretRangeFromPoint = setDocumentCaretRangeFromPoint(() => {
      const range = document.createRange();
      range.setStart(textNode!, 2);
      range.collapse(true);
      return range;
    });

    try {
      fireEvent.mouseDown(paragraph, { clientX: 30, clientY: 24 });

      await waitFor(() => {
        expect(getActiveMockTiptapContent()).toHaveFocus();
        expect(window.getSelection()?.anchorOffset).toBe(2);
      });

      restoreCaretRangeFromPoint();
      const activeContent = getActiveMockTiptapContent();
      expect(activeContent).toBeTruthy();

      fireEvent.mouseDown(activeContent!, { clientX: 120, clientY: 24, button: 0 });
      fireEvent.mouseUp(activeContent!, { clientX: 120, clientY: 24, button: 0 });

      await waitFor(() => {
        expect(window.getSelection()?.anchorNode?.textContent).toContain('ssss');
        expect(window.getSelection()?.anchorOffset).toBe(4);
      });
    } finally {
      restoreBoundingRect();
      restoreCaretRangeFromPoint();
    }
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

  it('keeps visible green insert markers for structured pending diff blocks', () => {
    const base = [
      '---',
      'title: Diff Sandbox',
      'summary: baseline',
      '---',
      '',
      '- bullet item',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      '| MMLU | 54.1 |',
      '',
      '> [!NOTE] Callout title',
      '> Callout body.',
    ].join('\n');
    const draft = [
      '---',
      'title: Diff Sandbox',
      'summary: baseline updated',
      '---',
      '',
      '- bullet item stable',
      '- added item',
      '',
      '| Metric | Value |',
      '| --- | --- |',
      '| MMLU | 55.0 |',
      '| HumanEval | 83.2 |',
      '',
      '> [!NOTE] Callout title updated',
      '> Callout body expanded.',
    ].join('\n');

    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-pending-structured"
        fileName="pending-structured.md"
        baseContent={base}
        content={draft}
        pendingDiffEvent={{ id: 'evt-structured' } as any}
        onChange={vi.fn()}
      />
    );

    expect(container.querySelector('[data-block-kind="frontmatter"] [data-diff-op="insert"]')).toBeTruthy();
    expect(container.querySelector('[data-block-kind="list"] [data-diff-op="insert"]')).toBeTruthy();
    expect(container.querySelector('[data-block-kind="table"] [data-diff-op="insert"]')).toBeTruthy();
    expect(container.querySelector('[data-block-kind="callout"] [data-diff-op="insert"]')).toBeTruthy();
  });

  it('does not duplicate structured block text when rendering character-level diff', () => {
    const base = ['| Metric | Value |', '| --- | --- |', '| MMLU | 54.1 |'].join('\n');
    const draft = ['| Metric | Value |', '| --- | --- |', '| MMLU | 55.0 |'].join('\n');

    render(
      <MarkdownDocumentEditor
        fileId="f-pending-table-char-diff"
        fileName="pending-table-char-diff.md"
        baseContent={base}
        content={draft}
        pendingDiffEvent={{ id: 'evt-table-char-diff' } as any}
        onChange={vi.fn()}
      />
    );

    const cell = screen.getByLabelText('Table row 1 column 2');
    expect(cell.innerHTML.startsWith('55.0')).toBe(false);
    expect(cell.querySelector('[data-diff-op="insert"]')).toBeTruthy();
    expect(cell.querySelector('[data-diff-op="delete"]')).toBeTruthy();
  });

  it('removes inline diff markers after entering edit mode', async () => {
    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-pending-active"
        fileName="pending-active.md"
        baseContent={'Paragraph with old text'}
        content={'Paragraph with new text'}
        pendingDiffEvent={{ id: 'evt-2' } as any}
        onChange={vi.fn()}
      />
    );

    expect(container.querySelector('[data-diff-op="delete"]')).toBeTruthy();

    const paragraphBlock = getRenderedBlock(container, 'paragraph');
    expect(paragraphBlock).toBeTruthy();
    fireEvent.mouseDown(paragraphBlock!);

    await waitFor(() => {
      expect(container.querySelector('[data-diff-op="delete"]')).toBeNull();
      expect(container.querySelector('[data-diff-op="insert"]')).toBeNull();
    });
  });

  it('keeps list editing focused after updating an item', async () => {
    function Harness() {
      const initial = '- item one\n- item two';
      const [content, setContent] = useState(initial);
      return (
        <MarkdownDocumentEditor
          fileId="f-list-focus"
          fileName="list-focus.md"
          baseContent={initial}
          content={content}
          pendingDiffEvent={{ id: 'evt-list' } as any}
          onChange={setContent}
        />
      );
    }

    render(<Harness />);

    fireEvent.mouseDown(screen.getByText('item one'));

    const listTextbox = await waitFor(() => {
      const target = getTextboxByText('item one', 'List item');
      expect(target).toBeInTheDocument();
      return target!;
    });

    listTextbox.focus();
    inputContentEditable(listTextbox, 'item one updated');

    await waitFor(() => {
      const updated = getTextboxByText('item one updated', 'List item');
      expect(updated).toBeInTheDocument();
      expect(updated).toHaveFocus();
    });
  });

  it('falls back to a real empty paragraph line when pressing Enter on an empty list item', async () => {
    function Harness() {
      const initial = '- ';
      const [content, setContent] = useState(initial);
      return (
        <>
          <MarkdownDocumentEditor
            fileId="f-empty-list-exit"
            fileName="empty-list-exit.md"
            baseContent={initial}
            content={content}
            onChange={setContent}
          />
          <div data-testid="current-markdown">{content}</div>
        </>
      );
    }

    const { container } = render(<Harness />);

    const listBlock = getRenderedBlock(container, 'list');
    expect(listBlock).toBeTruthy();
    fireEvent.mouseDown(listBlock!);

    const listInput = await waitFor(() => {
      const element = screen.getByLabelText('List item') as HTMLElement;
      expect(element).toBeInTheDocument();
      return element;
    });
    listInput.focus();
    fireEvent.keyDown(listInput, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.queryByLabelText('List item')).not.toBeInTheDocument();
      expect(screen.getByTestId('markdown-empty-paragraph-line')).toBeInTheDocument();
      expect(getActiveMockTiptapContent()).toHaveFocus();
      expect(screen.getByTestId('current-markdown').textContent).toBe('\n');
    });
  });

  it('moves focus into a newly inserted empty list item before falling back to a paragraph line', async () => {
    function Harness() {
      const initial = ['- first item', '- second item'].join('\n');
      const [content, setContent] = useState(initial);
      return (
        <>
          <MarkdownDocumentEditor
            fileId="f-list-insert-focus"
            fileName="list-insert-focus.md"
            baseContent={initial}
            content={content}
            onChange={setContent}
          />
          <div data-testid="current-markdown">{content}</div>
        </>
      );
    }

    const { container } = render(<Harness />);

    const listBlock = getRenderedBlock(container, 'list');
    expect(listBlock).toBeTruthy();
    fireEvent.mouseDown(listBlock!);

    const secondItem = await waitFor(() => {
      const element = getTextboxByText('second item', 'List item');
      expect(element).toBeInTheDocument();
      return element!;
    });

    secondItem.focus();
    fireEvent.keyDown(secondItem, { key: 'Enter' });

    const emptyItem = await waitFor(() => {
      const items = screen.getAllByLabelText('List item') as HTMLElement[];
      expect(items).toHaveLength(3);
      expect(items[2]).toHaveFocus();
      expect((items[2].textContent || '').trim()).toBe('');
      return items[2];
    });

    fireEvent.keyDown(emptyItem, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByTestId('markdown-empty-paragraph-line')).toBeInTheDocument();
      expect(getActiveMockTiptapContent()).toHaveFocus();
      const listItems = container.querySelectorAll('[data-block-kind="list"] [aria-label="List item"]');
      expect(listItems).toHaveLength(2);
      expect(screen.getByTestId('current-markdown').textContent).toBe('- first item\n- second item\n');
    });
  });

  it('opens a real empty paragraph line after pressing Enter at the end of a paragraph block', async () => {
    function Harness() {
      const initial = ['First paragraph', '', 'Second paragraph'].join('\n');
      const [content, setContent] = useState(initial);
      return (
        <>
          <MarkdownDocumentEditor
            fileId="f-paragraph-enter"
            fileName="paragraph-enter.md"
            baseContent={initial}
            content={content}
            onChange={setContent}
          />
          <div data-testid="current-markdown">{content}</div>
        </>
      );
    }

    const { container } = render(<Harness />);

    const paragraphBlock = getRenderedBlock(container, 'paragraph');
    expect(paragraphBlock).toBeTruthy();
    fireEvent.mouseDown(paragraphBlock!);

    const activeEditor = await waitFor(() => {
      const element = getActiveMockTiptapContent();
      expect(element).toBeInTheDocument();
      return element!;
    });

    activeEditor.focus();
    fireEvent.keyDown(activeEditor, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByTestId('markdown-empty-paragraph-line')).toBeInTheDocument();
      expect(getActiveMockTiptapContent()).toHaveFocus();
      expect(screen.getByTestId('current-markdown').textContent).toBe('First paragraph\n\n\nSecond paragraph');
      expect(screen.getByTestId('mock-tiptap-placeholder')).toHaveTextContent('Type / for commands, or start writing...');
    });
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

    const mathBlock = getRenderedBlock(container, 'math');
    expect(mathBlock).toBeTruthy();
    fireEvent.mouseDown(mathBlock!);
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

    const htmlBlock = getRenderedBlock(container, 'html');
    expect(htmlBlock).toBeTruthy();
    fireEvent.mouseDown(htmlBlock!);
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

    const footnoteBlock = getRenderedBlock(container, 'footnote');
    expect(footnoteBlock).toBeTruthy();
    fireEvent.mouseDown(footnoteBlock!);
    const identifierInput = await waitFor(() => {
      const element = getTextboxByText('1', 'Footnote identifier');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });
    inputContentEditable(identifierInput, '2');

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('Paragraph[^2]\n\n[^2]: note');
    });
  });

  it('renders footnote references as superscripts in block preview', () => {
    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-footnote-preview"
        fileName="footnote-preview.md"
        baseContent={'Paragraph with footnote[^1].\n\n[^1]: note'}
        content={'Paragraph with footnote[^1].\n\n[^1]: note'}
        onChange={vi.fn()}
      />
    );

    expect(container.querySelector('[data-block-kind="paragraph"]')).toBeTruthy();
    expect((getTextboxByText('Paragraph with footnote[^1].')?.textContent || '')).toContain('Paragraph with footnote[^1].');
    expect(container.querySelector('[data-footnote-preview-row="0"]')).toBeTruthy();
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

    const imageBlock = getRenderedBlock(container, 'image');
    expect(imageBlock).toBeTruthy();
    fireEvent.mouseDown(imageBlock!);

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

    const codeBlock = getRenderedBlock(container, 'code');
    expect(codeBlock).toBeTruthy();
    fireEvent.mouseDown(codeBlock!);

    expect(await screen.findByTestId('mock-codemirror')).toBeInTheDocument();
    fireEvent.click(screen.getByText('mock-codemirror-change'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('```ts\nconst answer = 43;\n```');
    });
  });

  it('renders mermaid blocks with a live preview while editing the source', async () => {
    const onChange = vi.fn();

    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-mermaid"
        fileName="diagram.md"
        baseContent={'```mermaid\ngraph TD\n  A-->B\n```'}
        content={'```mermaid\ngraph TD\n  A-->B\n```'}
        onChange={onChange}
      />
    );

    const block = getRenderedBlock(container, 'code');
    expect(block).toBeTruthy();
    fireEvent.mouseDown(block!);

    const diagram = await screen.findByTestId('mock-mermaid-diagram');
    expect(diagram).toBeInTheDocument();
    expect(diagram.textContent).toContain('graph TD');
    expect(diagram.textContent).toContain('A-->B');

    fireEvent.click(screen.getByText('mock-codemirror-change'));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('```mermaid\nconst answer = 43;\n```');
    });
  });

  it('keeps mermaid blocks on diagram preview when not editing', () => {
    const markdown = '```mermaid\ngraph TD\n  A-->B\n```';
    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-mermaid-preview"
        fileName="mermaid-preview.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('mock-mermaid-diagram')).toBeInTheDocument();
    expect(container.querySelector('[data-block-kind="code"]')?.getAttribute('data-block-editor-chrome')).toBe('distinct');
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

    const tableBlock = getRenderedBlock(container, 'table');
    expect(tableBlock).toBeTruthy();
    fireEvent.mouseDown(tableBlock!);

    fireEvent.click(await screen.findByRole('button', { name: 'Remove row 1' }));
    await waitFor(() => {
      expect(getTextboxByText('1', 'Table row 1 column 1')).toBeUndefined();
      expect(getTextboxByText('2', 'Table row 1 column 2')).toBeUndefined();
      expect(getTextboxByText('3', 'Table row 1 column 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Remove column 2' }));
    await waitFor(() => {
      expect(getTextboxByText('B')).toBeUndefined();
      expect(getTextboxByText('4')).toBeUndefined();
      expect(getTextboxByText('A', 'Table header 1')).toBeInTheDocument();
      expect(getTextboxByText('3')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Remove column 2' })).not.toBeInTheDocument();
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

  it('focuses the clicked list item when entering list edit mode', async () => {
    const markdown = ['- bullet item', '- [ ] unchecked task', '- [x] finished task'].join('\n');

    render(
      <MarkdownDocumentEditor
        fileId="f-list-click-focus"
        fileName="list-click-focus.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    fireEvent.mouseDown(screen.getByText('unchecked task'));

    await waitFor(() => {
      expect(getTextboxByText('unchecked task', 'List item')).toHaveFocus();
    });
  });

  it('preserves the clicked list item text offset when entering list edit mode', async () => {
    const markdown = ['- First list item', '- Second list item'].join('\n');

    render(
      <MarkdownDocumentEditor
        fileId="f-list-click-offset"
        fileName="list-click-offset.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    const secondItem = screen.getByText('Second list item');
    const textNode = secondItem.firstChild;
    expect(textNode).toBeTruthy();
    const restoreCaretRangeFromPoint = setDocumentCaretRangeFromPoint(() => {
      const range = document.createRange();
      range.setStart(textNode!, 6);
      range.collapse(true);
      return range;
    });

    try {
      fireEvent.mouseDown(secondItem, { clientX: 82, clientY: 18 });

      await waitFor(() => {
        expect(getTextboxByText('Second list item', 'List item')).toHaveFocus();
        expect(window.getSelection()?.anchorNode?.textContent).toContain('Second list item');
        expect(window.getSelection()?.anchorOffset).toBe(6);
      });
    } finally {
      restoreCaretRangeFromPoint();
    }
  });

  it('preserves ordered-list delimiter style when editing items', async () => {
    const onChange = vi.fn();
    const markdown = '1) first\n2) second';

    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-list-style"
        fileName="list-style.md"
        baseContent={markdown}
        content={markdown}
        onChange={onChange}
      />
    );

    const listBlock = getRenderedBlock(container, 'list');
    expect(listBlock).toBeTruthy();
    fireEvent.mouseDown(listBlock!);

    const firstInput = await waitFor(() => {
      const element = getTextboxByText('first', 'List item');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });
    inputContentEditable(firstInput, 'updated first');

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('1) updated first\n2) second');
    });
  });

  it('moves within list items before leaving the list block', async () => {
    const markdown = ['- first item', '- second item', '', 'Paragraph after list'].join('\n');
    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-list-nav"
        fileName="list-nav.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    const listBlock = getRenderedBlock(container, 'list');
    expect(listBlock).toBeTruthy();
    fireEvent.mouseDown(listBlock!);

    const firstInput = await waitFor(() => {
      const element = getTextboxByText('first item', 'List item');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });
    const secondInput = getTextboxByText('second item', 'List item') as HTMLElement;
    firstInput.focus();
    fireEvent.keyDown(firstInput, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(document.activeElement).toBe(secondInput);
    });

    secondInput.focus();
    fireEvent.keyDown(secondInput, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(getActiveMockTiptapEditor()).toBeInTheDocument();
      expect(getActiveMockTiptapContent()?.textContent || '').toContain('Paragraph after list');
    });
  });

  it('keeps mixed task lists on the visual editor path', async () => {
    const markdown = ['- bullet item', '- [ ] unchecked task', '- [x] finished task'].join('\n');
    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-mixed-task-list"
        fileName="mixed-task-list.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    const taskBlock = getRenderedBlock(container, 'task_list');
    expect(taskBlock).toBeTruthy();
    fireEvent.mouseDown(taskBlock!);

    expect(screen.queryByTestId('raw-markdown-editor')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(getTextboxByText('bullet item', 'List item')).toBeInTheDocument();
      expect(getTextboxByText('unchecked task', 'List item')).toBeInTheDocument();
      expect(getTextboxByText('finished task', 'List item')).toBeInTheDocument();
    });
  });

  it('keeps ordinary structured blocks on the inline chrome path', () => {
    const markdown = ['- bullet item', '- second item', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-inline-chrome"
        fileName="inline-chrome.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    expect(container.querySelector('[data-block-kind="list"]')?.getAttribute('data-block-editor-chrome')).toBe('inline');
    expect(container.querySelector('[data-block-kind="table"]')?.getAttribute('data-block-editor-chrome')).toBe('inline');
  });

  it('preserves task-list bullet markers and table alignment when editing content', async () => {
    const onChange = vi.fn();
    const markdown = ['* [ ] task', '', '| A | B |', '| :--- | ---: |', '| 1 | 2 |'].join('\n');

    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-style-preserve"
        fileName="style-preserve.md"
        baseContent={markdown}
        content={markdown}
        onChange={onChange}
      />
    );

    const taskBlock = getRenderedBlock(container, 'task_list');
    expect(taskBlock).toBeTruthy();
    fireEvent.mouseDown(taskBlock!);
    const taskInput = await waitFor(() => {
      const element = getTextboxByText('task', 'List item');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });
    inputContentEditable(taskInput, 'updated task');

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('* [ ] updated task\n\n| A | B |\n| :--- | ---: |\n| 1 | 2 |');
    });

    const tableBlock = getRenderedBlock(container, 'table');
    expect(tableBlock).toBeTruthy();
    fireEvent.mouseDown(tableBlock!);
    const tableCell = await waitFor(() => {
      const element = getTextboxByText('2', 'Table row 1 column 2');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    });
    inputContentEditable(tableCell, '3');

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('* [ ] task\n\n| A | B |\n| :--- | ---: |\n| 1 | 3 |');
    });
  });

  it('moves within table cells by column before leaving the table block', async () => {
    const markdown = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |', '', 'Paragraph after table'].join('\n');
    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-table-nav"
        fileName="table-nav.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    const tableBlock = getRenderedBlock(container, 'table');
    expect(tableBlock).toBeTruthy();
    fireEvent.mouseDown(tableBlock!);

    const headerInput = (await waitFor(() => {
      const element = getTextboxByText('A', 'Table header 1');
      expect(element).toBeTruthy();
      return element as HTMLElement;
    })) as HTMLElement;
    headerInput.focus();
    fireEvent.keyDown(headerInput, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(document.activeElement).toBe(getTextboxByText('1', 'Table row 1 column 1'));
    });

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(document.activeElement).toBe(getTextboxByText('3', 'Table row 2 column 1'));
    });

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });

    await waitFor(() => {
      expect(getActiveMockTiptapEditor()).toBeInTheDocument();
      expect(getActiveMockTiptapContent()?.textContent || '').toContain('Paragraph after table');
    });
  });

  it('focuses the clicked table cell when entering table edit mode', async () => {
    const markdown = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');

    render(
      <MarkdownDocumentEditor
        fileId="f-table-click-focus"
        fileName="table-click-focus.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    fireEvent.mouseDown(screen.getByText('4'));

    await waitFor(() => {
      expect(getTextboxByText('4', 'Table row 2 column 2')).toHaveFocus();
    });
  });

  it('renders standalone image markdown as an image card instead of raw paragraph text', async () => {
    const markdown =
      '![chart](data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22%20viewBox%3D%220%200%20120%2072%22%3E%3Crect%20width%3D%22120%22%20height%3D%2272%22%20fill%3D%22%23fecaca%22/%3E%3C/svg%3E "Preview")';
    const { container } = render(
      <MarkdownDocumentEditor
        fileId="f-image-preview"
        fileName="image-preview.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    const imageBlock = getRenderedBlock(container, 'image');
    expect(imageBlock).toBeTruthy();
    expect(container.querySelector('[data-block-kind="image"] img')).toBeTruthy();
    expect(screen.queryByText(markdown)).not.toBeInTheDocument();

    fireEvent.mouseDown(imageBlock!);

    expect(await screen.findByPlaceholderText('Image URL')).toBeInTheDocument();
  });

  it('renders a visible footnote preview and focuses the matching field on click', async () => {
    const markdown = ['Paragraph with footnote[^1].', '', '[^1]: original note'].join('\n');

    render(
      <MarkdownDocumentEditor
        fileId="f-footnote-preview"
        fileName="footnote-preview.md"
        baseContent={markdown}
        content={markdown}
        onChange={vi.fn()}
      />
    );

    const footnoteLabel = document.querySelector('[data-footnote-preview-row="0"]') as HTMLElement | null;
    expect(footnoteLabel).toBeTruthy();
    fireEvent.mouseDown(footnoteLabel!);

    await waitFor(() => {
      expect(getTextboxByText('1', 'Footnote identifier')).toHaveFocus();
    });
  });
});
