import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TiptapMarkdownEditor, type TiptapMarkdownEditorRef } from '../TiptapMarkdownEditor';

const m = vi.hoisted(() => ({
  editor: null as any,
  lastConfig: null as any,
  currentMarkdown: 'initial markdown',
  selectionMarkdown: '# Selected Heading',
  selectionText: 'Selected Heading',
  deleteRun: vi.fn(),
  insertContent: vi.fn(),
  setContent: vi.fn(),
  focus: vi.fn(),
  setLink: vi.fn(),
  unsetLink: vi.fn(),
  setTextSelection: vi.fn(),
  clipboardWriteText: vi.fn(),
}));

function buildEditor() {
  m.deleteRun = vi.fn();
  m.insertContent = vi.fn();
  m.setContent = vi.fn((value: string) => {
    m.currentMarkdown = value;
  });
  m.focus = vi.fn();
  m.setLink = vi.fn();
  m.unsetLink = vi.fn();
  m.setTextSelection = vi.fn();
  return {
    storage: {
      markdown: {
        getMarkdown: () => m.currentMarkdown,
        serializer: {
          serialize: () => m.selectionMarkdown,
        },
      },
    },
    state: {
      selection: {
        empty: false,
        from: 1,
        to: 8,
        content: () => ({ content: {} }),
      },
      doc: {
        textBetween: () => m.selectionText,
      },
    },
    commands: {
      setContent: m.setContent,
      focus: m.focus,
      insertContent: m.insertContent,
    },
    chain: () => {
      let deleteSelectionRequested = false;
      const chain: any = {
        focus: () => chain,
        deleteSelection: () => {
          deleteSelectionRequested = true;
          return chain;
        },
        extendMarkRange: () => chain,
        setLink: (attrs: any) => {
          m.setLink(attrs);
          return chain;
        },
        unsetLink: () => {
          m.unsetLink();
          return chain;
        },
        setTextSelection: (selection: any) => {
          m.setTextSelection(selection);
          return chain;
        },
        command: () => chain,
        run: () => {
          if (deleteSelectionRequested) {
            m.deleteRun();
          }
          return true;
        },
      };
      return chain;
    },
    getAttributes: (name: string) => (name === 'link' ? { href: 'https://example.com', title: 'Example' } : {}),
    getText: () => m.currentMarkdown,
  };
}

vi.mock('@tiptap/react', () => ({
  useEditor: (config: any) => {
    m.lastConfig = config;
    return m.editor;
  },
  EditorContent: () => <div data-testid="editor-content">EditorContent</div>,
  Editor: class {},
}));

vi.mock('@tiptap/starter-kit', () => ({
  default: { configure: () => ({ name: 'starter-kit' }) },
}));

vi.mock('@tiptap/extension-image', () => ({
  default: { configure: () => ({ name: 'image-extension' }) },
}));

vi.mock('@tiptap/extension-link', () => ({
  default: { configure: () => ({ name: 'link-extension' }) },
}));

vi.mock('@tiptap/extension-placeholder', () => ({
  default: { configure: () => ({ name: 'placeholder' }) },
}));

vi.mock('@aarkue/tiptap-math-extension', () => ({
  MathExtension: { configure: () => ({ name: 'math-extension' }) },
}));

vi.mock('tiptap-markdown', () => ({
  Markdown: { configure: () => ({ name: 'markdown' }) },
}));

vi.mock('../SlashCommands', () => ({
  SlashCommands: { configure: () => ({ name: 'slash' }) },
  slashCommandsSuggestion: {},
}));

vi.mock('../extensions/InlineMathEnterFix', () => ({
  InlineMathEnterFix: { name: 'inline-math-enter-fix' },
}));

vi.mock('../extensions/InlineMathMarkdownStorage', () => ({
  InlineMathMarkdownStorage: { name: 'inline-math-markdown-storage' },
}));

vi.mock('../extensions/MarkdownTokenVisibility', () => ({
  MarkdownTokenVisibility: { name: 'markdown-token-visibility' },
}));

vi.mock('../extensions/MathSyntaxBridge', () => ({
  MathSyntaxBridge: { name: 'math-syntax-bridge' },
  createBridgeTransaction: vi.fn(() => null),
}));

