import { useState, useEffect, useRef, useCallback } from 'react';
import { useFileTreeStore } from '../../stores/fileTreeStore';
import { usePaneStore } from '../../stores/paneStore';
import { useFileStore } from '../../stores/apiStore';
import { FileNode, ViewMode } from '../../types';
import {
  RefreshCw,
  Plus,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { NewItemDialog } from '../ui/NewItemDialog';
import { ContextMenu } from './ContextMenu';
import { FileIcon } from '../ui/FileIcon';

type DialogType = 'md' | 'session' | 'folder' | 'rename' | null;

interface DragState {
  isDragging: boolean;
  draggedFile: FileNode | null;
  dropTargetId: string | null;
  dropPosition: 'before' | 'inside' | 'after' | null;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  file: FileNode | null;
}

interface QuickActionMenuState {
  visible: boolean;
  x: number;
  y: number;
  parentId?: string;
}

interface UploadProgressState {
  total: number;
  completed: number;
  currentFileIndex: number;
  currentFileName: string;
  currentFilePages: number | null;
  currentFileSizeMb: number;
  phase: 'preparing' | 'uploading' | 'processing' | 'finalizing';
  currentFileProgress: number;
  overallProgress: number;
  estimateRemainingMs: number | null;
  elapsedMs: number;
}

const QUICK_ACTION_MENU_WIDTH = 190;
const QUICK_ACTION_MENU_HEIGHT = 240;
const QUICK_ACTION_MENU_MARGIN = 8;
const UPLOAD_BENCHMARK_KEY = 'cognition.upload.benchmark.v1';
const DEFAULT_UPLOAD_BENCHMARK = {
  pdfMsPerPage: 1800,
  genericMsPerMb: 1100,
};

function readUploadBenchmark() {
  if (typeof window === 'undefined') return DEFAULT_UPLOAD_BENCHMARK;
  try {
    const raw = window.localStorage.getItem(UPLOAD_BENCHMARK_KEY);
    if (!raw) return DEFAULT_UPLOAD_BENCHMARK;
    const parsed = JSON.parse(raw);
    return {
      pdfMsPerPage: Number(parsed?.pdfMsPerPage) || DEFAULT_UPLOAD_BENCHMARK.pdfMsPerPage,
      genericMsPerMb: Number(parsed?.genericMsPerMb) || DEFAULT_UPLOAD_BENCHMARK.genericMsPerMb,
    };
  } catch {
    return DEFAULT_UPLOAD_BENCHMARK;
  }
}

function writeUploadBenchmark(next: typeof DEFAULT_UPLOAD_BENCHMARK) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(UPLOAD_BENCHMARK_KEY, JSON.stringify(next));
}

async function readPdfPageCount(file: File): Promise<number | null> {
  if (!file.name.toLowerCase().endsWith('.pdf')) return null;
  try {
    const { pdfjs } = await import('react-pdf');
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
    }
    const buffer = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buffer }).promise;
    return Number.isFinite(doc.numPages) ? doc.numPages : null;
  } catch {
    return null;
  }
}

async function estimateUploadWork(file: File) {
  const benchmark = readUploadBenchmark();
  const sizeMb = Math.max(file.size / (1024 * 1024), 0.05);
  const pages = await readPdfPageCount(file);

  if (pages) {
    return {
      pages,
      sizeMb,
      estimatedMs: Math.max(3000, Math.round(pages * benchmark.pdfMsPerPage + sizeMb * 420)),
    };
  }

  return {
    pages: null,
    sizeMb,
    estimatedMs: Math.max(2200, Math.round(sizeMb * benchmark.genericMsPerMb + 1400)),
  };
}

function updateUploadBenchmark(
  estimate: Awaited<ReturnType<typeof estimateUploadWork>>,
  elapsedMs: number
) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return;
  const current = readUploadBenchmark();
  if (estimate.pages && estimate.pages > 0) {
    current.pdfMsPerPage = Math.max(
      600,
      Math.round(current.pdfMsPerPage * 0.72 + (elapsedMs / estimate.pages) * 0.28)
    );
  } else if (estimate.sizeMb > 0) {
    current.genericMsPerMb = Math.max(
      350,
      Math.round(current.genericMsPerMb * 0.72 + (elapsedMs / estimate.sizeMb) * 0.28)
    );
  }
  writeUploadBenchmark(current);
}

