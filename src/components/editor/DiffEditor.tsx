import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useCallback, useEffect, useMemo } from 'react';
import { Check, X, RotateCcw } from 'lucide-react';
import { AdditionMark, DeletionMark } from './extensions';
import {
  computeFullDiff,
  applyAcceptedChanges,
  applyRejectedChanges,
} from '../../utils/diffUtils';

interface DiffEditorProps {
  oldContent: string;
  newContent: string;
  onAccept?: (finalContent: string) => void;
  onReject?: (originalContent: string) => void;
  onPartialAccept?: (content: string) => void;
  readOnly?: boolean;
  showToolbar?: boolean;
}

export function DiffEditor({
  oldContent,
  newContent,
  onAccept,
  onReject,
  onPartialAccept,
  readOnly = false,
  showToolbar = true,
}: DiffEditorProps) {
  // Compute diff and generate TipTap content
  const diffResult = useMemo(() => {
    return computeFullDiff(oldContent, newContent);
  }, [oldContent, newContent]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      AdditionMark,
      DeletionMark,
    ],
    content: diffResult.tiptapContent,
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none min-h-[200px] p-4',
      },
    },
  });

  // Update editor content when diff changes
  useEffect(() => {
    if (editor && diffResult.tiptapContent) {
      editor.commands.setContent(diffResult.tiptapContent);
    }
  }, [editor, diffResult.tiptapContent]);

  // Accept all changes
  const handleAcceptAll = useCallback(() => {
    if (!editor) return;

    const content = editor.getJSON();
    const acceptedContent = applyAcceptedChanges(content);
    editor.commands.setContent(acceptedContent);

    const text = editor.getText();
    onAccept?.(text);
  }, [editor, onAccept]);

  // Reject all changes
  const handleRejectAll = useCallback(() => {
    if (!editor) return;

    const content = editor.getJSON();
    const rejectedContent = applyRejectedChanges(content);
    editor.commands.setContent(rejectedContent);

    onReject?.(oldContent);
  }, [editor, onReject, oldContent]);

  // Reset to original diff view
  const handleReset = useCallback(() => {
    if (!editor) return;
    editor.commands.setContent(diffResult.tiptapContent);
  }, [editor, diffResult.tiptapContent]);

  // Accept single change at cursor
  const handleAcceptAtCursor = useCallback(() => {
    if (!editor) return;

    const { from, to } = editor.state.selection;

    // Check if selection has addition or deletion marks
    editor.state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isText) {
        const marks = node.marks;
        const hasDeletion = marks.some((m) => m.type.name === 'deletion');
        const hasAddition = marks.some((m) => m.type.name === 'addition');

        if (hasDeletion) {
          // Delete the text (accept the deletion)
          editor.chain().focus().setTextSelection({ from: pos, to: pos + node.nodeSize }).deleteSelection().run();
        } else if (hasAddition) {
          // Remove the mark (accept the addition)
          editor.chain().focus().setTextSelection({ from: pos, to: pos + node.nodeSize }).unsetAddition().run();
        }
      }
    });

    onPartialAccept?.(editor.getText());
  }, [editor, onPartialAccept]);

  // Reject single change at cursor
  const handleRejectAtCursor = useCallback(() => {
    if (!editor) return;

    const { from, to } = editor.state.selection;

    editor.state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.isText) {
        const marks = node.marks;
        const hasDeletion = marks.some((m) => m.type.name === 'deletion');
        const hasAddition = marks.some((m) => m.type.name === 'addition');

        if (hasAddition) {
          // Delete the text (reject the addition)
          editor.chain().focus().setTextSelection({ from: pos, to: pos + node.nodeSize }).deleteSelection().run();
        } else if (hasDeletion) {
          // Remove the mark (reject the deletion, keep the text)
          editor.chain().focus().setTextSelection({ from: pos, to: pos + node.nodeSize }).unsetDeletion().run();
        }
      }
    });

    onPartialAccept?.(editor.getText());
  }, [editor, onPartialAccept]);

  // Count changes
  const changeStats = useMemo(() => {
    let additions = 0;
    let deletions = 0;

    for (const [op, text] of diffResult.diffs) {
      if (op === 1) additions += text.length;
      if (op === -1) deletions += text.length;
    }

    return { additions, deletions };
  }, [diffResult.diffs]);

  if (!editor) {
    return <div className="p-4 text-gray-500">Loading editor...</div>;
  }

  return (
    <div className="flex flex-col h-full bg-white rounded-lg border border-gray-200 overflow-hidden">
      {/* Toolbar */}
      {showToolbar && (
        <div className="flex items-center justify-between px-4 py-2 bg-gray-50 border-b border-gray-200">
          <div className="flex items-center gap-4">
            <span className="text-sm font-medium text-gray-700">Changes</span>
            <div className="flex items-center gap-2 text-xs">
              <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded">
                +{changeStats.additions} chars
              </span>
              <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded">
                -{changeStats.deletions} chars
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleAcceptAtCursor}
              className="flex items-center gap-1 px-2 py-1 text-xs text-green-700 hover:bg-green-50 rounded transition-colors"
              title="Accept change at cursor"
            >
              <Check size={14} />
              Accept
            </button>
            <button
              onClick={handleRejectAtCursor}
              className="flex items-center gap-1 px-2 py-1 text-xs text-red-700 hover:bg-red-50 rounded transition-colors"
              title="Reject change at cursor"
            >
              <X size={14} />
              Reject
            </button>
            <div className="w-px h-4 bg-gray-300" />
            <button
              onClick={handleAcceptAll}
              className="flex items-center gap-1 px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
              title="Accept all changes"
            >
              <Check size={14} />
              Accept All
            </button>
            <button
              onClick={handleRejectAll}
              className="flex items-center gap-1 px-3 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 transition-colors"
              title="Reject all changes"
            >
              <X size={14} />
              Reject All
            </button>
            <button
              onClick={handleReset}
              className="flex items-center gap-1 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 rounded transition-colors"
              title="Reset to original diff"
            >
              <RotateCcw size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Editor Content */}
      <div className="flex-1 overflow-auto">
        <EditorContent editor={editor} className="h-full" />
      </div>

      {/* Diff Styles */}
      <style>{`
        .diff-addition {
          background-color: #dcfce7;
          color: #166534;
          text-decoration: none;
          padding: 1px 2px;
          border-radius: 2px;
        }

        .diff-deletion {
          background-color: #fee2e2;
          color: #991b1b;
          text-decoration: line-through;
          padding: 1px 2px;
          border-radius: 2px;
        }

        .ProseMirror {
          min-height: 200px;
          padding: 1rem;
        }

        .ProseMirror:focus {
          outline: none;
        }

        .ProseMirror p {
          margin: 0.5em 0;
        }
      `}</style>
    </div>
  );
}

export default DiffEditor;
