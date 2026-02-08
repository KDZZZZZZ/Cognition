import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';

export interface MonacoDiffEditorProps {
  oldContent: string;
  newContent: string;
  language?: string;
  onAccept?: (finalContent: string) => void;
  onReject?: (originalContent: string) => void;
  readOnly?: boolean;
  mode?: 'split' | 'inline';
}

export function MonacoDiffEditor({
  oldContent,
  newContent,
  language = 'markdown',
  onAccept,
  onReject,
  readOnly = false,
  mode = 'split',
}: MonacoDiffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [editorMounted, setEditorMounted] = useState(false);

  // Initialize Editor
  useEffect(() => {
    if (!containerRef.current) return;

    // Dispose previous instance if it exists to prevent memory leaks or duplicates
    if (diffEditorRef.current) {
      diffEditorRef.current.dispose();
    }

    // Create the Diff Editor
    // 'vs' is the standard light theme. For dark mode, use 'vs-dark'
    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      enableSplitViewResizing: false,
      renderSideBySide: mode === 'split', // Controls Split vs Inline
      readOnly: true, // The diff view itself is usually read-only
      originalEditable: false, // The 'left' side is immutable
      minimap: { enabled: false }, // Disable minimap to save space
      fontSize: 14,
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      automaticLayout: true, // Auto-resize with container
      wordWrap: 'on', // Important for Markdown prose
      diffWordWrap: 'on',
      theme: 'vs', // Light theme
    });

    diffEditorRef.current = diffEditor;
    setEditorMounted(true);

    // Keyboard Shortcuts
    diffEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      onAccept?.(newContent);
    });
    diffEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Escape, () => {
      onReject?.(oldContent);
    });

    return () => {
      diffEditor.dispose();
      diffEditorRef.current = null;
    };
  }, [mode]); // Re-create editor when mode changes

  // Update Content/Models when props change
  useEffect(() => {
    if (!diffEditorRef.current) return;

    const originalModel = monaco.editor.createModel(oldContent, language);
    const modifiedModel = monaco.editor.createModel(newContent, language);

    diffEditorRef.current.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    // Cleanup models when they are replaced or component unmounts
    return () => {
      // We don't manually dispose models here immediately because Monaco might still be using them
      // until the next setModel call, but it's good practice to ensure they don't leak.
      // In a complex app, we might manage model lifecycle more strictly.
      // For now, Monaco handles model disposal when the editor is disposed if we created them attached.
    };
  }, [oldContent, newContent, language, editorMounted]);

  return (
    <div className="flex flex-col h-full bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700">Diff Comparison</span>
          <div className="flex items-center gap-2 text-xs">
            <span className={`px-2 py-0.5 rounded ${mode === 'split' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
              {mode === 'split' ? 'Split View' : 'Inline View'}
            </span>
            <span className="px-2 py-0.5 bg-red-50 text-red-600 rounded border border-red-100">
              - Removed
            </span>
            <span className="px-2 py-0.5 bg-green-50 text-green-600 rounded border border-green-100">
              + Added
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onAccept && (
            <button
              onClick={() => onAccept(newContent)}
              className="flex items-center gap-1 px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
              title="Accept all changes (Ctrl+Enter)"
            >
              Accept All
            </button>
          )}
          {onReject && (
            <button
              onClick={() => onReject(oldContent)}
              className="flex items-center gap-1 px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
              title="Reject all changes (Ctrl+Esc)"
            >
              Reject All
            </button>
          )}
        </div>
      </div>

      {/* Editor Container */}
      <div className="flex-1 relative" ref={containerRef} />
    </div>
  );
}

// Export a compatibility alias if needed, or update consumers
export const MonacoSideBySideDiff = MonacoDiffEditor;
