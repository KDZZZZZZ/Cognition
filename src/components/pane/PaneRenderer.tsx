import { useState, useCallback, useEffect, useRef } from 'react';
import { X, Split, Download, GitCommit, GripVertical, Plus, MessageSquare, FileText } from 'lucide-react';
import { Pane } from '../../types';
import { TiptapMarkdownEditor } from '../editor/TiptapMarkdownEditor';
import { SessionView } from '../session/SessionView';
import { PDFViewer } from '../pdf/PDFViewer';
import { MonacoSideBySideDiff } from '../editor/MonacoDiffEditor';
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
  const [currentPage, setCurrentPage] = useState(1);
  const previousContentRef = useRef<string>('');

  const activeTab = pane.tabs.find((t) => t.id === pane.activeTabId);
  const { getFileContent, updateFileContent, files } = useFileStore();
  const { getPermission, togglePermission, setPermission } = useSessionStore();
  const { setActiveTab, closeTab, reorderTabs, moveTabToPane, openTab, getAllOpenTabs, closePane, createPane, setTabMode } = usePaneStore();
  const { sessionId } = useChatStore();
  const { addVersion } = useVersionStore();
  const { activeDiff, clearDiff } = useDiffStore();

  // Get session permissions for all files
  const sessionPerms = activeTab?.type === 'session'
    ? Object.fromEntries(files.map(f => [f.id, getPermission(activeTab.id, f.id)]))
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
      className={`flex-1 min-w-[320px] max-w-full flex flex-col border-r border-gray-200 bg-white transition-all relative ${
        isActive ? 'ring-1 ring-inset ring-blue-400 z-10' : 'opacity-95'
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
      <div className="flex items-center h-9 bg-gray-100 border-b border-gray-200 select-none">
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
                className={`group relative flex items-center gap-2 px-2 min-w-[100px] max-w-[160px] text-xs cursor-pointer border-r border-gray-200 h-full ${
                  pane.activeTabId === tab.id
                    ? 'bg-white text-blue-600 border-t-2 border-t-blue-500 font-medium'
                    : 'bg-gray-50 text-gray-500 hover:bg-gray-200'
                } ${isDropTarget ? 'border-l-2 border-l-blue-400' : ''} ${
                  isBeingDragged ? 'opacity-40' : ''
                }`}
              >
                <GripVertical size={12} className="text-gray-400 cursor-grab active:cursor-grabbing flex-shrink-0" />
                <FileIcon type={tab.type} />
                <span className="truncate flex-1">{tab.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(pane.id, tab.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 hover:bg-gray-300 rounded p-0.5 transition-opacity flex-shrink-0"
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
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-200 text-gray-500 transition-colors"
          title="Split Pane"
        >
          <Split size={14} />
        </button>

        {/* New Tab Button */}
        <div className="relative">
          <button
            onClick={() => setShowNewTabMenu(!showNewTabMenu)}
            className="w-8 h-8 flex items-center justify-center hover:bg-gray-200 text-gray-500 transition-colors"
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
              <div className="absolute right-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[140px]">
                <button
                  onClick={handleCreateNewMarkdown}
                  disabled={isCreating}
                  className="w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-gray-100 transition-colors"
                >
                  <FileText size={14} />
                  {isCreating ? 'Creating...' : 'New Markdown'}
                </button>
                <button
                  onClick={handleStartChat}
                  className="w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-gray-100 transition-colors"
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
          className="w-8 flex items-center justify-center hover:bg-red-50 hover:text-red-600 text-gray-400 h-full border-l border-gray-200"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-hidden relative bg-white">
        {!activeTab ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 pointer-events-none select-none">
            <div className="bg-gray-50 p-4 rounded-full mb-3">
              <Split size={24} className="text-gray-300" />
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
          <div className="flex flex-col h-full bg-white">
            <div className="bg-blue-50 px-3 py-2 border-b border-blue-100 text-blue-800 flex justify-between items-center text-xs">
              <span className="flex items-center gap-2">
                <GitCommit size={14} />{' '}
                <strong>{activeDiff?.versionLabel || 'Diff View'}</strong>
              </span>
              <button
                onClick={() => {
                  clearDiff();
                  setTabMode(pane.id, activeTab.id, 'editor');
                }}
                className="text-xs bg-white border border-blue-200 px-2 py-0.5 rounded hover:bg-blue-100"
              >
                Exit Diff
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              {activeDiff ? (
                <MonacoSideBySideDiff
                  oldContent={activeDiff.oldContent}
                  newContent={activeDiff.newContent}
                  onAccept={(finalContent) => {
                    // Apply accepted changes to the file
                    updateFileContent(activeTab.id, finalContent);
                    clearDiff();
                    setTabMode(pane.id, activeTab.id, 'editor');
                  }}
                  onReject={(originalContent) => {
                    // Revert to original content
                    updateFileContent(activeTab.id, originalContent);
                    clearDiff();
                    setTabMode(pane.id, activeTab.id, 'editor');
                  }}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-gray-400">
                  No diff data available
                </div>
              )}
            </div>
          </div>
        ) : activeTab.type === 'pdf' ? (
          <div className="w-full h-full bg-gray-100 flex flex-col">
            {(() => {
              const file = files.find((f) => f.id === activeTab.id);
              if (!file || !file.url) {
                return (
                  <div className="flex flex-col items-center justify-center h-full text-gray-400">
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
            <p className="text-gray-500">Generic Viewer</p>
          </div>
        )}
      </div>
    </div>
  );
}
