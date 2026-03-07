import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { X, Split, Download, GitCommit, GripVertical, Plus, MessageSquare, FileText, Loader2 } from 'lucide-react';
import { Pane } from '../../types';
import { TiptapMarkdownEditor } from '../editor/TiptapMarkdownEditor';
import { SessionView } from '../session/SessionView';
import { PDFViewer } from '../pdf/PDFViewer';
import { RenderedDiffViewer } from '../editor/RenderedDiffViewer';
import { usePaneStore } from '../../stores/paneStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useFileStore } from '../../stores/apiStore';
import { useFileTreeStore } from '../../stores/fileTreeStore';
import { useChatStore } from '../../stores/chatStore';
import { useVersionStore } from '../../stores/versionStore';
import { useDiffStore } from '../../stores/diffStore';
import { FileIcon } from '../ui/FileIcon';
import { api, BASE_URL, DiffEventDTO } from '../../api/client';
import { ViewMode, Permission } from '../../types';

interface PaneRendererProps {
  pane: Pane;
  isActive: boolean;
  onActivate: () => void;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}

interface TabDragData {
  sourcePaneId: string;
  tabId: string;
  fromIndex: number;
}

const TAB_DRAG_MIME_TYPE = 'application/x-tab-drag';
let activeTabDragData: TabDragData | null = null;

function readTabDragData(event: React.DragEvent): TabDragData | null {
  const dragTypes = Array.from(event.dataTransfer.types || []);
  const raw = event.dataTransfer.getData(TAB_DRAG_MIME_TYPE);
  if (raw) {
    try {
      return JSON.parse(raw) as TabDragData;
    } catch (err) {
      console.error('Failed to parse tab drag data:', err);
      return null;
    }
  }

  if (dragTypes.includes(TAB_DRAG_MIME_TYPE)) return null;
  if (!activeTabDragData) return null;

  return activeTabDragData;
}

