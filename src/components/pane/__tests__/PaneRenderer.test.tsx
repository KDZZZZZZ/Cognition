import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneRenderer } from '../PaneRenderer';

const m = vi.hoisted(() => ({
  setActiveTab: vi.fn(),
  closeTab: vi.fn(),
  reorderTabs: vi.fn(),
  moveTabToPane: vi.fn(),
  openTab: vi.fn(),
  getAllOpenTabs: vi.fn(),
  closePane: vi.fn(),
  createPane: vi.fn(),
  setTabMode: vi.fn(),

  createTreeFile: vi.fn(),
  togglePermission: vi.fn(),
  setPermission: vi.fn(),

  setSessionId: vi.fn(),
  sendMessageForSession: vi.fn(),
  addSessionReference: vi.fn(),

  addVersion: vi.fn(),
  clearDiff: vi.fn(),

  getFileContent: vi.fn(),
  updateFileContent: vi.fn(),
  loadFiles: vi.fn(),
  setFileContentStatic: vi.fn(),
  getFileVersionsStatic: vi.fn(),
  rawEditorChangeSpy: vi.fn(),

  apiGetPendingDiffEvent: vi.fn(),
  apiUpdateViewport: vi.fn(),
  apiCreateFile: vi.fn(),
  apiGetFile: vi.fn(),
  apiUpdateDiffLineDecision: vi.fn(),
  apiUpdateDiffEventContent: vi.fn(),
  apiFinalizeDiffEvent: vi.fn(),

  paneStoreState: {} as any,
  sessionStoreState: {} as any,
  chatStoreState: {} as any,
  diffStoreState: {} as any,
  fileTreeState: {} as any,
  fileStoreState: { files: [] as any[] },
}));

vi.mock('../../../stores/paneStore', () => ({
  usePaneStore: () => m.paneStoreState,
}));

vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: () => m.sessionStoreState,
}));

vi.mock('../../../stores/chatStore', () => ({
  useChatStore: () => m.chatStoreState,
}));

vi.mock('../../../stores/versionStore', () => ({
  useVersionStore: () => ({ addVersion: m.addVersion }),
}));

vi.mock('../../../stores/diffStore', () => ({
  useDiffStore: () => m.diffStoreState,
}));

vi.mock('../../../stores/fileTreeStore', () => ({
  useFileTreeStore: () => m.fileTreeState,
}));

vi.mock('../../../stores/apiStore', () => ({
  useFileStore: Object.assign(
    () => ({
      getFileContent: m.getFileContent,
      updateFileContent: m.updateFileContent,
      files: m.fileStoreState.files,
      loadFiles: m.loadFiles,
    }),
    {
      getState: () => ({
        files: m.fileStoreState.files,
        setFileContent: m.setFileContentStatic,
        loadFiles: m.loadFiles,
        getFileVersions: m.getFileVersionsStatic,
      }),
    }
  ),
}));

vi.mock('../../editor/TiptapMarkdownEditor', () => ({
  TiptapMarkdownEditor: ({
    onChange,
    content,
    onAddReferenceToSession,
    onRunSelectionAction,
    defaultSessionId,
    sourceFile,
  }: {
    onChange: (value: string) => void;
    content?: string;
    onAddReferenceToSession?: (sessionId: string, reference: any) => void;
    onRunSelectionAction?: (params: any) => Promise<void> | void;
    defaultSessionId?: string;
    sourceFile?: { id: string; name: string };
  }) => (
    <div>
      <button onClick={() => onChange('updated content with enough delta')}>editor-change</button>
      <button onClick={() => onChange(content || '')}>editor-change-same</button>
      <button
        onClick={() =>
          onAddReferenceToSession?.(defaultSessionId || 's-1', {
            sourceFileId: sourceFile?.id || 'f-md',
            sourceFileName: sourceFile?.name || 'doc.md',
            markdown: '## selected markdown',
            plainText: 'selected markdown',
          })
        }
      >
        editor-add-ref
      </button>
      <button
        onClick={() =>
          onRunSelectionAction?.({
            action: 'fix',
            targetSessionId: defaultSessionId || 's-1',
            markdown: 'fix snippet',
            plainText: 'fix snippet',
            sourceFileId: sourceFile?.id || 'f-md',
            sourceFileName: sourceFile?.name || 'doc.md',
          })
        }
      >
        editor-run-fix
      </button>
      <button
        onClick={() =>
          onRunSelectionAction?.({
            action: 'check',
            targetSessionId: defaultSessionId || 's-1',
            markdown: 'check snippet',
            plainText: 'check snippet',
            sourceFileId: sourceFile?.id || 'f-md',
            sourceFileName: sourceFile?.name || 'doc.md',
          })
        }
      >
        editor-run-check
      </button>
    </div>
  ),
}));