function formatDuration(ms: number | null) {
  if (!ms || ms <= 0) return 'finishing';
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function phaseLabel(phase: UploadProgressState['phase']) {
  if (phase === 'preparing') return 'Preparing upload';
  if (phase === 'uploading') return 'Uploading bytes';
  if (phase === 'processing') return 'Parsing · OCR · Embedding';
  return 'Finalizing index';
}

function UploadProgressRing({ progress }: { progress: number }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, progress));
  const dashOffset = circumference * (1 - clamped / 100);

  return (
    <div data-testid="upload-progress-ring" className="relative h-24 w-24 flex-shrink-0">
      <div className="absolute inset-0 rounded-full bg-[radial-gradient(circle_at_30%_30%,rgba(255,255,255,0.88),rgba(191,219,254,0.52)_42%,rgba(219,234,254,0.14)_72%,transparent_100%)]" />
      <svg className="relative h-24 w-24 -rotate-90 drop-shadow-[0_8px_16px_rgba(59,130,246,0.18)]" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r={radius} fill="none" stroke="rgba(148,163,184,0.18)" strokeWidth="8" />
        <circle
          cx="48"
          cy="48"
          r={radius}
          fill="none"
          stroke="url(#upload-ring-gradient)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
        <defs>
          <linearGradient id="upload-ring-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#0f766e" />
            <stop offset="52%" stopColor="#2563eb" />
            <stop offset="100%" stopColor="#7c3aed" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-[22px] font-semibold tracking-[-0.04em] text-slate-950">{Math.round(clamped)}</span>
        <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Total</span>
      </div>
    </div>
  );
}