function composePendingDiffContent(
  lines: DiffEventDTO['lines'],
  fallbackDecision: 'accepted' | 'rejected'
): string {
  return [...lines]
    .sort((left, right) => left.line_no - right.line_no)
    .map((line) => {
      if (line.decision === 'rejected') return line.old_line;
      if (line.decision === 'accepted') return line.new_line;
      return fallbackDecision === 'rejected' ? line.old_line : line.new_line;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

export function PaneRenderer({ pane, isActive, onActivate, onDragOver, onDragLeave, onDrop }: PaneRendererProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [draggedTabInfo, setDraggedTabInfo] = useState<{ sourcePaneId: string; tabId: string } | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [showNewTabMenu, setShowNewTabMenu] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pendingDiffEvent, setPendingDiffEvent] = useState<DiffEventDTO | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [pendingDiffLoading, setPendingDiffLoading] = useState(false);
  const [pdfFileUrl, setPdfFileUrl] = useState<string | null>(null);
  const previousContentRef = useRef<string>('');
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<{ fileId: string; fileName: string; content: string } | null>(null);
  const pendingDiffRequestRef = useRef(0);

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
  const { getFileContent, updateFileContent, files, loadFiles } = useFileStore();
  const { createFile: createTreeFile } = useFileTreeStore();
  const { permissions: allPermissions, togglePermission, setPermission } = useSessionStore();
  const { setActiveTab, closeTab, reorderTabs, moveTabToPane, openTab, getAllOpenTabs, closePane, createPane, setTabMode } = usePaneStore();
  const { sessionId, setSessionId, sendMessageForSession, addSessionReference } = useChatStore();
  const { addVersion } = useVersionStore();
  const { activeDiff, clearDiff } = useDiffStore();

  // Get session permissions for all files
  // Using allPermissions directly ensures reactivity when store updates
  const sessionPerms = activeTab?.type === 'session'
    ? allPermissions[activeTab.id] || {}
    : {};

  const loadPendingDiffForFile = useCallback(async (fileId: string) => {
    const requestId = pendingDiffRequestRef.current + 1;
    pendingDiffRequestRef.current = requestId;
    setPendingDiffLoading(true);
    try {
      const response = await api.getPendingDiffEvent(fileId);
      if (pendingDiffRequestRef.current !== requestId) return;
      if (response.success && response.data?.event) {
        setPendingDiffEvent(response.data.event);
        setSelectedLineId((currentSelectedLineId) =>
          currentSelectedLineId && response.data?.event?.lines.some((line) => line.id === currentSelectedLineId)
            ? currentSelectedLineId
            : null
        );
      } else {
        setPendingDiffEvent(null);
        setSelectedLineId(null);
      }
    } catch (err) {
      if (pendingDiffRequestRef.current !== requestId) return;
      console.error('Failed to load pending diff event:', err);
      setPendingDiffEvent(null);
      setSelectedLineId(null);
    } finally {
      if (pendingDiffRequestRef.current === requestId) {
        setPendingDiffLoading(false);
      }
    }
  }, []);

  // Handle viewport changes for AI context
  const handleViewportChange = useCallback(async (
    scrollTop: number,
    scrollHeight: number,
    page?: number,
    options?: {
      visibleUnit?: 'page' | 'line' | 'paragraph' | 'pixel';
      visibleStart?: number;
      visibleEnd?: number;
      anchorBlockId?: string;
    }
  ) => {
    if (activeTab && activeTab.type !== 'session') {
      try {
        await api.updateViewport(
          sessionId,
          activeTab.id,
          page || currentPage,
          scrollTop,
          scrollHeight,
          {
            visibleUnit: options?.visibleUnit,
            visibleStart: options?.visibleStart,
            visibleEnd: options?.visibleEnd,
            anchorBlockId: options?.anchorBlockId,
            pendingDiffEventId: pendingDiffEvent?.id,
          }
        );
      } catch (err) {
        console.error('Failed to update viewport:', err);
      }
    }
  }, [activeTab, sessionId, currentPage, pendingDiffEvent?.id]);

  useEffect(() => {
    if (isActive && activeTab?.type === 'session') {
      setSessionId(activeTab.id);
    }
  }, [isActive, activeTab?.id, activeTab?.type, setSessionId]);

  // Load file content when tab changes
  useEffect(() => {
    if (activeTab && activeTab.type === 'md') {
      getFileContent(activeTab.id).then((content) => {
        const contentStr = content || '';
        setFileContent(contentStr);
        previousContentRef.current = contentStr;
      });
      loadPendingDiffForFile(activeTab.id);
    } else {
      pendingDiffRequestRef.current += 1;
      setPendingDiffEvent(null);
      setSelectedLineId(null);
    }
  }, [activeTab, getFileContent, loadPendingDiffForFile]);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      if (pendingSaveRef.current) {
        const pending = pendingSaveRef.current;
        pendingSaveRef.current = null;
        if (pending.content !== previousContentRef.current) {
          void updateFileContent(pending.fileId, pending.content).then((saved) => {
            if (saved) previousContentRef.current = pending.content;
          });
        }
      }
    };
  }, [activeTab?.id, updateFileContent]);

  const scheduleMarkdownSave = useCallback(
    (fileId: string, fileName: string, nextContent: string) => {
      setFileContent(nextContent);

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      if (nextContent === previousContentRef.current) {
        pendingSaveRef.current = null;
        return;
      }

      pendingSaveRef.current = { fileId, fileName, content: nextContent };

      saveTimeoutRef.current = setTimeout(async () => {
        const pending = pendingSaveRef.current;
        if (!pending || pending.fileId !== fileId || pending.content !== nextContent) {
          saveTimeoutRef.current = null;
          return;
        }

        pendingSaveRef.current = null;
        saveTimeoutRef.current = null;

        const oldContent = previousContentRef.current;
        const saved = await updateFileContent(fileId, nextContent);
        if (!saved) return;

        if (oldContent.trim() !== nextContent.trim() && Math.abs(oldContent.length - nextContent.length) > 10) {
          addVersion(
            fileId,
            'human',
            'edit',
            `Edited ${fileName}`,
            oldContent,
            nextContent
          );
        }
        previousContentRef.current = nextContent;
      }, 320);
    },
    [addVersion, updateFileContent]
  );

  useEffect(() => {
    if (!activeTab || activeTab.type !== 'pdf') {
      setPdfFileUrl(null);
      return;
    }

    const existing = files.find((file) => file.id === activeTab.id);
    if (existing?.url) {
      setPdfFileUrl(existing.url);
      return;
    }

    let disposed = false;
    setPdfFileUrl(null);

    const resolvePdfUrl = async () => {
      try {
        await loadFiles();
        const refreshed = useFileStore.getState().files.find((file) => file.id === activeTab.id);
        if (refreshed?.url) {
          if (!disposed) setPdfFileUrl(refreshed.url);
          return;
        }

        const response = await api.getFile(activeTab.id);
        if (response.success && response.data?.url && !disposed) {
          setPdfFileUrl(response.data.url);
        }
      } catch (err) {
        if (!disposed) {
          console.error('Failed to resolve PDF source:', err);
        }
      }
    };

    void resolvePdfUrl();

    return () => {
      disposed = true;
    };
  }, [activeTab, files, loadFiles]);

  useEffect(() => {
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent;
      const detail = customEvent.detail || {};
      const changedFileId = detail.file_id || detail.fileId;
      if (activeTab?.type === 'md' && changedFileId === activeTab.id) {
        loadPendingDiffForFile(activeTab.id);
      }
    };

    window.addEventListener('diff-event-created', handler);
    return () => window.removeEventListener('diff-event-created', handler);
  }, [activeTab?.id, activeTab?.type, loadPendingDiffForFile]);

  useEffect(() => {
    const handler = () => {
      if (activeTab?.type === 'md') {
        loadPendingDiffForFile(activeTab.id);
      }
    };
    window.addEventListener('assistant-message-finished', handler);
    return () => window.removeEventListener('assistant-message-finished', handler);
  }, [activeTab?.id, activeTab?.type, loadPendingDiffForFile]);

  const handleCreateNewMarkdown = async () => {
    setIsCreating(true);
    setShowNewTabMenu(false);

    const filename = `Untitled-${Date.now().toString().slice(-6)}.md`;

    // Create file on backend first
    try {
      const response = await api.createFile(filename, '');
      if (response.success && response.data) {
        const file_id = response.data.file_id || `new-${Date.now()}`;
        const newTab = {
          id: file_id,
          name: filename,
          type: 'md' as const,
          mode: 'editor' as ViewMode,
        };

        openTab(pane.id, newTab);
        setActiveTab(pane.id, file_id);

        // Clear the file content cache to fetch fresh content
        setFileContent('');
      }
    } catch (err) {
      console.error('Failed to create file:', err);
      // Fallback: create local tab only
      const newId = `new-${Date.now()}`;
      const newTab = {
        id: newId,
        name: 'Untitled.md',
        type: 'md' as const,
        mode: 'editor' as ViewMode,
      };

      openTab(pane.id, newTab);
      setActiveTab(pane.id, newId);
      setFileContent('');
    }

    setIsCreating(false);
  };

  const handleStartChat = async () => {
    setShowNewTabMenu(false);

    const sessionLabel = `New Session ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const newId = (await createTreeFile(sessionLabel, 'session')) || `chat-${Date.now()}`;
    const newTab = {
      id: newId,
      name: sessionLabel,
      type: 'session' as const,
      mode: 'editor' as ViewMode,
    };

    openTab(pane.id, newTab);
    setActiveTab(pane.id, newId);
    setSessionId(newId);

    // Initialize default permissions for all currently open files
    const openTabs = getAllOpenTabs();
    for (const tab of openTabs) {
      if (tab.type !== 'session') {
        setPermission(newId, tab.id, 'read' as Permission);
      }
    }
  };

  const handleTabDragStart = useCallback((e: React.DragEvent, tabId: string, index: number) => {
    const dragData: TabDragData = {
      sourcePaneId: pane.id,
      tabId,
      fromIndex: index,
    };
    e.dataTransfer.setData(TAB_DRAG_MIME_TYPE, JSON.stringify(dragData));
    e.dataTransfer.setData('text/plain', tabId);
    e.dataTransfer.effectAllowed = 'move';
    activeTabDragData = dragData;
    setDraggedTabInfo({ sourcePaneId: pane.id, tabId });
  }, [pane.id]);

  const handleTabDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    const dragTypes = Array.from(e.dataTransfer.types || []);
    if (dragTypes.includes(TAB_DRAG_MIME_TYPE) || activeTabDragData) {
      setDropTargetIndex(index);
    }
  }, []);

  const handleTabDragLeave = useCallback(() => {
    setDropTargetIndex(null);
  }, []);

  const handleTabDrop = useCallback((e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    e.stopPropagation();

    const dragData = readTabDragData(e);
    if (!dragData) {
      setDropTargetIndex(null);
      return;
    }

    if (dragData.sourcePaneId === pane.id) {
      if (dragData.fromIndex !== targetIndex) {
        reorderTabs(pane.id, dragData.fromIndex, targetIndex);
      }
    } else {
      moveTabToPane(dragData.sourcePaneId, pane.id, dragData.tabId, targetIndex);
    }

    activeTabDragData = null;
    setDropTargetIndex(null);
  }, [pane.id, reorderTabs, moveTabToPane]);

  const handleTabDragEnd = useCallback(() => {
    activeTabDragData = null;
    setDraggedTabInfo(null);
    setDropTargetIndex(null);
  }, []);

  const handlePaneDrop = useCallback((e: React.DragEvent) => {
    const dragData = readTabDragData(e);
    if (!dragData) {
      // Not a tab drag, let the parent handle it (file drag)
      setIsDragOver(false);
      onDrop(e);
      return;
    }

    // This is a tab drop on the pane area (not on a specific tab)
    // Move the tab to the end of this pane
    e.preventDefault();
    e.stopPropagation();

    if (dragData.sourcePaneId !== pane.id) {
      moveTabToPane(dragData.sourcePaneId, pane.id, dragData.tabId);
    }

    activeTabDragData = null;
    setIsDragOver(false);
  }, [pane.id, moveTabToPane, onDrop]);

  const applyLineDecision = useCallback(async (decision: 'accepted' | 'rejected', lineId?: string | string[]) => {
    if (!activeTab || activeTab.type !== 'md' || !pendingDiffEvent) return;

    const requestedLineIds = Array.isArray(lineId)
      ? lineId
      : lineId
        ? [lineId]
        : selectedLineId
          ? [selectedLineId]
          : [];

    const targetLines = requestedLineIds.length > 0
      ? pendingDiffEvent.lines.filter((line) => requestedLineIds.includes(line.id))
      : [];

    if (targetLines.length === 0) {
      const fallbackLine = pendingDiffEvent.lines.find((line) => line.decision === 'pending');
      if (!fallbackLine) return;
      targetLines.push(fallbackLine);
    }

    await Promise.all(
      targetLines.map((line) =>
        api.updateDiffLineDecision(activeTab.id, pendingDiffEvent.id, line.id, decision)
      )
    );
    await loadPendingDiffForFile(activeTab.id);
  }, [activeTab, loadPendingDiffForFile, pendingDiffEvent, selectedLineId]);

  const finalizePendingDiff = useCallback(async (acceptAll: boolean) => {
    if (!activeTab || activeTab.type !== 'md' || !pendingDiffEvent) return;

    if (!acceptAll) {
      const remainingPending = pendingDiffEvent.lines.filter((line) => line.decision === 'pending');
      await Promise.all(
        remainingPending.map((line) =>
          api.updateDiffLineDecision(activeTab.id, pendingDiffEvent.id, line.id, 'rejected')
        )
      );
    }

    const response = await api.finalizeDiffEvent(activeTab.id, pendingDiffEvent.id, {
      summary: acceptAll ? 'Accept all pending diff lines' : 'Reject all pending diff lines',
      author: 'human',
    });

    if (response.success) {
      pendingDiffRequestRef.current += 1;
      const finalContent =
        response.data?.final_content ||
        composePendingDiffContent(pendingDiffEvent.lines, acceptAll ? 'accepted' : 'rejected');
      setFileContent(finalContent);
      previousContentRef.current = finalContent;
      setPendingDiffEvent(null);
      setSelectedLineId(null);
      useFileStore.getState().setFileContent(activeTab.id, finalContent);
      useFileStore.getState().loadFiles();
      useFileStore.getState().getFileVersions(activeTab.id);
    }
  }, [activeTab, pendingDiffEvent]);

  const diffLines = useMemo(
    () => pendingDiffEvent?.lines || [],
    [pendingDiffEvent]
  );

  const pendingLines = useMemo(
    () => pendingDiffEvent?.lines.filter((line) => line.decision === 'pending') || [],
    [pendingDiffEvent]
  );

  const acceptedLineCount = useMemo(
    () => diffLines.filter((line) => line.decision === 'accepted' && line.old_line !== line.new_line).length,
    [diffLines]
  );

  const rejectedLineCount = useMemo(
    () => diffLines.filter((line) => line.decision === 'rejected').length,
    [diffLines]
  );

  const openSessions = getAllOpenTabs()
    .filter((tab) => tab.type === 'session')
    .map((tab) => ({ id: tab.id, name: tab.name }));

  return (
    <div
      className={`flex-1 min-h-0 min-w-[320px] max-w-full flex flex-col border-r border-theme-border/30 paper-divider-dashed bg-theme-bg transition-all relative ${
        isActive ? 'ring-1 ring-inset ring-theme-border/50 z-10' : 'opacity-95'
      }`}
      onClick={onActivate}
      onDragOver={(e) => {
        e.preventDefault();
        const tabDragData = e.dataTransfer.getData(TAB_DRAG_MIME_TYPE);
        if (tabDragData) {
          setIsDragOver(true);
        }
        onDragOver();
      }}
      onDragLeave={() => {
        setIsDragOver(false);
        onDragLeave();
      }}
      onDrop={handlePaneDrop}
    >
      {isDragOver && !draggedTabInfo && (
        <div className="absolute inset-0 bg-theme-text/6 border-2 border-theme-border/40 border-dashed paper-divider-dashed z-50 flex items-center justify-center pointer-events-none backdrop-blur-[1px]">
          <div className="bg-theme-text text-theme-bg px-4 py-2 rounded-lg shadow-lg font-medium flex items-center gap-2 border border-theme-border/40">
            <Download size={18} /> Drop to Open
          </div>
        </div>
      )}
      <div
        className="flex items-center h-9 border-b border-theme-border/30 paper-divider-dashed select-none surface-panel"
      >
        <div className="flex-1 flex overflow-x-auto">
          {pane.tabs.map((tab, index) => {
            const isBeingDragged = draggedTabInfo?.tabId === tab.id;
            const isDropTarget = dropTargetIndex === index;

            return (
              <div
                key={tab.id}
                draggable
                data-tab-id={tab.id}
                data-tab-name={tab.name}
                onDragStart={(e) => handleTabDragStart(e, tab.id, index)}
                onDragEnter={(e) => handleTabDragOver(e, index)}
                onDragOver={(e) => handleTabDragOver(e, index)}
                onDragLeave={handleTabDragLeave}
                onDrop={(e) => handleTabDrop(e, index)}
                onDragEnd={handleTabDragEnd}
                onClick={(e) => {
                  e.stopPropagation();
                  onActivate();
                  setActiveTab(pane.id, tab.id);
                }}
                className={`group relative flex items-center gap-2 px-2 min-w-[100px] max-w-[160px] text-xs cursor-pointer border-r border-theme-border/25 paper-divider-dashed h-full transition-colors ${
                  pane.activeTabId === tab.id
                    ? 'bg-theme-bg text-theme-text border-t-2 border-t-theme-border/80 font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.5)]'
                    : 'bg-theme-bg/35 text-theme-text/60 hover:bg-theme-text/8'
                } ${isDropTarget ? 'ring-1 ring-inset ring-theme-border/50' : ''} ${
                  isBeingDragged ? 'opacity-40' : ''
                }`}
              >
                {isDropTarget && <div className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full bg-theme-accent" />}
                <GripVertical size={12} className="paper-grip cursor-grab active:cursor-grabbing flex-shrink-0" />
                <FileIcon type={tab.type} />
                <span className="truncate flex-1">{tab.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(pane.id, tab.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 hover:bg-theme-text/12 rounded p-0.5 transition-opacity flex-shrink-0"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>

        {/* Split Pane Button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            createPane();
          }}
          className="w-8 h-8 flex items-center justify-center hover:bg-theme-text/10 text-theme-text/60 transition-colors"
          title="Split Pane"
        >
          <Split size={14} />
        </button>

        {/* New Tab Button */}
        <div className="relative">
          <button
            onClick={() => setShowNewTabMenu(!showNewTabMenu)}
            className="w-8 h-8 flex items-center justify-center hover:bg-theme-text/10 text-theme-text/60 transition-colors"
            title="New Tab"
          >
            <Plus size={14} />
          </button>

          {/* Dropdown Menu */}
          {showNewTabMenu && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowNewTabMenu(false)}
              />
              <div
                className="absolute right-0 top-full mt-1 z-50 border border-theme-border/30 paper-divider rounded-lg shadow-lg py-1 min-w-[140px] surface-panel"
              >
                <button
                  onClick={handleCreateNewMarkdown}
                  disabled={isCreating}
                  className="w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-theme-text/10 text-theme-text/80 transition-colors"
                >
                  <FileText size={14} />
                  {isCreating ? 'Creating...' : 'New Markdown'}
                </button>
                <button
                  onClick={handleStartChat}
                  className="w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-theme-text/10 text-theme-text/80 transition-colors"
                >
                  <MessageSquare size={14} />
                  New Chat
                </button>
              </div>
            </>
          )}
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            closePane(pane.id);
          }}
          className="w-8 flex items-center justify-center hover:bg-red-50 hover:text-red-600 text-theme-text/40 h-full border-l border-theme-border/25 paper-divider-dashed"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden relative bg-theme-bg">
        {!activeTab ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-theme-text/40 pointer-events-none select-none">
            <div className="bg-theme-bg/50 p-4 rounded-full mb-3 border border-theme-border/10">
              <Split size={24} className="text-theme-text/30" />
            </div>
            <p className="text-sm font-medium">Empty Pane</p>
          </div>
        ) : activeTab.type === 'session' ? (
          <SessionView
            sessionId={activeTab.id}
            allFiles={getAllOpenTabs()}
            permissions={sessionPerms}
            onTogglePermission={(fileId, fileType) => togglePermission(activeTab.id, fileId, fileType)}
          />
        ) : activeTab.mode === 'diff' ? (
          <div data-testid="history-diff-view" className="flex flex-col h-full bg-theme-bg">
            <div
              className="px-3 py-2 border-b border-theme-border/30 paper-divider-dashed text-theme-text flex justify-between items-center text-xs"
              style={{ backgroundColor: 'var(--theme-surface)' }}
            >
              <span className="flex items-center gap-2">
                <GitCommit size={14} />{' '}
                <strong>{activeDiff?.versionLabel || 'Diff View'}</strong>
              </span>

              <div className="flex items-center gap-2">
                <button
                  data-testid="history-diff-exit"
                  onClick={() => {
                    clearDiff();
                    setTabMode(pane.id, activeTab.id, 'editor');
                  }}
                  className="text-xs bg-theme-bg border border-theme-border/25 paper-divider px-2 py-0.5 rounded hover:bg-theme-text/10 ml-2"
                >
                  Exit Diff
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden relative">
              {activeDiff ? (
                <>
                  <RenderedDiffViewer
                    oldContent={activeDiff.oldContent}
                    newContent={activeDiff.newContent}
                    mode="split"
                  />
                  {/* Floating Action Buttons */}
                  <div className="absolute bottom-6 right-6 flex gap-2 shadow-lg rounded-lg overflow-hidden z-10">
                    <button
                      data-testid="history-diff-accept-all"
                      onClick={() => {
                        updateFileContent(activeTab.id, activeDiff.newContent);
                        clearDiff();
                        setTabMode(pane.id, activeTab.id, 'editor');
                      }}
                      className="px-4 py-2 bg-green-600 text-white hover:bg-green-700 font-medium text-sm flex items-center gap-2"
                    >
                      Accept All
                    </button>
                    <button
                      data-testid="history-diff-reject-all"
                      onClick={() => {
                        updateFileContent(activeTab.id, activeDiff.oldContent);
                        clearDiff();
                        setTabMode(pane.id, activeTab.id, 'editor');
                      }}
                      className="px-4 py-2 bg-red-600 text-white hover:bg-red-700 font-medium text-sm flex items-center gap-2"
                    >
                      Reject All
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center h-full text-theme-text/40">
                  No diff data available
                </div>
              )}
            </div>
          </div>
        ) : activeTab.type === 'pdf' ? (
          <div
            className="w-full h-full min-h-0 flex flex-col"
            style={{ backgroundColor: 'var(--theme-surface-muted)' }}
          >
            {!pdfFileUrl ? (
              <div className="flex flex-col items-center justify-center h-full text-theme-text/45">
                <Loader2 size={18} className="animate-spin" />
                <p className="text-xs mt-2">Loading PDF source...</p>
              </div>
            ) : (
              <PDFViewer
                fileId={activeTab.id}
                filePath={pdfFileUrl.startsWith('http') ? pdfFileUrl : `${BASE_URL}${pdfFileUrl}`}
                onPageChange={(page) => {
                  setCurrentPage(page);
                  handleViewportChange(0, 1000, page);
                }}
                onScrollChange={handleViewportChange}
              />
            )}
          </div>
        ) : activeTab.type === 'md' ? (
          pendingDiffEvent ? (
            <div data-testid="pending-diff-view" className="flex flex-col h-full bg-theme-bg">
              <div className="surface-panel bg-amber-50/70 px-3 py-2 border-b border-theme-border/20 text-theme-text text-xs">
                <div className="flex justify-between items-center gap-3 flex-wrap">
                  <span className="flex items-center gap-2">
                    <GitCommit size={14} />
                    <strong>{pendingDiffEvent.summary || 'Pending Agent Diff'}</strong>
                    <span className="text-theme-text/55">
                      {pendingLines.length} pending line{pendingLines.length === 1 ? '' : 's'}
                    </span>
                    <span className="text-theme-text/45">
                      {acceptedLineCount} accepted · {rejectedLineCount} rejected
                    </span>
                    {pendingDiffLoading && <span className="text-theme-text/50">Refreshing...</span>}
                  </span>
                </div>

                <div className="flex items-center gap-2 mt-2">
                  <button
                    data-testid="pending-diff-accept-all"
                    onClick={() => finalizePendingDiff(true)}
                    className="px-3 py-1 bg-green-700 text-white rounded hover:bg-green-800"
                  >
                    Accept All
                  </button>
                  <button
                    data-testid="pending-diff-reject-all"
                    onClick={() => finalizePendingDiff(false)}
                    className="px-3 py-1 bg-red-700 text-white rounded hover:bg-red-800"
                  >
                    Reject All
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-hidden relative">
                <RenderedDiffViewer
                  oldContent={pendingDiffEvent.old_content}
                  newContent={pendingDiffEvent.new_content}
                  mode="inline"
                  pendingLines={diffLines}
                  selectedLineId={selectedLineId}
                  onSelectLine={setSelectedLineId}
                  onApplyLineDecision={(lineId, decision) => {
                    void applyLineDecision(decision, lineId);
                  }}
                />
              </div>
            </div>
          ) : (
            <TiptapMarkdownEditor
              key={activeTab.id}
              content={fileContent}
              onChange={(val) => {
                if (!activeTab || activeTab.type !== 'md') return;
                scheduleMarkdownSave(activeTab.id, activeTab.name, val);
              }}
              availableSessions={openSessions}
              defaultSessionId={sessionId || openSessions[0]?.id}
              sourceFile={
                activeTab && activeTab.type === 'md'
                  ? {
                      id: activeTab.id,
                      name: activeTab.name,
                    }
                  : undefined
              }
              onAddReferenceToSession={(targetSessionId, reference) => {
                addSessionReference(targetSessionId, reference);
              }}
              onRunSelectionAction={async ({ action, targetSessionId, markdown }) => {
                if (!activeTab || activeTab.type !== 'md') return;
                const prompt =
                  action === 'fix'
                    ? `请修正以下选中内容，并给出修正后的 Markdown：\n\n${markdown}`
                    : `请检查以下选中内容的问题（语法、表达、事实）并给出建议：\n\n${markdown}`;

                await sendMessageForSession(
                  targetSessionId,
                  prompt,
                  [activeTab.id],
                  { activeFileId: activeTab.id, compactMode: 'force' }
                );
              }}
              onViewportChange={({ scrollTop, scrollHeight, visibleUnit, visibleStart, visibleEnd }) => {
                void handleViewportChange(scrollTop, scrollHeight, currentPage, {
                  visibleUnit,
                  visibleStart,
                  visibleEnd,
                });
              }}
            />
          )
        ) : (
          <div className="p-8">
            <h1 className="text-2xl font-bold mb-4">{activeTab.name}</h1>
            <p className="text-theme-text/60">Generic Viewer</p>
          </div>
        )}
      </div>
    </div>
  );
}