vi.mock('../../editor/MarkdownDocumentEditor', () => ({
  MarkdownDocumentEditor: ({
    content,
    baseContent,
    pendingDiffEvent,
    onChange,
    onAddReferenceToSession,
    onRunSelectionAction,
    defaultSessionId,
    sourceFile,
  }: {
    content?: string;
    baseContent?: string;
    pendingDiffEvent?: any;
    onChange: (value: string) => void;
    onAddReferenceToSession?: (sessionId: string, reference: any) => void;
    onRunSelectionAction?: (params: any) => Promise<void> | void;
    defaultSessionId?: string;
    sourceFile?: { id: string; name: string };
  }) => (
    <div data-testid="markdown-document-editor">
      <div>MarkdownDocumentEditor</div>
      <div>{pendingDiffEvent ? 'MarkdownDocumentEditor-draft' : 'MarkdownDocumentEditor-clean'}</div>
      <div>{content}</div>
      <div>{baseContent}</div>
      <button onClick={() => onChange('updated content with enough delta')}>markdown-doc-change</button>
      <button onClick={() => onChange(content || '')}>markdown-doc-change-same</button>
      <button
        onClick={() =>
          onAddReferenceToSession?.(defaultSessionId || 's-1', {
            sourceFileId: sourceFile?.id || 'f-md',
            sourceFileName: sourceFile?.name || 'doc.md',
            markdown: '## selected markdown',
            plainText: 'selected markdown',
          })
        }
      >
        markdown-doc-add-ref
      </button>
      <button
        onClick={() =>
          onRunSelectionAction?.({
            action: 'fix',
            targetSessionId: defaultSessionId || 's-1',
            markdown: 'fix snippet',
            plainText: 'fix snippet',
            sourceFileId: sourceFile?.id || 'f-md',
            sourceFileName: sourceFile?.name || 'doc.md',
          })
        }
      >
        markdown-doc-run-fix
      </button>
      <button
        onClick={() =>
          onRunSelectionAction?.({
            action: 'check',
            targetSessionId: defaultSessionId || 's-1',
            markdown: 'check snippet',
            plainText: 'check snippet',
            sourceFileId: sourceFile?.id || 'f-md',
            sourceFileName: sourceFile?.name || 'doc.md',
          })
        }
      >
        markdown-doc-run-check
      </button>
    </div>
  ),
}));

vi.mock('../../editor/RawMarkdownEditor', () => ({
  RawMarkdownEditor: ({
    content,
    notice,
    onChange,
  }: {
    content?: string;
    notice?: string | null;
    onChange?: (value: string) => void;
  }) => (
    <div>
      <div>RawMarkdownEditor</div>
      <div>{notice}</div>
      <div>{content}</div>
      <button
        onClick={() => {
          m.rawEditorChangeSpy();
          onChange?.('raw editor updated content');
        }}
      >
        raw-editor-change
      </button>
    </div>
  ),
}));

vi.mock('../../session/SessionView', () => ({
  SessionView: ({ sessionId }: { sessionId: string }) => <div>SessionView-{sessionId}</div>,
}));

vi.mock('../../pdf/PDFViewer', () => ({
  PDFViewer: ({ filePath }: { filePath: string }) => <div>PDFViewer-{filePath}</div>,
}));

