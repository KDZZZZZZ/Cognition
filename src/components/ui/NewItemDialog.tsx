import { useState, useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface NewItemDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (name: string) => void;
  title: string;
  placeholder: string;
  defaultValue?: string;
}

export function NewItemDialog({
  isOpen,
  onClose,
  onCreate,
  title,
  placeholder,
  defaultValue = '',
}: NewItemDialogProps) {
  const [name, setName] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setName(defaultValue);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, defaultValue]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName) {
      onCreate(trimmedName);
      setName('');
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <form
        onSubmit={handleSubmit}
        className="rounded-lg shadow-lg p-4 w-80 border border-theme-border/25 paper-divider"
        style={{ backgroundColor: 'var(--theme-surface)' }}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold tracking-[0.03em] text-theme-text/80">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-theme-text/10 rounded text-theme-text/40 hover:text-theme-text/75"
          >
            <X size={16} />
          </button>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          className="w-full px-3 py-2 border border-theme-border/25 paper-divider rounded-md text-sm bg-theme-bg text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-text/15"
          autoFocus
        />
        <div className="flex justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-theme-text/70 hover:bg-theme-text/8 rounded-md transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-3 py-1.5 text-sm bg-theme-text text-theme-bg rounded-md hover:opacity-90 transition-opacity"
          >
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
