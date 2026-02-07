import { ChevronRight, ChevronDown } from 'lucide-react';
import { FileIcon } from '../ui/FileIcon';
import { FileNode } from '../../types';

interface FileTreeItemProps {
  item: FileNode;
  depth?: number;
  activeFileId: string | null;
  onToggleFolder: (id: string) => void;
  onOpenFile: (file: FileNode) => void;
  onDragStart: (e: React.DragEvent, file: FileNode) => void;
}

export function FileTreeItem({
  item,
  depth = 0,
  activeFileId,
  onToggleFolder,
  onOpenFile,
  onDragStart,
}: FileTreeItemProps) {
  return (
    <div draggable={item.type !== 'folder'} onDragStart={(e) => onDragStart(e, item)}>
      <div
        className={`flex items-center gap-2 py-1.5 cursor-pointer text-sm hover:bg-gray-100 select-none ${
          activeFileId === item.id ? 'bg-blue-100 text-blue-700' : 'text-gray-700'
        }`}
        style={{ paddingLeft: `${depth * 16 + 12}px` }}
        onClick={() =>
          item.type === 'folder'
            ? onToggleFolder(item.id)
            : onOpenFile(item)
        }
      >
        <span className="text-gray-400 flex-shrink-0">
          {item.type === 'folder' && (item.isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
          {item.type !== 'folder' && <div className="w-[14px]" />}
        </span>
        <FileIcon type={item.type} />
        <span className="truncate">{item.name}</span>
      </div>
      {item.type === 'folder' && item.isOpen && item.children && (
        <div>
          {item.children.map((child) => (
            <FileTreeItem
              key={child.id}
              item={child}
              depth={depth + 1}
              activeFileId={activeFileId}
              onToggleFolder={onToggleFolder}
              onOpenFile={onOpenFile}
              onDragStart={onDragStart}
            />
          ))}
        </div>
      )}
    </div>
  );
}
