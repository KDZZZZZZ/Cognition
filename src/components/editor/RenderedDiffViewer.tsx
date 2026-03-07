import { useMemo } from 'react';
import { Check, X } from 'lucide-react';
import { MarkdownContent } from '../ui/MarkdownContent';
import type { DiffLineDTO } from '../../types';
import { buildRowsFromContents, buildRowsFromPendingLines, type DiffCharSegment, type DiffRenderRow } from './diffRows';
import { normalizeCopiedSelectionMarkdown } from './markdownNormalization';

interface RenderedDiffViewerProps {
  oldContent: string;
  newContent: string;
  mode?: 'split' | 'inline';
  pendingLines?: DiffLineDTO[];
  selectedLineId?: string | null;
  onSelectLine?: (lineId: string) => void;
  onApplyLineDecision?: (lineId: string, decision: 'accepted' | 'rejected') => void;
}

function collectChangedPreviewContent(rows: DiffRenderRow[], side: 'old' | 'new') {
  const lines = rows
    .map((row) => (side === 'old' ? row.oldText : row.newText))
    .filter((line): line is string => Boolean(line && line.trim().length > 0));

  return lines.join('\n');
}

function renderLinePlaceholder(status: 'old' | 'new') {
  return (
    <span className={`select-none ${status === 'old' ? 'text-rose-700/28' : 'text-emerald-700/30'}`}>·</span>
  );
}

function renderSegments(segments: DiffCharSegment[], status: 'old' | 'new') {
  if (segments.length === 0) {
    return renderLinePlaceholder(status);
  }

  const hasVisibleText = segments.some((segment) => segment.text.length > 0);
  if (!hasVisibleText) {
    return <span className="text-theme-text/35"> </span>;
  }

  return segments.map((segment, index) => {
    const toneClass = segment.added
      ? 'text-theme-text'
      : segment.removed
        ? 'text-theme-text line-through decoration-rose-700/75'
        : 'text-theme-text/72';
    const toneStyle = segment.added
      ? { backgroundColor: 'rgba(16, 185, 129, 0.28)' }
      : segment.removed
        ? { backgroundColor: 'rgba(244, 63, 94, 0.24)' }
        : undefined;

    return (
      <span
        key={`${status}-${index}-${segment.text}`}
        className={`rounded-[2px] px-[1px] ${toneClass}`}
        style={toneStyle}
      >
        {segment.text}
      </span>
    );
  });
}

function rowTone(row: DiffRenderRow) {
  if (row.decision === 'accepted') return 'bg-emerald-500/65';
  if (row.decision === 'rejected') return 'bg-rose-500/65';
  if (row.status === 'add') return 'bg-emerald-500/55';
  if (row.status === 'remove') return 'bg-rose-500/55';
  if (row.status === 'modify') return 'bg-amber-500/60';
  return 'bg-theme-text/14';
}

function RowCell({
  lineNumber,
  segments,
  status,
}: {
  lineNumber: number | null;
  segments: DiffCharSegment[];
  status: 'old' | 'new';
}) {
  return (
    <pre className="m-0 grid min-w-0 grid-cols-[1.35rem_minmax(0,1fr)] items-start gap-1.5 overflow-x-auto overflow-y-hidden whitespace-pre font-mono text-[9px] leading-3 text-theme-text/58">
      <span className="select-none text-[8px] text-theme-text/22">
        {lineNumber === null ? '' : lineNumber}
      </span>
      <span className="min-w-0 pb-px">{renderSegments(segments, status)}</span>
    </pre>
  );
}

function RowMarkdownPreview({
  text,
}: {
  text: string | null;
}) {
  if (!text || !text.trim()) return null;

  return (
    <div className="min-w-0 px-0.5 py-0.5">
      <MarkdownContent
        content={text}
        className="prose-xs leading-5 [&_.katex-display]:my-0.5 [&_blockquote]:my-0 [&_h1]:my-0 [&_h2]:my-0 [&_h3]:my-0 [&_li]:my-0.5 [&_ol]:my-0 [&_p]:my-0 [&_pre]:my-0 [&_ul]:my-0"
      />
    </div>
  );
}

function PreviewCard({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className="block w-full rounded-lg border border-theme-border/12 bg-theme-bg/82 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
      <MarkdownContent
        content={content}
        className={className}
      />
    </div>
  );
}

