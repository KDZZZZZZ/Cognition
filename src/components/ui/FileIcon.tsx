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
  switch (type) {
    case 'folder':
      return <Folder size={size} className={className || 'text-gray-500'} />;
    case 'pdf':
      return <FileText size={size} className={className || 'text-red-400'} />;
    case 'md':
      return <FileCode size={size} className={className || 'text-blue-400'} />;
    case 'session':
      return <MessageSquare size={size} className={className || 'text-purple-400'} />;
    case 'code':
      return <FileLucideIcon size={size} className={className || 'text-yellow-500'} />;
    case 'image':
      return <FileLucideIcon size={size} className={className || 'text-purple-400'} />;
    default:
      return <FileText size={size} />;
  }
}