export function FileTree() {
  const {
    fileTree,
    toggleFolder,
    createFile,
    createFolder,
    deleteFile,
    renameFile,
    moveFile,
    loading,
    loadFilesFromBackend,
  } = useFileTreeStore();
  const { panes, activePaneId, openTab, createPane } = usePaneStore();
  const { uploadFile: apiUploadFile, downloadFile } = useFileStore();

  const [dialogType, setDialogType] = useState<DialogType>(null);
  const [selectedParentId, setSelectedParentId] = useState<string | undefined>();
  const [selectedFile, setSelectedFile] = useState<FileNode | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [clipboard, setClipboard] = useState<FileNode | null>(null);

  const [dragState, setDragState] = useState<DragState>({
    isDragging: false,
    draggedFile: null,
    dropTargetId: null,
    dropPosition: null,
  });

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    file: null,
  });
  const [quickActionMenu, setQuickActionMenu] = useState<QuickActionMenuState>({
    visible: false,
    x: 0,
    y: 0,
    parentId: undefined,
  });
  const [pathFocusId, setPathFocusId] = useState<string | undefined>(undefined);
  const [uploadProgress, setUploadProgress] = useState<UploadProgressState | null>(null);

  const treeRef = useRef<HTMLDivElement>(null);
  const activeFileId = panes.find((p) => p.id === activePaneId)?.activeTabId || null;

  useEffect(() => {
    loadFilesFromBackend();
  }, [loadFilesFromBackend]);

  useEffect(() => {
    if (!quickActionMenu.visible) return;

    const handleClick = () => {
      setQuickActionMenu({ visible: false, x: 0, y: 0, parentId: undefined });
    };

    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [quickActionMenu.visible]);

  const handleToggleFolder = (id: string) => {
    toggleFolder(id);
  };

  const findPathForNode = useCallback((targetId?: string): string[] => {
    if (!targetId) return ['root'];
    const walk = (nodes: FileNode[], path: string[]): string[] | null => {
      for (const node of nodes) {
        const nextPath = [...path, node.name];
        if (node.id === targetId) {
          return nextPath;
        }
        if (node.children?.length) {
          const found = walk(node.children, nextPath);
          if (found) return found;
        }
      }
      return null;
    };

    const found = walk(fileTree, ['root']);
    return found || ['root'];
  }, [fileTree]);

  const openQuickActionMenu = (e: React.MouseEvent, parentId?: string) => {
    e.preventDefault();
    e.stopPropagation();
    setPathFocusId(parentId);

    const treeRect = treeRef.current?.getBoundingClientRect();
    const preferredLeft = treeRect ? treeRect.left + 10 : QUICK_ACTION_MENU_MARGIN;
    const maxLeft = Math.max(
      QUICK_ACTION_MENU_MARGIN,
      window.innerWidth - QUICK_ACTION_MENU_WIDTH - QUICK_ACTION_MENU_MARGIN
    );
    const left = Math.min(Math.max(preferredLeft, QUICK_ACTION_MENU_MARGIN), maxLeft);

    const preferredTop = e.clientY - 8;
    const maxTop = Math.max(
      QUICK_ACTION_MENU_MARGIN,
      window.innerHeight - QUICK_ACTION_MENU_HEIGHT - QUICK_ACTION_MENU_MARGIN
    );
    const top = Math.min(Math.max(preferredTop, QUICK_ACTION_MENU_MARGIN), maxTop);

    setQuickActionMenu({
      visible: true,
      x: left,
      y: top,
      parentId,
    });
  };

  const handleOpenFile = (file: FileNode) => {
    if (file.type === 'folder') return;

    const paneId = activePaneId || panes[0]?.id;
    if (!paneId) return;

    openTab(paneId, {
      id: file.id,
      name: file.name,
      type: file.type as any,
      mode: 'editor' as ViewMode,
    });
  };

  const handleOpenInNewPane = (file: FileNode) => {
    if (file.type === 'folder') return;

    createPane();
    // Get the newly created pane (last one in the list)
    const newPaneId = usePaneStore.getState().panes[usePaneStore.getState().panes.length - 1].id;
    openTab(newPaneId, {
      id: file.id,
      name: file.name,
      type: file.type as any,
      mode: 'editor' as ViewMode,
    });
  };

  // Drag and Drop handlers
  const handleDragStart = (e: React.DragEvent, file: FileNode) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/json', JSON.stringify(file));
    setDragState({
      isDragging: true,
      draggedFile: file,
      dropTargetId: null,
      dropPosition: null,
    });
  };

  const handleDragOver = useCallback(
    (e: React.DragEvent, targetFile: FileNode) => {
      e.preventDefault();
      e.stopPropagation();

      if (!dragState.draggedFile || dragState.draggedFile.id === targetFile.id) {
        return;
      }

      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const y = e.clientY - rect.top;
      const height = rect.height;

      let position: 'before' | 'inside' | 'after';
      if (targetFile.type === 'folder') {
        if (y < height * 0.25) {
          position = 'before';
        } else if (y > height * 0.75) {
          position = 'after';
        } else {
          position = 'inside';
        }
      } else {
        position = y < height / 2 ? 'before' : 'after';
      }

      if (
        dragState.dropTargetId !== targetFile.id ||
        dragState.dropPosition !== position
      ) {
        setDragState((prev) => ({
          ...prev,
          dropTargetId: targetFile.id,
          dropPosition: position,
        }));
      }
    },
    [dragState.draggedFile, dragState.dropTargetId, dragState.dropPosition]
  );

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    // Only clear if leaving the tree entirely
    if (!treeRef.current?.contains(e.relatedTarget as Node)) {
      setDragState((prev) => ({
        ...prev,
        dropTargetId: null,
        dropPosition: null,
      }));
    }
  };

  const handleDrop = async (e: React.DragEvent, targetFile: FileNode) => {
    e.preventDefault();
    e.stopPropagation();

    if (!dragState.draggedFile || dragState.draggedFile.id === targetFile.id) {
      setDragState({
        isDragging: false,
        draggedFile: null,
        dropTargetId: null,
        dropPosition: null,
      });
      return;
    }

    const { dropPosition } = dragState;

    if (dropPosition === 'inside' && targetFile.type === 'folder') {
      await moveFile(dragState.draggedFile.id, targetFile.id);
    } else if (dropPosition === 'before' || dropPosition === 'after') {
      await moveFile(dragState.draggedFile.id, undefined, targetFile.id, dropPosition);
    }

    setDragState({
      isDragging: false,
      draggedFile: null,
      dropTargetId: null,
      dropPosition: null,
    });
  };

  const handleDragEnd = () => {
    setDragState({
      isDragging: false,
      draggedFile: null,
      dropTargetId: null,
      dropPosition: null,
    });
  };

  // Context menu handlers
  const handleContextMenu = (e: React.MouseEvent, file: FileNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    setQuickActionMenu({ visible: false, x: 0, y: 0, parentId: undefined });
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      file,
    });
  };

  const closeContextMenu = () => {
    setContextMenu({ visible: false, x: 0, y: 0, file: null });
  };

  const handleDeleteFile = async (fileId: string) => {
    if (confirm('Are you sure you want to delete this item?')) {
      await deleteFile(fileId);
    }
  };

  const handleDownloadFile = async (fileId: string) => {
    await downloadFile(fileId);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadFilesFromBackend();
    setRefreshing(false);
  };

  const handleSelectedFiles = useCallback(async (selectedFiles: File[], parentId: string | null) => {
    if (selectedFiles.length === 0) return;
    try {
      for (const [index, file] of selectedFiles.entries()) {
        const estimate = await estimateUploadWork(file);
        const startedAt = performance.now();
        let uploadRatio = 0;
        let settled = false;

        const emitProgress = (phaseOverride?: UploadProgressState['phase']) => {
          const elapsedMs = Math.max(0, performance.now() - startedAt);
          const phase = phaseOverride || (uploadRatio >= 1 ? 'processing' : 'uploading');
          let currentFileRatio = 0.04;
          if (phase === 'preparing') {
            currentFileRatio = 0.04;
          } else if (phase === 'uploading') {
            currentFileRatio = Math.max(0.08, uploadRatio * 0.24);
          } else if (phase === 'processing') {
            const processingRatio = Math.min(0.72, elapsedMs / Math.max(estimate.estimatedMs, 1) * 0.72);
            currentFileRatio = Math.min(0.96, 0.24 + processingRatio);
          } else {
            currentFileRatio = 1;
          }

          setUploadProgress({
            total: selectedFiles.length,
            completed: phase === 'finalizing' ? index + 1 : index,
            currentFileIndex: index + 1,
            currentFileName: file.name,
            currentFilePages: estimate.pages,
            currentFileSizeMb: estimate.sizeMb,
            phase,
            currentFileProgress: Math.round(currentFileRatio * 100),
            overallProgress: Math.round(((index + currentFileRatio) / selectedFiles.length) * 100),
            estimateRemainingMs: phase === 'finalizing' ? 0 : Math.max(0, estimate.estimatedMs - elapsedMs),
            elapsedMs: Math.round(elapsedMs),
          });
        };

        emitProgress('preparing');
        const ticker = window.setInterval(() => {
          if (!settled) emitProgress();
        }, 140);

        try {
          const uploadedFileId = await apiUploadFile(file, parentId || null, {
            onUploadProgress: (snapshot) => {
              uploadRatio = Math.min(1, snapshot.percent / 100);
              emitProgress(uploadRatio >= 1 ? 'processing' : 'uploading');
            },
          });
          if (!uploadedFileId) {
            throw new Error(`Upload failed for ${file.name}`);
          }
          settled = true;
          window.clearInterval(ticker);
          const elapsedMs = Math.max(0, performance.now() - startedAt);
          updateUploadBenchmark(estimate, elapsedMs);
          setUploadProgress({
            total: selectedFiles.length,
            completed: index + 1,
            currentFileIndex: index + 1,
            currentFileName: file.name,
            currentFilePages: estimate.pages,
            currentFileSizeMb: estimate.sizeMb,
            phase: 'finalizing',
            currentFileProgress: 100,
            overallProgress: Math.round(((index + 1) / selectedFiles.length) * 100),
            estimateRemainingMs: 0,
            elapsedMs: Math.round(elapsedMs),
          });
        } finally {
          settled = true;
          window.clearInterval(ticker);
        }
      }
      await loadFilesFromBackend();
    } catch (error) {
      console.error('Failed to upload file(s):', error);
    } finally {
      await new Promise((resolve) => window.setTimeout(resolve, 480));
      setUploadProgress(null);
    }
  }, [apiUploadFile, loadFilesFromBackend]);

  const openNewDialog = (type: DialogType, parentId?: string, file?: FileNode) => {
    setDialogType(type);
    setSelectedParentId(parentId);
    setSelectedFile(file || null);
  };

  const closeDialog = () => {
    setDialogType(null);
    setSelectedParentId(undefined);
    setSelectedFile(null);
  };

  const triggerUploadForParent = (parentId?: string) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.txt,.pdf';
    input.multiple = true;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.style.position = 'absolute';
    input.style.width = '1px';
    input.style.height = '1px';
    input.style.opacity = '0';
    input.style.overflow = 'hidden';
    input.style.pointerEvents = 'none';
    input.style.clipPath = 'inset(50%)';
    input.style.whiteSpace = 'nowrap';
    input.style.left = '-9999px';
    input.style.top = '0';

    const cleanup = () => {
      input.removeEventListener('change', handleChange);
      input.remove();
    };

    const handleChange = () => {
      const files = input.files ? Array.from(input.files) : [];
      cleanup();
      if (files.length === 0) return;
      void handleSelectedFiles(files, parentId || null);
    };

    input.addEventListener('change', handleChange, { once: true });
    input.addEventListener('cancel', cleanup, { once: true });
    document.body.appendChild(input);

    try {
      if (typeof input.showPicker === 'function') {
        input.showPicker();
        return;
      }
    } catch {
      // Fall back to click below.
    }
    input.click();
  };

  const handleCreate = async (name: string) => {
    if (dialogType === 'rename' && selectedFile) {
      renameFile(selectedFile.id, name);
    } else if (dialogType === 'folder') {
      // Support path-based creation: "folder1/folder2/folder3"
      const parts = name.split('/').filter(Boolean);
      let currentParentId = selectedParentId;

      for (const part of parts) {
        const folderId = await createFolder(part, currentParentId);
        if (!folderId) break;
        currentParentId = folderId;
      }
    } else if (dialogType === 'md' || dialogType === 'session') {
      // Support path-based creation: "folder1/folder2/file.md"
      const parts = name.split('/').filter(Boolean);

      if (parts.length > 1) {
        let currentParentId = selectedParentId;
        // Create folders for all but the last part
        for (let i = 0; i < parts.length - 1; i++) {
          const folderId = await createFolder(parts[i], currentParentId);
          if (!folderId) break;
          currentParentId = folderId;
        }
        // Create the file in the final folder
        await createFile(parts[parts.length - 1], dialogType, currentParentId);
      } else {
        await createFile(name, dialogType, selectedParentId);
      }
    }
  };

  const handleCopy = (file: FileNode) => {
    setClipboard(file);
  };

  const handlePaste = async (parentId?: string) => {
    if (!clipboard) return;
    // For now, just create a copy with "(copy)" suffix
    const newName = clipboard.name.replace(/(\.[^.]+)?$/, ' (copy)$1');
    if (clipboard.type === 'folder') {
      await createFolder(newName, parentId);
    } else if (clipboard.type === 'md' || clipboard.type === 'session') {
      await createFile(newName, clipboard.type as 'md' | 'session', parentId);
    }
  };

  const getDialogConfig = () => {
    switch (dialogType) {
      case 'md':
        return {
          title: 'New File',
          placeholder: 'path/to/file.md',
          defaultValue: 'untitled.md',
        };
      case 'session':
        return {
          title: 'New Session',
          placeholder: 'My Discussion',
          defaultValue: 'New Session',
        };
      case 'folder':
        return {
          title: 'New Folder',
          placeholder: 'path/to/folder',
          defaultValue: 'New Folder',
        };
      case 'rename':
        return {
          title: 'Rename',
          placeholder: 'New name',
          defaultValue: selectedFile?.name || '',
        };
      default:
        return { title: '', placeholder: '', defaultValue: '' };
    }
  };

  // Recursive tree item renderer
  const renderTreeItem = (item: FileNode, depth: number = 0) => {
    const isDropTarget = dragState.dropTargetId === item.id;
    const dropPosition = dragState.dropPosition;

    const dropIndicatorClass =
      isDropTarget && dropPosition === 'before'
        ? 'before:absolute before:left-0 before:right-0 before:top-0 before:h-0.5 before:bg-theme-text/60'
        : isDropTarget && dropPosition === 'after'
          ? 'after:absolute after:left-0 after:right-0 after:bottom-0 after:h-0.5 after:bg-theme-text/60'
          : isDropTarget && dropPosition === 'inside'
            ? 'bg-theme-text/8 ring-1 ring-theme-border/45'
            : '';

    return (
      <div key={item.id} className="relative">
        <div
          className={`group flex items-center gap-1 py-1 cursor-pointer text-sm hover:bg-theme-text/10 select-none relative transition-colors ${
            activeFileId === item.id ? 'bg-theme-text/20 text-theme-text font-medium' : 'text-theme-text/80'
          } ${dropIndicatorClass}`}
          style={{ paddingLeft: `${depth * 16 + 8}px`, paddingRight: '8px', borderRadius: '8px' }}
          onClick={() =>
            item.type === 'folder' ? handleToggleFolder(item.id) : handleOpenFile(item)
          }
          onContextMenu={(e) => handleContextMenu(e, item)}
          draggable
          onDragStart={(e) => handleDragStart(e, item)}
          onDragOver={(e) => handleDragOver(e, item)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, item)}
          onDragEnd={handleDragEnd}
          onMouseEnter={() => {
            if (item.type === 'folder') {
              setPathFocusId(item.id);
            }
          }}
        >
          {/* Expand/Collapse icon for folders */}
          <span className="w-4 flex-shrink-0 text-theme-text/40">
            {item.type === 'folder' ? (
              item.isOpen ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )
            ) : null}
          </span>

          {/* File icon */}
          <FileIcon type={item.type} />

          {/* File name */}
          <span className="truncate flex-1">{item.name}</span>

          {item.type === 'folder' && (
            <button
              className="opacity-0 group-hover:opacity-100 p-1 rounded-md hover:bg-theme-text/15 transition-all"
              title="Add to this folder"
              onClick={(e) => openQuickActionMenu(e, item.id)}
            >
              <Plus size={12} />
            </button>
          )}
        </div>

        {/* Children */}
        {item.type === 'folder' && item.isOpen && item.children && (
          <div>
            {item.children.map((child) => renderTreeItem(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div
        ref={treeRef}
        className="flex-1 overflow-y-auto py-2 relative"
        onContextMenu={(e) => {
          // Context menu on empty area
          if (e.target === treeRef.current) {
            handleContextMenu(e, null);
          }
        }}
      >
        {/* Fixed Root Path Bar */}
        <div className="sticky top-0 z-20 px-2 pb-2 bg-theme-surface-muted/95 backdrop-blur-sm">
          <div className="flex items-center justify-between rounded-[18px] border border-theme-border/25 bg-theme-bg px-3 py-2 shadow-[0_2px_8px_rgba(0,0,0,0.06)]">
            <div className="text-[11px] text-theme-text/65 truncate">
              {findPathForNode(pathFocusId || selectedParentId).join(' / ')}
            </div>
            <button
              data-testid="explorer-add-root"
              className="p-1.5 rounded-full border border-theme-border/25 hover:bg-theme-text/10 transition-colors"
              title="Add at current path"
              onClick={(e) => openQuickActionMenu(e, pathFocusId || selectedParentId)}
            >
              <Plus size={12} />
            </button>
          </div>
        </div>

        {/* Header */}
        <div className="px-4 py-2 text-xs font-semibold tracking-[0.08em] text-theme-text/45 uppercase flex items-center justify-between">
          <span>Explorer</span>
          <button
            data-testid="explorer-refresh"
            onClick={handleRefresh}
            className={`p-1.5 hover:bg-theme-text/10 rounded-md transition-colors pill-button ${refreshing ? 'animate-spin' : ''}`}
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>

        {uploadProgress && (
          <div
            data-testid="upload-progress-card"
            className="mx-4 mb-3 overflow-hidden rounded-[26px] border border-sky-200/75 bg-[linear-gradient(135deg,rgba(239,246,255,0.98),rgba(224,242,254,0.92)_52%,rgba(245,243,255,0.94))] px-4 py-4 shadow-[0_18px_40px_rgba(14,116,144,0.12)]"
          >
            <div className="flex items-center gap-4">
              <UploadProgressRing progress={uploadProgress.overallProgress} />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-sky-700/75">
                      {phaseLabel(uploadProgress.phase)}
                    </div>
                    <div className="mt-1 truncate text-sm font-semibold text-slate-950">
                      {uploadProgress.currentFileName}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-600">
                      File {uploadProgress.currentFileIndex}/{uploadProgress.total}
                      {uploadProgress.currentFilePages
                        ? ` · ${uploadProgress.currentFilePages} pages`
                        : ` · ${uploadProgress.currentFileSizeMb.toFixed(1)} MB`}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-lg font-semibold tracking-[-0.04em] text-slate-950">
                      {uploadProgress.currentFileProgress}%
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {uploadProgress.completed} completed
                    </div>
                  </div>
                </div>

                <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/70 ring-1 ring-sky-200/60">
                  <div
                    className="h-full rounded-full bg-[linear-gradient(90deg,#0f766e_0%,#2563eb_56%,#7c3aed_100%)] transition-[width] duration-200 ease-out"
                    style={{ width: `${uploadProgress.currentFileProgress}%` }}
                  />
                </div>

                <div className="mt-3 flex items-center justify-between gap-3 text-[11px] text-slate-600">
                  <span>{formatDuration(uploadProgress.elapsedMs)} elapsed</span>
                  <span>
                    {uploadProgress.estimateRemainingMs === 0
                      ? 'index ready'
                      : `~${formatDuration(uploadProgress.estimateRemainingMs)} remaining`}
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* File Tree */}
        {loading ? (
          <div className="px-4 py-8 text-center text-theme-text/40 text-sm">
            Loading files...
          </div>
        ) : fileTree.length === 0 ? (
          <div className="px-4 py-8 text-center text-theme-text/40 text-sm">
            No files yet.
            <br />
            Create a file, session, or folder to get started.
          </div>
        ) : (
          <div className="px-1">
            {fileTree.map((item) => renderTreeItem(item, 0))}
          </div>
        )}
      </div>
      {/* Folder/Root Quick Action Menu */}
      {quickActionMenu.visible && (
        <div
          data-testid="explorer-quick-action-menu"
          className="fixed z-[60] min-w-[190px] rounded-lg border border-theme-border/25 bg-theme-bg shadow-[0_12px_28px_rgba(0,0,0,0.16)] py-1"
          style={{
            left: quickActionMenu.x,
            top: quickActionMenu.y,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            data-testid="quick-action-new-file"
            className="w-full px-3 py-2 text-xs text-left text-theme-text/80 hover:bg-theme-text/10 transition-colors"
            onClick={() => {
              openNewDialog('md', quickActionMenu.parentId);
              setQuickActionMenu({ visible: false, x: 0, y: 0, parentId: undefined });
            }}
          >
            New File
          </button>
          <button
            data-testid="quick-action-new-session"
            className="w-full px-3 py-2 text-xs text-left text-theme-text/80 hover:bg-theme-text/10 transition-colors"
            onClick={() => {
              openNewDialog('session', quickActionMenu.parentId);
              setQuickActionMenu({ visible: false, x: 0, y: 0, parentId: undefined });
            }}
          >
            New Session
          </button>
          <button
            data-testid="quick-action-new-folder"
            className="w-full px-3 py-2 text-xs text-left text-theme-text/80 hover:bg-theme-text/10 transition-colors"
            onClick={() => {
              openNewDialog('folder', quickActionMenu.parentId);
              setQuickActionMenu({ visible: false, x: 0, y: 0, parentId: undefined });
            }}
          >
            New Folder
          </button>
          <button
            data-testid="quick-action-upload-file"
            className="w-full px-3 py-2 text-xs text-left text-theme-text/80 hover:bg-theme-text/10 transition-colors"
            onClick={() => {
              triggerUploadForParent(quickActionMenu.parentId);
              setQuickActionMenu({ visible: false, x: 0, y: 0, parentId: undefined });
            }}
          >
            Upload File
          </button>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu.visible && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          file={contextMenu.file}
          onClose={closeContextMenu}
          onNewFile={(parentId) => openNewDialog('md', parentId)}
          onNewSession={(parentId) => openNewDialog('session', parentId)}
          onNewFolder={(parentId) => openNewDialog('folder', parentId)}
          onRename={(file) => openNewDialog('rename', undefined, file)}
          onDelete={handleDeleteFile}
          onDownload={handleDownloadFile}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onOpenInNewPane={handleOpenInNewPane}
          canPaste={clipboard !== null}
        />
      )}

      {/* Dialog */}
      <NewItemDialog
        isOpen={dialogType !== null}
        onClose={closeDialog}
        onCreate={handleCreate}
        title={getDialogConfig().title}
        placeholder={getDialogConfig().placeholder}
        defaultValue={getDialogConfig().defaultValue}
      />
    </>
  );
}
