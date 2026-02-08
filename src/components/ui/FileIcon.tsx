import {
  Folder,
  FileText,
  FileCode,
  MessageSquare,
  File as FileLucideIcon,
} from 'lucide-react';
import { FileType } from '../../types';

interface IconProps {
  type: FileType;
  size?: number;
  className?: string;
}

export function FileIcon({ type, size = 16, className }: IconProps) {
  const defaultClass = className || 'text-theme-text/70';

  switch (type) {
    case 'folder':
      return <Folder size={size} className={className || 'text-theme-text/60'} />;
    case 'pdf':
      return <FileText size={size} className={className || 'text-theme-text'} />;
    case 'md':
      return <FileCode size={size} className={className || 'text-theme-text'} />;
    case 'session':
      return <MessageSquare size={size} className={className || 'text-theme-text'} />;
    case 'code':
      return <FileLucideIcon size={size} className={className || 'text-theme-text'} />;
    case 'image':
      return <FileLucideIcon size={size} className={className || 'text-theme-text'} />;
    default:
      return <FileText size={size} className={defaultClass} />;
  }
}