function ActionRail({
  row,
  actionable,
  onApplyLineDecision,
}: {
  row: DiffRenderRow;
  actionable: boolean;
  onApplyLineDecision?: (lineId: string, decision: 'accepted' | 'rejected') => void;
}) {
  if (actionable && row.id && onApplyLineDecision) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-1">
        <button
          type="button"
          onClick={() => onApplyLineDecision(row.id, 'accepted')}
          className={`flex h-4 w-4 items-center justify-center rounded-full transition-colors ${
            row.decision === 'accepted'
              ? 'bg-emerald-700 text-white'
              : 'bg-emerald-500/10 text-emerald-800 hover:bg-emerald-500/16'
          }`}
          aria-label={`Accept line ${row.reviewLineNumber}`}
        >
          <Check size={10} />
        </button>
        <button
          type="button"
          onClick={() => onApplyLineDecision(row.id, 'rejected')}
          className={`flex h-4 w-4 items-center justify-center rounded-full transition-colors ${
            row.decision === 'rejected'
              ? 'bg-rose-700 text-white'
              : 'bg-rose-500/10 text-rose-800 hover:bg-rose-500/16'
          }`}
          aria-label={`Reject line ${row.reviewLineNumber}`}
        >
          <X size={10} />
        </button>
      </div>
    );
  }

  return <span className={`mt-0.5 h-4 w-[2px] rounded-full ${rowTone(row)}`} aria-hidden="true" />;
}

function ReviewRow({
  row,
  selected,
  actionable,
  onSelectLine,
  onApplyLineDecision,
}: {
  row: DiffRenderRow;
  selected: boolean;
  actionable: boolean;
  onSelectLine?: (lineId: string) => void;
  onApplyLineDecision?: (lineId: string, decision: 'accepted' | 'rejected') => void;
}) {
  const showMarkdownPreview = Boolean((row.oldText && row.oldText.trim()) || (row.newText && row.newText.trim()));

  return (
    <div
      className={`group grid grid-cols-[18px_minmax(0,1fr)_minmax(0,1fr)] items-start gap-2 rounded-lg border px-1.5 py-1 transition-colors ${
        selected
          ? 'border-theme-border/26 bg-theme-text/[0.045]'
          : 'border-theme-border/10 bg-theme-surface/28'
      }`}
      onMouseEnter={() => {
        if (row.id && actionable) onSelectLine?.(row.id);
      }}
    >
      <div className="flex items-start justify-center pt-0.5">
        <ActionRail row={row} actionable={actionable} onApplyLineDecision={onApplyLineDecision} />
      </div>

      <div className="min-w-0 rounded-md border border-theme-border/10 bg-theme-bg/78 px-2 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        {showMarkdownPreview ? <RowMarkdownPreview text={row.oldText} /> : null}
        <div className={showMarkdownPreview ? 'mt-1 border-t border-theme-border/8 pt-1 opacity-60 transition-opacity group-hover:opacity-90' : ''}>
          <RowCell lineNumber={row.oldLineNumber} segments={row.oldSegments} status="old" />
        </div>
      </div>
      <div className="min-w-0 rounded-md border border-theme-border/10 bg-theme-bg/78 px-2 py-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        {showMarkdownPreview ? <RowMarkdownPreview text={row.newText} /> : null}
        <div className={showMarkdownPreview ? 'mt-1 border-t border-theme-border/8 pt-1 opacity-60 transition-opacity group-hover:opacity-90' : ''}>
          <RowCell lineNumber={row.newLineNumber} segments={row.newSegments} status="new" />
        </div>
      </div>
    </div>
  );
}

