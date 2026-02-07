import { useCallback } from 'react';
import { DiffEditor } from './DiffEditor';
import { TiptapMarkdownEditor } from './TiptapMarkdownEditor';
import { useVersionStore } from '../../stores/versionStore';

interface SmartEditorProps {
  fileId: string;
  content: string;
  onChange: (content: string) => void;
}

/**
 * SmartEditor: 智能编辑器组件
 *
 * 功能：
 * 1. 当没有 pending diff 时，显示普通的 TyporaBlockEditor
 * 2. 当 Agent 修改文档后，自动切换到 DiffEditor 显示差异
 * 3. 用户可以接受或拒绝 Agent 的修改
 */
export function SmartEditor({ fileId, content, onChange }: SmartEditorProps) {
  const {
    hasPendingDiff,
    getPendingDiff,
    acceptPendingDiff,
    rejectPendingDiff,
  } = useVersionStore();

  const pendingDiff = getPendingDiff(fileId);
  const showDiffView = hasPendingDiff(fileId) && pendingDiff;

  // Handle accepting all changes
  const handleAccept = useCallback(
    (finalContent: string) => {
      acceptPendingDiff(fileId);
      onChange(finalContent);
    },
    [fileId, acceptPendingDiff, onChange]
  );

  // Handle rejecting all changes
  const handleReject = useCallback(
    (originalContent: string) => {
      rejectPendingDiff(fileId);
      onChange(originalContent);
    },
    [fileId, rejectPendingDiff, onChange]
  );

  // Handle partial accept (user manually edited the diff)
  const handlePartialAccept = useCallback(
    (editedContent: string) => {
      onChange(editedContent);
    },
    [onChange]
  );

  // Show DiffEditor when there's a pending diff from Agent
  if (showDiffView) {
    return (
      <div className="h-full flex flex-col">
        {/* Diff header */}
        <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
          <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
          <span className="text-sm font-medium text-amber-800">
            AI 修改待确认
          </span>
          <span className="text-xs text-amber-600">
            {pendingDiff.summary}
          </span>
        </div>

        {/* DiffEditor */}
        <div className="flex-1 overflow-hidden">
          <DiffEditor
            oldContent={pendingDiff.oldContent}
            newContent={pendingDiff.newContent}
            onAccept={handleAccept}
            onReject={handleReject}
            onPartialAccept={handlePartialAccept}
            showToolbar={true}
          />
        </div>
      </div>
    );
  }

  // Show normal editor when no pending diff
  return (
    <TiptapMarkdownEditor
      content={content}
      onChange={onChange}
    />
  );
}

export default SmartEditor;
