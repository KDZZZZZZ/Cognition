import { useEffect, useRef } from 'react';
import Editor from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

interface MonacoDiffEditorProps {
  oldContent: string;
  newContent: string;
  language?: string;
  onAccept?: (finalContent: string) => void;
  onReject?: (originalContent: string) => void;
  readOnly?: boolean;
}

export function MonacoDiffEditor({
  oldContent,
  newContent,
  language = 'markdown',
  onAccept,
  onReject,
  readOnly = false,
}: MonacoDiffEditorProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleEditorMount = (
    editor: monaco.editor.IStandaloneCodeEditor
  ) => {
    editorRef.current = editor;
  };

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (editorRef.current) {
        editorRef.current.dispose();
      }
    };
  }, []);

  return (
    <div className="flex flex-col h-full bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700">Diff Comparison</span>
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded">
              Monaco Editor
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onAccept?.(newContent)}
            className="flex items-center gap-1 px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
            title="Accept all changes (Ctrl+Enter)"
          >
            Accept All
          </button>
          <button
            onClick={() => onReject?.(oldContent)}
            className="flex items-center gap-1 px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
            title="Reject all changes (Ctrl+Esc)"
          >
            Reject All
          </button>
        </div>
      </div>

      {/* Monaco Diff Editor */}
      <div className="flex-1" ref={containerRef}>
        <Editor
          height="100%"
          language={language}
          value={newContent}
          onMount={handleEditorMount}
          options={{
            readOnly,
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
          }}
          // Configure any Monaco settings before mount
          beforeMount={(monacoInstance) => {
            // Configure any Monaco settings before mount
            monacoInstance.editor.defineTheme('custom-theme', {
              base: 'vs',
              inherit: true,
              rules: [],
              colors: {
                'editor.background': '#ffffff',
              },
            });
          }}
        />
      </div>

      {/* Inline diff editor using Monaco's built-in diff */}
      <style>{`
        .monaco-diff-editor {
          height: 100% !important;
        }
      `}</style>
    </div>
  );
}

// Separate component for actual side-by-side diff view
export function MonacoSideBySideDiff({
  oldContent,
  newContent,
  language = 'markdown',
  onAccept,
  onReject,
}: MonacoDiffEditorProps) {
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create diff editor
    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      enableSplitViewResizing: false,
      renderSideBySide: true,
      readOnly: true,
      minimap: { enabled: false },
      fontSize: 13,
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      automaticLayout: true,
      originalEditable: false,
    });

    // Set the models
    const originalModel = monaco.editor.createModel(
      oldContent,
      language
    );
    const modifiedModel = monaco.editor.createModel(
      newContent,
      language
    );

    diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel,
    });

    diffEditorRef.current = diffEditor;

    // Clean up
    return () => {
      originalModel.dispose();
      modifiedModel.dispose();
      diffEditor.dispose();
    };
  }, [oldContent, newContent, language]);

  return (
    <div className="flex flex-col h-full bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-700">Diff Comparison</span>
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded">
              Removed
            </span>
            <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded">
              Added
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onAccept?.(newContent)}
            className="flex items-center gap-1 px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
            title="Accept all changes"
          >
            Accept All
          </button>
          <button
            onClick={() => onReject?.(oldContent)}
            className="flex items-center gap-1 px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
            title="Reject all changes"
          >
            Reject All
          </button>
        </div>
      </div>

      {/* Diff Editor Container */}
      <div ref={containerRef} className="flex-1" />
    </div>
  );
}

export default MonacoSideBySideDiff;