vi.mock('../../editor/RenderedDiffViewer', () => ({
  RenderedDiffViewer: ({
    mode,
    oldContent,
    newContent,
    pendingLines = [],
    onApplyLineDecision,
    onSelectLine,
  }: {
    mode: string;
    oldContent?: string;
    newContent?: string;
    pendingLines?: Array<{ id: string; line_no: number; decision: string }>;
    onApplyLineDecision?: (lineId: string, decision: 'accepted' | 'rejected') => void;
    onSelectLine?: (lineId: string) => void;
  }) => (
    <div>
      <div>RenderedDiffViewer-{mode}</div>
      <span className="diff-deletion">{oldContent || 'old-line'}</span>
      <span className="diff-addition">{newContent || 'new-line'}</span>
      {pendingLines
        .filter((line) => line.decision === 'pending')
        .map((line) => (
          <div
            key={line.id}
            onMouseEnter={() => onSelectLine?.(line.id)}
          >
            <button onClick={() => onApplyLineDecision?.(line.id, 'accepted')} aria-label={`Accept line ${line.line_no}`}>
              Accept
            </button>
            <button onClick={() => onApplyLineDecision?.(line.id, 'rejected')} aria-label={`Reject line ${line.line_no}`}>
              Reject
            </button>
          </div>
        ))}
    </div>
  ),
}));

vi.mock('../../ui/FileIcon', () => ({
  FileIcon: ({ type }: { type: string }) => <span>icon-{type}</span>,
}));

vi.mock('../../../api/client', () => ({
  BASE_URL: 'http://localhost:8000',
  api: {
    getPendingDiffEvent: (...args: any[]) => m.apiGetPendingDiffEvent(...args),
    updateViewport: (...args: any[]) => m.apiUpdateViewport(...args),
    createFile: (...args: any[]) => m.apiCreateFile(...args),
    getFile: (...args: any[]) => m.apiGetFile(...args),
    updateDiffLineDecision: (...args: any[]) => m.apiUpdateDiffLineDecision(...args),
    updateDiffEventContent: (...args: any[]) => m.apiUpdateDiffEventContent(...args),
    finalizeDiffEvent: (...args: any[]) => m.apiFinalizeDiffEvent(...args),
  },
}));

vi.mock('../../../config/runtime', () => ({
  getApiBaseUrl: () => 'http://localhost:8000',
}));

function createDataTransfer(seed: Record<string, string> = {}) {
  const data = { ...seed };
  return {
    setData: vi.fn((type: string, value: string) => {
      data[type] = value;
    }),
    getData: vi.fn((type: string) => data[type] || ''),
    effectAllowed: 'move',
    dropEffect: 'move',
  };
}

