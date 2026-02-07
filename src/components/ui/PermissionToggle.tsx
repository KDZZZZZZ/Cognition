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
        return <Eye size={14} className="text-blue-500" />;
      case 'write':
        return <Pencil size={14} className="text-green-500" />;
      case 'none':
        return <EyeOff size={14} className="text-gray-400" />;
      default:
        return <Eye size={14} className="text-blue-500" />;
    }
  };

  const getLabel = () => {
    if (syncing) return 'Syncing...';
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

  const getBgColor = () => {
    switch (status) {
      case 'read':
        return 'bg-blue-50';
      case 'write':
        return 'bg-green-50';
      case 'none':
        return 'bg-gray-100';
      default:
        return 'bg-blue-50';
    }
  };

  return (
    <button
      onClick={onClick}
      disabled={syncing}
      className={`p-1.5 rounded hover:bg-gray-200 transition-colors flex items-center gap-1 border border-gray-200 ${getBgColor()} ${
        syncing ? 'opacity-70 cursor-wait' : ''
      }`}
      title={getLabel()}
    >
      {getIcon()}
    </button>
  );
}