describe('TiptapMarkdownEditor component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.currentMarkdown = 'initial markdown';
    m.selectionMarkdown = '# Selected Heading';
    m.selectionText = 'Selected Heading';
    m.editor = buildEditor();
    m.lastConfig = null;

    m.clipboardWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: m.clipboardWriteText },
    });
  });

  it('renders loading fallback when editor is not ready', () => {
    m.editor = null;
    render(<TiptapMarkdownEditor />);
    expect(screen.getByText('Loading editor...')).toBeInTheDocument();
  });

  it('handles update/blur, imperative APIs and clipboard DOM handlers', async () => {
    const onChange = vi.fn();
    const onBlur = vi.fn();
    const ref = createRef<TiptapMarkdownEditorRef>();

    render(<TiptapMarkdownEditor ref={ref} content="initial markdown" onChange={onChange} onBlur={onBlur} />);

    expect(screen.getByTestId('editor-content')).toBeInTheDocument();
    expect(m.lastConfig.extensions.some((extension: { name?: string }) => extension?.name === 'markdown-token-visibility')).toBe(true);

    act(() => {
      m.lastConfig.editorProps.handleDOMEvents.keydown(null, new KeyboardEvent('keydown', { key: 'a' }));
      m.lastConfig.onUpdate({ editor: m.editor });
      m.lastConfig.onBlur();
    });
    expect(onChange).toHaveBeenCalledWith('initial markdown');
    expect(onBlur).toHaveBeenCalled();

    expect(ref.current?.getMarkdown()).toBe('initial markdown');
    act(() => {
      ref.current?.setMarkdown('ref set markdown');
      ref.current?.focus();
    });
    expect(m.setContent).toHaveBeenCalledWith('ref set markdown', { emitUpdate: false });
    expect(m.focus).toHaveBeenCalled();

    const clipboardData = {
      clearData: vi.fn(),
      setData: vi.fn(),
      getData: vi.fn().mockReturnValue('# H1\n\nbody'),
    };
    const copyEvent = { clipboardData, preventDefault: vi.fn() } as any;
    const cutEvent = { clipboardData, preventDefault: vi.fn() } as any;
    const pasteEvent = { clipboardData } as any;

    expect(m.lastConfig.editorProps.handleDOMEvents.copy(null, copyEvent)).toBe(true);
    expect(m.lastConfig.editorProps.handleDOMEvents.cut(null, cutEvent)).toBe(true);
    expect(m.deleteRun).toHaveBeenCalled();
    expect(m.lastConfig.editorProps.handlePaste(null, pasteEvent, null)).toBe(true);
    expect(m.insertContent).toHaveBeenCalled();
  });

  it('suppresses markdown echo before user editing begins', () => {
    const onChange = vi.fn();
    m.currentMarkdown = '| Metric | Value |';

    render(<TiptapMarkdownEditor content="| Metric | Value |" onChange={onChange} />);

    act(() => {
      m.lastConfig.onUpdate({ editor: m.editor });
    });
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      m.lastConfig.editorProps.handleDOMEvents.keydown(null, new KeyboardEvent('keydown', { key: 'a' }));
      m.lastConfig.onUpdate({ editor: m.editor });
    });
    expect(onChange).toHaveBeenCalledWith('| Metric | Value |');
  });

  it('defers external content sync while IME composition is active', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<TiptapMarkdownEditor content="initial markdown" onChange={onChange} />);

    act(() => {
      m.lastConfig.editorProps.handleDOMEvents.compositionstart(null, {} as any);
      m.currentMarkdown = '你';
      m.lastConfig.onUpdate({ editor: m.editor });
    });
    expect(onChange).not.toHaveBeenCalled();

    rerender(<TiptapMarkdownEditor content="stale parent content" onChange={onChange} />);
    expect(m.setContent).not.toHaveBeenCalledWith('stale parent content', { emitUpdate: false });

    act(() => {
      m.currentMarkdown = '你好';
      m.lastConfig.editorProps.handleDOMEvents.compositionend(null, {} as any);
    });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith('你好');
    });
  });

  it('renders context menu and temporary dialog actions', async () => {
    const onAddReferenceToSession = vi.fn();
    const onRunSelectionAction = vi.fn().mockResolvedValue(undefined);

    render(
      <TiptapMarkdownEditor
        content="hello"
        availableSessions={[{ id: 's1', name: 'Session A' }]}
        defaultSessionId="s1"
        sourceFile={{ id: 'f1', name: 'file.md' }}
        onAddReferenceToSession={onAddReferenceToSession}
        onRunSelectionAction={onRunSelectionAction}
      />
    );

    const contextEvent = {
      clientX: 24,
      clientY: 48,
      target: document.body,
      preventDefault: vi.fn(),
    } as any;
    act(() => {
      m.lastConfig.editorProps.handleDOMEvents.contextmenu(null, contextEvent);
    });

    expect(await screen.findByText('Copy Selection as Markdown')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Copy Selection as Markdown'));
    await waitFor(() => {
      expect(m.clipboardWriteText).toHaveBeenCalled();
    });

    act(() => {
      m.lastConfig.editorProps.handleDOMEvents.contextmenu(null, contextEvent);
    });
    fireEvent.click(screen.getByText('Session A'));
    expect(onAddReferenceToSession).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ sourceFileId: 'f1', sourceFileName: 'file.md' })
    );

    act(() => {
      m.lastConfig.editorProps.handleDOMEvents.contextmenu(null, contextEvent);
    });
    fireEvent.click(screen.getByText('Open Temporary Dialog (Fix / Check)'));
    fireEvent.click(screen.getByText('Check Selection'));

    await waitFor(() => {
      expect(onRunSelectionAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'check', targetSessionId: 's1', sourceFileId: 'f1' })
      );
      expect(screen.getByText(/Sent to session/)).toBeInTheDocument();
    });
  });

  it('opens the link inspector with Cmd/Ctrl+K and applies link updates', async () => {
    render(<TiptapMarkdownEditor content="linked" />);

    act(() => {
      m.lastConfig.editorProps.handleDOMEvents.keydown(
        null,
        new KeyboardEvent('keydown', { key: 'k', metaKey: true })
      );
    });

    expect(await screen.findByText('Edit Link')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('https://example.com'), {
      target: { value: 'https://openai.com' },
    });
    fireEvent.click(screen.getByText('Apply'));

    expect(m.setLink).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'https://openai.com', title: 'Example' })
    );
  });

  it('skips local echo content sync and applies remote updates', () => {
    const { rerender } = render(<TiptapMarkdownEditor content="initial markdown" />);
    act(() => {
      m.lastConfig.onUpdate({ editor: m.editor });
    });

    // same content fingerprint from local edit should not call setContent
    rerender(<TiptapMarkdownEditor content="initial markdown" />);
    expect(m.setContent).not.toHaveBeenCalledWith('initial markdown');

    rerender(<TiptapMarkdownEditor content="remote update markdown" />);
    expect(m.setContent).toHaveBeenCalledWith('remote update markdown', { emitUpdate: false });
  });

  it('covers selection/context-menu fallbacks and no-session dialog branches', async () => {
    const resolveAction: Array<() => void> = [];
    const onRunSelectionAction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAction.push(resolve);
        })
    );
    const onAddReferenceToSession = vi.fn();

    // serializer fallback to plain-text extraction path
    (m.editor.storage.markdown as any).serializer = undefined;
    m.selectionText = '# fallback from textBetween';
    render(
      <TiptapMarkdownEditor
        content={undefined}
        availableSessions={[]}
        onRunSelectionAction={onRunSelectionAction}
        onAddReferenceToSession={onAddReferenceToSession}
      />
    );

    const contextEvent = {
      clientX: 16,
      clientY: 20,
      target: document.body,
      preventDefault: vi.fn(),
    } as any;
    act(() => {
      m.lastConfig.editorProps.handleDOMEvents.contextmenu(null, contextEvent);
    });
    expect(await screen.findByText('No open sessions.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Open Temporary Dialog (Fix / Check)'));
    expect(screen.getByText('No open sessions')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Close'));

    // markdown undefined branch in normalization path (copy returns false)
    (m.editor.storage.markdown as any).serializer = {
      serialize: () => undefined,
    };
    m.selectionText = '# should not copy';
    const copyResult = m.lastConfig.editorProps.handleDOMEvents.copy(
      null,
      { clipboardData: { clearData: vi.fn(), setData: vi.fn() }, preventDefault: vi.fn() } as any
    );
    expect(copyResult).toBe(false);

    // plainText.trim() fallback to markdown + session target fallback label
    (m.editor.storage.markdown as any).serializer = {
      serialize: () => '# markdown-only',
    };
    m.selectionText = '   ';
    render(
      <TiptapMarkdownEditor
        content="value"
        availableSessions={[{ id: 's1', name: 'Session A' }]}
        defaultSessionId="ghost-session"
        sourceFile={{ id: 'f1', name: 'file.md' }}
        onRunSelectionAction={onRunSelectionAction}
        onAddReferenceToSession={onAddReferenceToSession}
      />
    );

    act(() => {
      m.lastConfig.editorProps.handleDOMEvents.contextmenu(null, contextEvent);
    });
    fireEvent.click(screen.getAllByText('Open Temporary Dialog (Fix / Check)')[0]);
    fireEvent.click(screen.getByText('Fix Selection'));
    // close dialog before async action resolves to hit prev-null guard branch
    fireEvent.click(document.querySelector('.fixed.inset-0.z-\\[85\\]') as Element);
    resolveAction.forEach((fn) => fn());

    await waitFor(() => {
      expect(onRunSelectionAction).toHaveBeenCalledWith(
        expect.objectContaining({
          targetSessionId: 'ghost-session',
          plainText: '# markdown-only',
        })
      );
    });
  });
});