describe('PaneRenderer', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    m.paneStoreState = {
      setActiveTab: m.setActiveTab,
      closeTab: m.closeTab,
      reorderTabs: m.reorderTabs,
      moveTabToPane: m.moveTabToPane,
      openTab: m.openTab,
      getAllOpenTabs: m.getAllOpenTabs,
      closePane: m.closePane,
      createPane: m.createPane,
      setTabMode: m.setTabMode,
    };

    m.sessionStoreState = {
      permissions: { 's-1': { 'f-md': 'read' } },
      togglePermission: m.togglePermission,
      setPermission: m.setPermission,
    };

    m.chatStoreState = {
      sessionId: 's-1',
      setSessionId: m.setSessionId,
      sendMessageForSession: m.sendMessageForSession,
      addSessionReference: m.addSessionReference,
    };

    m.fileTreeState = { createFile: m.createTreeFile };

    m.diffStoreState = {
      activeDiff: null,
      clearDiff: m.clearDiff,
    };

    m.fileStoreState = { files: [] };

    m.getAllOpenTabs.mockReturnValue([
      { id: 'f-md', name: 'doc.md', type: 'md', mode: 'editor' },
      { id: 's-1', name: 'session', type: 'session', mode: 'editor' },
    ]);
    m.getFileContent.mockResolvedValue('old short');
    m.updateFileContent.mockResolvedValue(true);
    m.createTreeFile.mockResolvedValue('session-new');

    m.apiGetPendingDiffEvent.mockResolvedValue({ success: true, data: { event: null } });
    m.apiCreateFile.mockResolvedValue({ success: true, data: { file_id: 'new-md' } });
    m.apiGetFile.mockResolvedValue({ success: true, data: { url: '/uploads/a.pdf' } });
    m.apiFinalizeDiffEvent.mockResolvedValue({
      success: true,
      data: { final_content: 'final content' },
    });
    m.rawEditorChangeSpy.mockReset();
  });

  it('renders empty pane', () => {
    render(
      <PaneRenderer
        pane={{ id: 'p1', tabs: [], activeTabId: null }}
        isActive={false}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    expect(screen.getByText('Empty Pane')).toBeInTheDocument();
  });

  it('handles markdown editing and creating new tabs', async () => {
    render(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'f-md',
          tabs: [{ id: 'f-md', name: 'doc.md', type: 'md', mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(m.getFileContent).toHaveBeenCalledWith('f-md');
      expect(screen.getByText('markdown-doc-change')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('markdown-doc-change'));
    await new Promise((resolve) => setTimeout(resolve, 380));

    await waitFor(() => {
      expect(m.updateFileContent).toHaveBeenCalledWith('f-md', 'updated content with enough delta');
      expect(m.addVersion).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByTitle('New Tab'));
    fireEvent.click(screen.getByText('New Markdown'));

    await waitFor(() => {
      expect(m.apiCreateFile).toHaveBeenCalled();
      expect(m.openTab).toHaveBeenCalledWith('p1', expect.objectContaining({ id: 'new-md', type: 'md' }));
      expect(m.setActiveTab).toHaveBeenCalledWith('p1', 'new-md');
    });

    fireEvent.click(screen.getByTitle('New Tab'));
    fireEvent.click(screen.getByText('New Chat'));

    await waitFor(() => {
      expect(m.createTreeFile).toHaveBeenCalled();
      expect(m.setSessionId).toHaveBeenCalledWith('session-new');
      expect(m.setPermission).toHaveBeenCalled();
    });
  });

  it('does not save when editor echoes the current persisted content', async () => {
    render(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'f-md',
          tabs: [{ id: 'f-md', name: 'doc.md', type: 'md', mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(m.getFileContent).toHaveBeenCalledWith('f-md');
      expect(screen.getByText('markdown-doc-change-same')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('markdown-doc-change-same'));
    await new Promise((resolve) => setTimeout(resolve, 380));

    expect(m.updateFileContent).not.toHaveBeenCalled();
    expect(m.addVersion).not.toHaveBeenCalled();
  });

  it('handles diff/pdf/session branches', async () => {
    m.diffStoreState = {
      activeDiff: {
        fileId: 'f-md',
        versionId: 'v1',
        oldContent: 'old',
        newContent: 'new',
        versionLabel: 'v1',
      },
      clearDiff: m.clearDiff,
    };

    const { rerender } = render(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'f-md',
          tabs: [{ id: 'f-md', name: 'doc.md', type: 'md', mode: 'diff' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    expect(screen.getByText('RenderedDiffViewer-split')).toBeInTheDocument();
    expect(within(screen.getByTestId('history-diff-original-pane')).getByText('old')).toBeInTheDocument();
    expect(within(screen.getByTestId('history-diff-rendered-pane')).getByText('RenderedDiffViewer-split')).toBeInTheDocument();
    expect(screen.getByTestId('history-diff-original-scroll')).toHaveAttribute('tabindex', '0');
    fireEvent.click(screen.getByText('Accept All'));

    await waitFor(() => {
      expect(m.updateFileContent).toHaveBeenCalledWith('f-md', 'new');
      expect(m.clearDiff).toHaveBeenCalled();
      expect(m.setTabMode).toHaveBeenCalledWith('p1', 'f-md', 'editor');
    });

    rerender(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'pdf-1',
          tabs: [{ id: 'pdf-1', name: 'book.pdf', type: 'pdf', mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('PDFViewer-http://localhost:8000/uploads/a.pdf')).toBeInTheDocument();
    });

    rerender(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 's-1',
          tabs: [{ id: 's-1', name: 'chat', type: 'session', mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    expect(screen.getByText('SessionView-s-1')).toBeInTheDocument();
  });

  it('opens rich no-diff markdown notes in the unified document editor shell', async () => {
    m.getFileContent.mockResolvedValue('---\ntitle: Example\n---\n\n> [!NOTE] Callout body\n\n- [ ] task\n\n| Metric | Value |\n| --- | --- |\n| MMLU | 54.1 |\n\n<div>html</div>\n\nParagraph with footnote[^1].\n\n[^1]: note\n');

    render(
      <PaneRenderer
        pane={{
          id: 'p-raw',
          activeTabId: 'md-raw',
          tabs: [{ id: 'md-raw', name: 'raw.md', type: 'md', mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    expect(await screen.findByTestId('markdown-document-editor')).toBeInTheDocument();
    expect(screen.getByText('MarkdownDocumentEditor-clean')).toBeInTheDocument();
    expect(screen.queryByText('RawMarkdownEditor')).not.toBeInTheDocument();
    expect(screen.queryByText(/Raw Markdown mode to preserve/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('markdown-doc-change'));
    await new Promise((resolve) => setTimeout(resolve, 380));

    await waitFor(() => {
      expect(m.updateFileContent).toHaveBeenCalledWith('md-raw', 'updated content with enough delta');
    });
  });

  it('loads rich pending diffs into the unified draft editor shell', async () => {
    m.getFileContent.mockResolvedValue('---\ntitle: Example\n---\n\n- [ ] task\n\n| Metric | Value |\n| --- | --- |\n| MMLU | 54.1 |\n\n<div>html</div>\n\nParagraph with footnote[^1].\n\n[^1]: note\n');
    m.apiGetPendingDiffEvent
      .mockResolvedValueOnce({
        success: true,
        data: {
          event: {
            id: 'event-rich',
            old_content: 'old task list',
            new_content: 'new task list',
            effective_content: 'new task list',
            summary: 'rich markdown pending',
            lines: [{ id: 'rich-line-1', line_no: 1, old_line: 'old task list', new_line: 'new task list', decision: 'pending' }],
          },
        },
      });
    m.apiUpdateDiffEventContent.mockResolvedValue({
      success: true,
      data: {
        event: {
          id: 'event-rich',
          old_content: 'old task list',
          new_content: 'updated content with enough delta',
          effective_content: 'updated content with enough delta',
          summary: 'rich markdown pending',
          lines: [{ id: 'rich-line-1', line_no: 1, old_line: 'old task list', new_line: 'updated content with enough delta', decision: 'pending' }],
        },
      },
    });

    render(
      <PaneRenderer
        pane={{
          id: 'p-rich',
          activeTabId: 'md-rich',
          tabs: [{ id: 'md-rich', name: 'rich.md', type: 'md', mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('rich markdown pending')).toBeInTheDocument();
    });

    expect(screen.getByText('MarkdownDocumentEditor-draft')).toBeInTheDocument();
    fireEvent.click(screen.getByText('markdown-doc-change'));

    await waitFor(() => {
      expect(m.apiUpdateDiffEventContent).toHaveBeenCalledWith(
        'md-rich',
        'event-rich',
        expect.objectContaining({
          newContent: 'updated content with enough delta',
          author: 'human',
        })
      );
    });

    expect(screen.queryByText('RawMarkdownEditor')).not.toBeInTheDocument();
    expect(screen.queryByText(/Raw Markdown mode to preserve/)).not.toBeInTheDocument();
  });

  it('applies pending diff finalization actions', async () => {
    m.apiGetPendingDiffEvent.mockResolvedValue({
      success: true,
      data: {
        event: {
          id: 'event-1',
          old_content: 'old a',
          new_content: 'new a',
          summary: 'pending',
          lines: [{ id: 'l1', line_no: 1, old_line: 'old a', new_line: 'new a', decision: 'pending' }],
        },
      },
    });

    render(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'f-md',
          tabs: [{ id: 'f-md', name: 'doc.md', type: 'md', mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('pending')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Accept All'));

    await waitFor(() => {
      expect(m.apiFinalizeDiffEvent).toHaveBeenCalledWith(
        'f-md',
        'event-1',
        expect.objectContaining({ finalContent: 'new a' })
      );
      expect(m.setFileContentStatic).toHaveBeenCalledWith('f-md', 'final content');
      expect(m.loadFiles).toHaveBeenCalled();
      expect(m.getFileVersionsStatic).toHaveBeenCalledWith('f-md');
    });
  });

  it('supports tab drag reordering, cross-pane move, and pane drop fallback', async () => {
    const onDrop = vi.fn();
    const { container } = render(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'f-md',
          tabs: [
            { id: 'f-md', name: 'doc.md', type: 'md', mode: 'editor' },
            { id: 'f2', name: 'notes.md', type: 'md', mode: 'editor' },
          ],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={onDrop}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('doc.md')).toBeInTheDocument();
    });

    const tab1 = screen.getByText('doc.md').closest('[draggable="true"]') as HTMLElement;
    const tab2 = screen.getByText('notes.md').closest('[draggable="true"]') as HTMLElement;

    const reorderDt = createDataTransfer();
    fireEvent.dragStart(tab1, { dataTransfer: reorderDt });
    fireEvent.dragOver(tab2, { dataTransfer: reorderDt });
    fireEvent.drop(tab2, { dataTransfer: reorderDt });
    expect(m.reorderTabs).toHaveBeenCalledWith('p1', 0, 1);

    const crossPaneDt = createDataTransfer({
      'application/x-tab-drag': JSON.stringify({
        sourcePaneId: 'p2',
        tabId: 'cross-tab',
        fromIndex: 0,
      }),
    });
    fireEvent.drop(tab2, { dataTransfer: crossPaneDt });
    expect(m.moveTabToPane).toHaveBeenCalledWith('p2', 'p1', 'cross-tab', 1);

    const paneRoot = container.firstElementChild as HTMLElement;
    const fileDropDt = createDataTransfer({ 'application/x-tab-drag': '' });
    fireEvent.drop(paneRoot, { dataTransfer: fileDropDt });
    expect(onDrop).toHaveBeenCalled();

    const paneTabDt = createDataTransfer({
      'application/x-tab-drag': JSON.stringify({
        sourcePaneId: 'pane-x',
        tabId: 'tab-x',
        fromIndex: 0,
      }),
    });
    fireEvent.drop(paneRoot, { dataTransfer: paneTabDt });
    expect(m.moveTabToPane).toHaveBeenCalledWith('pane-x', 'p1', 'tab-x');
  });

  it('handles diff mode controls including reject/exit and empty diff fallback', async () => {
    m.diffStoreState = {
      activeDiff: {
        fileId: 'f-md',
        versionId: 'v1',
        oldContent: 'old diff',
        newContent: 'new diff',
        versionLabel: 'v1',
      },
      clearDiff: m.clearDiff,
    };

    const { rerender } = render(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'f-md',
          tabs: [{ id: 'f-md', name: 'doc.md', type: 'md', mode: 'diff' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    expect(screen.getByText('RenderedDiffViewer-split')).toBeInTheDocument();
    expect(within(screen.getByTestId('history-diff-original-pane')).getByText('old diff')).toBeInTheDocument();
    expect(within(screen.getByTestId('history-diff-rendered-pane')).getByText('RenderedDiffViewer-split')).toBeInTheDocument();
    expect(screen.queryByText('Inline')).not.toBeInTheDocument();
    expect(screen.queryByText('Split')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Reject All'));
    expect(m.updateFileContent).toHaveBeenCalledWith('f-md', 'old diff');

    fireEvent.click(screen.getByText('Exit Diff'));
    expect(m.setTabMode).toHaveBeenCalledWith('p1', 'f-md', 'editor');

    m.diffStoreState = {
      activeDiff: null,
      clearDiff: m.clearDiff,
    };
    rerender(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'f-md',
          tabs: [{ id: 'f-md', name: 'doc.md', type: 'md', mode: 'diff' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );
    expect(screen.getByText('No diff data available')).toBeInTheDocument();
  });

  it('updates pending diff drafts in place, rejects all, and handles markdown create fallback', async () => {
    const pending = {
      id: 'event-2',
      old_content: 'old original',
      new_content: 'new changed',
      effective_content: 'new changed',
      summary: 'pending review',
      lines: [
        { id: 'l1', line_no: 1, old_line: 'old original', new_line: 'new changed', decision: 'pending' },
      ],
    };
    m.apiGetPendingDiffEvent.mockResolvedValue({ success: true, data: { event: pending } });
    m.apiUpdateDiffEventContent.mockResolvedValue({ success: true, data: { event: pending } });
    m.apiCreateFile.mockRejectedValueOnce(new Error('create failed'));

    render(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'f-md',
          tabs: [{ id: 'f-md', name: 'doc.md', type: 'md', mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('pending review')).toBeInTheDocument();
    });
    expect(screen.getByText('MarkdownDocumentEditor-draft')).toBeInTheDocument();

    fireEvent.click(screen.getByText('markdown-doc-change'));
    await waitFor(() => {
      expect(m.apiUpdateDiffEventContent).toHaveBeenCalledWith(
        'f-md',
        'event-2',
        expect.objectContaining({ newContent: 'updated content with enough delta' })
      );
    });

    fireEvent.click(screen.getByText('Reject All'));
    await waitFor(() => {
      expect(m.apiFinalizeDiffEvent).toHaveBeenCalledWith(
        'f-md',
        'event-2',
        expect.objectContaining({
          finalContent: 'old original',
          summary: 'Reject all pending diff lines',
        })
      );
    });

    fireEvent.click(screen.getByTitle('New Tab'));
    fireEvent.click(screen.getByText('New Markdown'));
    await waitFor(() => {
      expect(m.openTab).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          name: 'Untitled.md',
          type: 'md',
        })
      );
    });
  });

  it('forwards editor reference import and both selection actions', async () => {
    render(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'f-md',
          tabs: [{ id: 'f-md', name: 'doc.md', type: 'md', mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('markdown-doc-add-ref')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('markdown-doc-add-ref'));
    expect(m.addSessionReference).toHaveBeenCalledWith(
      's-1',
      expect.objectContaining({
        sourceFileId: 'f-md',
        sourceFileName: 'doc.md',
      })
    );

    fireEvent.click(screen.getByText('markdown-doc-run-fix'));
    fireEvent.click(screen.getByText('markdown-doc-run-check'));
    await waitFor(() => {
      expect(m.sendMessageForSession).toHaveBeenCalledTimes(2);
    });
    const prompts = m.sendMessageForSession.mock.calls.map((call) => String(call[1]));
    expect(prompts.some((item) => item.includes('请修正以下选中内容'))).toBe(true);
    expect(prompts.some((item) => item.includes('请检查以下选中内容的问题'))).toBe(true);
  });

  it('handles malformed drag payloads without calling tab move operations', async () => {
    const { container } = render(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'f-md',
          tabs: [
            { id: 'f-md', name: 'doc.md', type: 'md', mode: 'editor' },
            { id: 'f2', name: 'notes.md', type: 'md', mode: 'editor' },
          ],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('doc.md')).toBeInTheDocument();
    });

    const tab2 = screen.getByText('notes.md').closest('[draggable="true"]') as HTMLElement;
    const badDt = createDataTransfer({ 'application/x-tab-drag': '{"bad":' });
    fireEvent.drop(tab2, { dataTransfer: badDt });

    const paneRoot = container.firstElementChild as HTMLElement;
    fireEvent.drop(paneRoot, { dataTransfer: badDt });

    expect(m.reorderTabs).not.toHaveBeenCalled();
  });

  it('resolves pdf source via existing list and load fallback', async () => {
    m.fileStoreState = {
      files: [{ id: 'pdf-1', url: 'http://cdn.local/doc.pdf' }],
    };

    const { rerender } = render(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'pdf-1',
          tabs: [{ id: 'pdf-1', name: 'paper.pdf', type: 'pdf', mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('PDFViewer-http://cdn.local/doc.pdf')).toBeInTheDocument();
    });
    expect(m.loadFiles).not.toHaveBeenCalled();

    m.fileStoreState = { files: [] };
    m.loadFiles.mockImplementation(async () => {
      m.fileStoreState = {
        files: [{ id: 'pdf-2', url: '/uploads/from-load.pdf' }],
      };
    });

    rerender(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'pdf-2',
          tabs: [{ id: 'pdf-2', name: 'paper2.pdf', type: 'pdf', mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('PDFViewer-http://localhost:8000/uploads/from-load.pdf')).toBeInTheDocument();
    });
  });

  it('covers pending diff fallback labels, final content fallback, and generic viewer branch', async () => {
    m.getFileContent.mockResolvedValueOnce(null);
    m.apiGetPendingDiffEvent.mockResolvedValue({
      success: true,
      data: {
        event: {
          id: 'event-fallback',
          old_content: 'old-fallback',
          new_content: 'new-a\ny',
          effective_content: 'new-a\ny',
          summary: '',
          lines: [
            { id: 'p1', line_no: 1, old_line: 'old-a', new_line: 'new-a', decision: 'pending' },
            { id: 'p2', line_no: 2, old_line: 'x', new_line: 'y', decision: 'pending' },
          ],
        },
      },
    });
    m.apiFinalizeDiffEvent.mockResolvedValueOnce({ success: true, data: {} });
    m.apiCreateFile.mockResolvedValueOnce({ success: true, data: {} });
    m.createTreeFile.mockResolvedValueOnce(null);

    const { rerender } = render(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'f-md',
          tabs: [{ id: 'f-md', name: 'doc.md', type: 'md', mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Pending Agent Diff')).toBeInTheDocument();
      expect(screen.getByText('2 pending lines')).toBeInTheDocument();
      expect(screen.getByText('MarkdownDocumentEditor-draft')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Accept All'));
    await waitFor(() => {
      expect(m.apiFinalizeDiffEvent).toHaveBeenCalledWith(
        'f-md',
        'event-fallback',
        expect.objectContaining({ finalContent: 'new-a\ny' })
      );
      expect(m.setFileContentStatic).toHaveBeenCalledWith('f-md', 'new-a\ny');
    });

    fireEvent.click(screen.getByTitle('New Tab'));
    fireEvent.click(screen.getByText('New Markdown'));
    await waitFor(() => {
      expect(m.openTab).toHaveBeenCalledWith('p1', expect.objectContaining({ id: expect.stringMatching(/^new-/) }));
    });

    fireEvent.click(screen.getByTitle('New Tab'));
    fireEvent.click(screen.getByText('New Chat'));
    await waitFor(() => {
      expect(m.setSessionId).toHaveBeenCalledWith(expect.stringMatching(/^chat-/));
    });

    rerender(
      <PaneRenderer
        pane={{
          id: 'p1',
          activeTabId: 'file-generic',
          tabs: [{ id: 'file-generic', name: 'unknown.bin', type: 'txt' as any, mode: 'editor' }],
        }}
        isActive={true}
        onActivate={vi.fn()}
        onDragOver={vi.fn()}
        onDragLeave={vi.fn()}
        onDrop={vi.fn()}
      />
    );
    expect(screen.getByText('Generic Viewer')).toBeInTheDocument();
  });
});