export function RenderedDiffViewer({
  oldContent,
  newContent,
  mode = 'inline',
  pendingLines = [],
  selectedLineId = null,
  onSelectLine,
  onApplyLineDecision,
}: RenderedDiffViewerProps) {
  const normalizedOldContent = useMemo(() => normalizeCopiedSelectionMarkdown(oldContent), [oldContent]);
  const normalizedNewContent = useMemo(() => normalizeCopiedSelectionMarkdown(newContent), [newContent]);
  const normalizedPendingLines = useMemo(
    () =>
      pendingLines.map((line) => ({
        ...line,
        old_line: line.old_line === null ? null : normalizeCopiedSelectionMarkdown(line.old_line),
        new_line: line.new_line === null ? null : normalizeCopiedSelectionMarkdown(line.new_line),
      })),
    [pendingLines]
  );

  const rows = useMemo(
    () =>
      normalizedPendingLines.length > 0
        ? buildRowsFromPendingLines(normalizedPendingLines)
        : buildRowsFromContents(normalizedOldContent, normalizedNewContent),
    [normalizedNewContent, normalizedOldContent, normalizedPendingLines]
  );

  const changedRows = useMemo(() => rows.filter((row) => row.status !== 'equal'), [rows]);
  const changedOldPreviewContent = useMemo(() => collectChangedPreviewContent(changedRows, 'old'), [changedRows]);
  const changedNewPreviewContent = useMemo(() => collectChangedPreviewContent(changedRows, 'new'), [changedRows]);
  const oldPreviewContent = useMemo(
    () => changedOldPreviewContent || normalizedOldContent,
    [changedOldPreviewContent, normalizedOldContent]
  );
  const newPreviewContent = useMemo(
    () => changedNewPreviewContent || normalizedNewContent,
    [changedNewPreviewContent, normalizedNewContent]
  );
  const compactLayout = changedRows.length <= 2 && Math.max(oldPreviewContent.length, newPreviewContent.length) <= 240;
  const showDocumentPreview = !compactLayout;

  return (
    <div className={`flex w-full flex-col bg-theme-bg text-sm ${compactLayout ? 'overflow-auto' : 'h-full overflow-hidden'}`}>
      {showDocumentPreview ? (
        <div
          className={`border-b border-theme-border/18 min-h-0 flex-[0_0_46%] overflow-hidden ${
            mode === 'split' ? 'grid grid-cols-2 divide-x divide-theme-border/16' : ''
          }`}
        >
          {mode === 'split' ? (
            <>
              <div className="min-h-0 overflow-auto bg-theme-surface/45 px-3 py-2">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-theme-text/46">
                  Rendered Original
                </div>
                <PreviewCard
                  content={oldPreviewContent}
                  className="[&_blockquote]:my-1 [&_h1]:my-1 [&_h2]:my-1 [&_h3]:my-1 [&_ol]:my-1 [&_p]:my-1 [&_pre]:my-1 [&_ul]:my-1"
                />
              </div>
              <div className="min-h-0 overflow-auto bg-theme-surface/45 px-3 py-2">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-theme-text/46">
                  Rendered Modified
                </div>
                <PreviewCard
                  content={newPreviewContent}
                  className="[&_blockquote]:my-1 [&_h1]:my-1 [&_h2]:my-1 [&_h3]:my-1 [&_ol]:my-1 [&_p]:my-1 [&_pre]:my-1 [&_ul]:my-1"
                />
              </div>
            </>
          ) : (
            <div className="min-h-0 overflow-auto bg-theme-surface/45 px-3 py-2">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-theme-text/46">
                Rendered Proposal
              </div>
              <PreviewCard
                content={newPreviewContent}
                className="[&_blockquote]:my-1 [&_h1]:my-1 [&_h2]:my-1 [&_h3]:my-1 [&_ol]:my-1 [&_p]:my-1 [&_pre]:my-1 [&_ul]:my-1"
              />
            </div>
          )}
        </div>
      ) : null}

      <div
        className={`bg-theme-surface/16 px-2 py-1.5 ${
          compactLayout ? 'shrink-0' : 'min-h-0 flex-1 overflow-hidden'
        }`}
      >
        <div className={`flex w-full flex-col ${compactLayout ? 'gap-2' : 'h-full gap-1.5 overflow-auto pr-1'}`}>
          {changedRows.length === 0 ? (
            <div className="rounded-xl border border-theme-border/14 bg-theme-surface/70 px-4 py-6 text-center text-theme-text/48">
              No line changes to review.
            </div>
          ) : (
            changedRows.map((row) => (
              <ReviewRow
                key={row.id}
                row={row}
                selected={Boolean(selectedLineId) && row.id === selectedLineId}
                actionable={Boolean(onApplyLineDecision && row.decision !== null)}
                onSelectLine={onSelectLine}
                onApplyLineDecision={onApplyLineDecision}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
