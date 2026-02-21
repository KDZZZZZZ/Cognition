import { Eye, Pencil, EyeOff, Loader2 } from 'lucide-react';
import { Permission } from '../../types';

interface PermissionToggleProps {
  status: Permission;
  onClick: () => void;
  syncing?: boolean;
}

export function PermissionToggle({ status, onClick, syncing = false }: PermissionToggleProps) {
  const getIcon = () => {
    if (syncing) {
      return <Loader2 size={14} className="text-blue-400 animate-spin" />;
    }

    switch (status) {
      case 'read':
        return <Eye size={14} className="text-theme-text" />;
      case 'write':
        return <Pencil size={14} className="text-theme-text" />;
      case 'none':
        return <EyeOff size={14} className="text-theme-text/40" />;
      default:
        return <Eye size={14} className="text-theme-text" />;
    }
  };

  const getLabel = () => {
    switch (status) {
      case 'read':
        return 'Read permission';
      case 'write':
        return 'Write permission';
      case 'none':
        return 'Hidden from AI';
      default:
        return 'Read permission';
    }
  };

  return (
    <button
      onClick={onClick}
      disabled={syncing}
      className={`p-1.5 rounded hover:bg-theme-text/15 transition-colors flex items-center gap-1 border border-theme-border/25 paper-divider ${
        status === 'none' ? 'bg-theme-text/5 text-theme-text/40' : 'bg-theme-bg text-theme-text'
      } ${syncing ? 'opacity-70 cursor-wait' : ''}`}
      title={getLabel()}
    >
      {getIcon()}
    </button>
  );
}
