import { useState, useCallback, useEffect, useRef } from 'react';
import { X, Split, Download, GitCommit, GripVertical, Plus, MessageSquare, FileText } from 'lucide-react';
import { Pane } from '../../types';
import { TiptapMarkdownEditor } from '../editor/TiptapMarkdownEditor';
import { SessionView } from '../session/SessionView';
import { PDFViewer } from '../pdf/PDFViewer';
import { RenderedDiffViewer } from '../editor/RenderedDiffViewer';
import { usePaneStore } from '../../stores/paneStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useFileStore } from '../../stores/apiStore';
import { useChatStore } from '../../stores/chatStore';
import { useVersionStore } from '../../stores/versionStore';
import { useDiffStore } from '../../stores/diffStore';
import { FileIcon } from '../ui/FileIcon';
import { api, BASE_URL } from '../../api/client';
import { ViewMode, Permission } from '../../types';

interface PaneRendererProps {
  pane: Pane;
  isActive: boolean;
  onActivate: () => void;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: () => void;
}

interface TabDragData {
  sourcePaneId: string;
  tabId: string;
  fromIndex: number;
}

const TAB_DRAG_MIME_TYPE = 'application/x-tab-drag';

export function PaneRenderer({ pane, isActive, onActivate, onDragOver, onDragLeave, onDrop }: PaneRendererProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [draggedTabInfo, setDraggedTabInfo] = useState<{ sourcePaneId: string; tabId: string } | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [showNewTabMenu, setShowNewTabMenu] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [diffMode, setDiffMode] = useState<'split' | 'inline'>('split');
  const [currentPage, setCurrentPage] = useState(1);
  const previousContentRef = useRef<string>('');

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
  const { getFileContent, updateFileContent, files } = useFileStore();
  const { permissions: allPermissions, togglePermission, setPermission } = useSessionStore();
  const { setActiveTab, closeTab, reorderTabs, moveTabToPane, openTab, getAllOpenTabs, closePane, createPane, setTabMode } = usePaneStore();
  const { sessionId } = useChatStore();
  const { addVersion } = useVersionStore();
  const { activeDiff, clearDiff } = useDiffStore();

  // Get session permissions for all files
  // Using allPermissions directly ensures reactivity when store updates
  const sessionPerms = activeTab?.type === 'session'
    ? allPermissions[activeTab.id] || {}
    : {};

  // Handle viewport changes for AI context
  const handleViewportChange = useCallback(async (scrollTop: number, scrollHeight: number, page?: number) => {
    if (activeTab && activeTab.type !== 'session') {
      try {
        await api.updateViewport(
          sessionId,
          activeTab.id,
          page || currentPage,
          scrollTop,
          scrollHeight
        );
      } catch (err) {
        console.error('Failed to update viewport:', err);
      }
    }
  }, [activeTab, sessionId, currentPage]);

  // Load file content when tab changes
  useEffect(() => {
    if (activeTab && activeTab.type === 'md') {
      getFileContent(activeTab.id).then((content) => {
        const contentStr = content || '';
        setFileContent(contentStr);
        previousContentRef.current = contentStr;
      });
    }
  }, [activeTab?.id]);

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

    const newId = `chat-${Date.now()}`;
    const newTab = {
      id: newId,
      name: 'New Chat',
      type: 'session' as const,
      mode: 'editor' as ViewMode,
    };

    openTab(pane.id, newTab);
    setActiveTab(pane.id, newId);

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
    e.dataTransfer.effectAllowed = 'move';
    setDraggedTabInfo({ sourcePaneId: pane.id, tabId });
  }, [pane.id]);

  const handleTabDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Check if this is a tab drag operation
    const tabDragData = e.dataTransfer.getData(TAB_DRAG_MIME_TYPE);
    if (tabDragData) {
      setDropTargetIndex(index);
    }
  }, []);

  const handleTabDragLeave = useCallback(() => {
    setDropTargetIndex(null);
  }, []);

  const handleTabDrop = useCallback((e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    e.stopPropagation();

    const tabDragDataStr = e.dataTransfer.getData(TAB_DRAG_MIME_TYPE);
    if (!tabDragDataStr) return;

    try {
      const dragData: TabDragData = JSON.parse(tabDragDataStr);

      if (dragData.sourcePaneId === pane.id) {
        // Same pane: reorder
        if (dragData.fromIndex !== targetIndex) {
          reorderTabs(pane.id, dragData.fromIndex, targetIndex);
        }
      } else {
        // Different pane: move tab to this pane
        moveTabToPane(dragData.sourcePaneId, pane.id, dragData.tabId, targetIndex);
      }
    } catch (err) {
      console.error('Failed to parse tab drag data:', err);
    }

    setDropTargetIndex(null);
  }, [pane.id, reorderTabs, moveTabToPane]);

  const handleTabDragEnd = useCallback(() => {
    setDraggedTabInfo(null);
    setDropTargetIndex(null);
  }, []);

  const handlePaneDrop = useCallback((e: React.DragEvent) => {
    const tabDragDataStr = e.dataTransfer.getData(TAB_DRAG_MIME_TYPE);
    if (!tabDragDataStr) {
      // Not a tab drag, let the parent handle it (file drag)
      setIsDragOver(false);
      onDrop();
      return;
    }

    // This is a tab drop on the pane area (not on a specific tab)
    // Move the tab to the end of this pane
    e.preventDefault();
    e.stopPropagation();

    try {
      const dragData: TabDragData = JSON.parse(tabDragDataStr);
      if (dragData.sourcePaneId !== pane.id) {
        moveTabToPane(dragData.sourcePaneId, pane.id, dragData.tabId);
      }
    } catch (err) {
      console.error('Failed to parse tab drag data:', err);
    }

    setIsDragOver(false);
  }, [pane.id, moveTabToPane, onDrop]);

  return (
    <div
      className={`flex-1 min-w-[320px] max-w-full flex flex-col border-r border-theme-border/20 bg-theme-bg transition-all relative ${
        isActive ? 'ring-1 ring-inset ring-theme-border z-10' : 'opacity-95'
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
        <div className="absolute inset-0 bg-blue-50/50 border-2 border-blue-400 border-dashed z-50 flex items-center justify-center pointer-events-none backdrop-blur-[1px]">
          <div className="bg-blue-500 text-white px-4 py-2 rounded-lg shadow-lg font-medium flex items-center gap-2">
            <Download size={18} /> Drop to Open
          </div>
        </div>
      )}
      <div className="flex items-center h-9 bg-theme-bg/50 border-b border-theme-border/20 select-none">
        <div className="flex-1 flex overflow-x-auto no-scrollbar">
          {pane.tabs.map((tab, index) => {
            const isBeingDragged = draggedTabInfo?.tabId === tab.id;
            const isDropTarget = dropTargetIndex === index;

            return (
              <div
                key={tab.id}
                draggable
                onDragStart={(e) => handleTabDragStart(e, tab.id, index)}
                onDragOver={(e) => handleTabDragOver(e, index)}
                onDragLeave={handleTabDragLeave}
                onDrop={(e) => handleTabDrop(e, index)}
                onDragEnd={handleTabDragEnd}
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveTab(pane.id, tab.id);
                }}
                className={`group relative flex items-center gap-2 px-2 min-w-[100px] max-w-[160px] text-xs cursor-pointer border-r border-theme-border/20 h-full transition-colors ${
                  pane.activeTabId === tab.id
                    ? 'bg-theme-bg text-theme-text border-t-2 border-t-theme-border font-medium'
                    : 'bg-theme-bg/30 text-theme-text/60 hover:bg-theme-text/10'
                } ${isDropTarget ? 'border-l-2 border-l-theme-border' : ''} ${
                  isBeingDragged ? 'opacity-40' : ''
                }`}
              >
                <GripVertical size={12} className="text-theme-text/30 cursor-grab active:cursor-grabbing flex-shrink-0" />
                <FileIcon type={tab.type} />
                <span className="truncate flex-1">{tab.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(pane.id, tab.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 hover:bg-theme-text/20 rounded p-0.5 transition-opacity flex-shrink-0"
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
              <div className="absolute right-0 top-full mt-1 z-50 bg-theme-bg border border-theme-border/20 rounded-lg shadow-lg py-1 min-w-[140px]">
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
          className="w-8 flex items-center justify-center hover:bg-red-50 hover:text-red-600 text-theme-text/40 h-full border-l border-theme-border/20"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-hidden relative bg-theme-bg">
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
            onTogglePermission={(fileId) => togglePermission(activeTab.id, fileId)}
          />
        ) : activeTab.mode === 'diff' ? (
          <div className="flex flex-col h-full bg-theme-bg">
            <div className="bg-blue-50/20 px-3 py-2 border-b border-theme-border/20 text-theme-text flex justify-between items-center text-xs">
              <span className="flex items-center gap-2">
                <GitCommit size={14} />{' '}
                <strong>{activeDiff?.versionLabel || 'Diff View'}</strong>
              </span>

              <div className="flex items-center gap-2">
                <div className="flex bg-theme-bg/50 rounded p-0.5 border border-theme-border/10">
                  <button
                    onClick={() => setDiffMode('split')}
                    className={`px-2 py-0.5 rounded transition-colors ${diffMode === 'split' ? 'bg-theme-bg shadow-sm text-theme-text' : 'text-theme-text/60 hover:bg-theme-text/10'}`}
                  >
                    Split
                  </button>
                  <button
                    onClick={() => setDiffMode('inline')}
                    className={`px-2 py-0.5 rounded transition-colors ${diffMode === 'inline' ? 'bg-theme-bg shadow-sm text-theme-text' : 'text-theme-text/60 hover:bg-theme-text/10'}`}
                  >
                    Inline
                  </button>
                </div>

                <button
                  onClick={() => {
                    clearDiff();
                    setTabMode(pane.id, activeTab.id, 'editor');
                  }}
                  className="text-xs bg-theme-bg border border-theme-border/20 px-2 py-0.5 rounded hover:bg-theme-text/10 ml-2"
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
                    mode={diffMode}
                  />
                  {/* Floating Action Buttons */}
                  <div className="absolute bottom-6 right-6 flex gap-2 shadow-lg rounded-lg overflow-hidden z-10">
                    <button
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
          <div className="w-full h-full bg-theme-bg/20 flex flex-col">
            {(() => {
              const file = files.find((f) => f.id === activeTab.id);
              if (!file || !file.url) {
                return (
                  <div className="flex flex-col items-center justify-center h-full text-theme-text/40">
                    <p>PDF source not available</p>
                    <p className="text-xs mt-2">Try refreshing the file list</p>
                  </div>
                );
              }
              const fullUrl = file.url.startsWith('http') ? file.url : `${BASE_URL}${file.url}`;
              return (
                <PDFViewer
                  fileId={activeTab.id}
                  filePath={fullUrl}
                  onPageChange={(page) => {
                    setCurrentPage(page);
                    handleViewportChange(0, 1000, page);
                  }}
                  onScrollChange={handleViewportChange}
                />
              );
            })()}
          </div>
        ) : activeTab.type === 'md' ? (
          <TiptapMarkdownEditor
            content={fileContent}
            onChange={async (val) => {
              if (activeTab) {
                const oldContent = previousContentRef.current;
                await updateFileContent(activeTab.id, val);
                setFileContent(val);

                // Record version if content changed significantly (more than just whitespace)
                if (oldContent.trim() !== val.trim() && Math.abs(oldContent.length - val.length) > 10) {
                  addVersion(
                    activeTab.id,
                    'human',
                    'edit',
                    `Edited ${activeTab.name}`,
                    oldContent,
                    val
                  );
                  previousContentRef.current = val;
                }
              }
            }}
          />
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
