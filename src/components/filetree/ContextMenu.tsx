import { useEffect, useRef } from 'react';
import {
  FileText,
  MessageSquare,
  Folder,
  Trash2,
  Download,
  Edit3,
  Copy,
  Clipboard,
  FolderOpen,
} from 'lucide-react';
import { FileNode } from '../../types';

interface ContextMenuProps {
  x: number;
  y: number;
  file: FileNode | null;
  onClose: () => void;
  onNewFile: (parentId?: string) => void;
  onNewSession: (parentId?: string) => void;
  onNewFolder: (parentId?: string) => void;
  onRename: (file: FileNode) => void;
  onDelete: (fileId: string) => void;
  onDownload: (fileId: string) => void;
  onCopy: (file: FileNode) => void;
  onPaste: (parentId?: string) => void;
  onOpenInNewPane: (file: FileNode) => void;
  canPaste: boolean;
}

export function ContextMenu({
  x,
  y,
  file,
  onClose,
  onNewFile,
  onNewSession,
  onNewFolder,
  onRename,
  onDelete,
  onDownload,
  onCopy,
  onPaste,
  onOpenInNewPane,
  canPaste,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position to keep menu in viewport
  const adjustedX = Math.min(x, window.innerWidth - 200);
  const adjustedY = Math.min(y, window.innerHeight - 300);

  const parentId = file?.type === 'folder' ? file.id : undefined;

  const MenuItem = ({
    icon: Icon,
    label,
    onClick,
    danger = false,
    disabled = false,
  }: {
    icon: React.ElementType;
    label: string;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
  }) => (
    <button
      onClick={() => {
        if (!disabled) {
          onClick();
          onClose();
        }
      }}
      disabled={disabled}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
        disabled
          ? 'text-theme-text/30 cursor-not-allowed'
          : danger
            ? 'text-red-500 hover:bg-red-500/10'
            : 'text-theme-text/80 hover:bg-theme-text/10'
      }`}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );

  const Divider = () => <div className="border-t border-theme-border/20 my-1" />;

  return (
    <div
      ref={menuRef}
      className="fixed bg-theme-bg border border-theme-border/20 rounded-lg shadow-lg py-1 z-50 min-w-[180px]"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {/* New items */}
      <MenuItem icon={FileText} label="New File" onClick={() => onNewFile(parentId)} />
      <MenuItem icon={MessageSquare} label="New Session" onClick={() => onNewSession(parentId)} />
      <MenuItem icon={Folder} label="New Folder" onClick={() => onNewFolder(parentId)} />

      <Divider />

      {/* File operations */}
      {file && file.type !== 'folder' && (
        <>
          <MenuItem icon={FolderOpen} label="Open in New Pane" onClick={() => onOpenInNewPane(file)} />
          <Divider />
        </>
      )}

      {file && (
        <>
          <MenuItem icon={Edit3} label="Rename" onClick={() => onRename(file)} />
          <MenuItem icon={Copy} label="Copy" onClick={() => onCopy(file)} />
        </>
      )}

      <MenuItem
        icon={Clipboard}
        label="Paste"
        onClick={() => onPaste(parentId)}
        disabled={!canPaste}
      />

      {file && file.type !== 'folder' && (
        <MenuItem icon={Download} label="Download" onClick={() => onDownload(file.id)} />
      )}

      {file && (
        <>
          <Divider />
          <MenuItem icon={Trash2} label="Delete" onClick={() => onDelete(file.id)} danger />
        </>
      )}
    </div>
  );
}
