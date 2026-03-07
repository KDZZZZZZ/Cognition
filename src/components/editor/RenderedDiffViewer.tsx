import { useMemo } from 'react';
import type { DiffLineDTO } from '../../types';
import { buildRowsFromContents, buildRowsFromPendingLines } from './diffRows';
import { normalizeCopiedSelectionMarkdown } from './markdownNormalization';
import { buildDiffBlocks } from './diffMarkdown/buildBlocks';
import { DiffBlockCard } from './diffMarkdown/renderBlocks';

interface RenderedDiffViewerProps {
  oldContent: string;
  newContent: string;
  mode?: 'split' | 'inline';
  pendingLines?: DiffLineDTO[];
  selectedLineId?: string | null;
  onSelectLine?: (lineId: string) => void;
  onApplyLineDecision?: (lineId: string | string[], decision: 'accepted' | 'rejected') => void | Promise<void>;
}

export function RenderedDiffViewer({
  oldContent,
  newContent,
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

  const blocks = useMemo(() => buildDiffBlocks(rows), [rows]);

  return (
    <div className="flex h-full w-full flex-col bg-theme-bg text-sm">
      <div className="min-h-0 flex-1 overflow-auto bg-theme-surface/16 px-2 py-1.5">
        <div className="flex w-full flex-col gap-2 pr-1">
          {blocks.length === 0 ? (
            <div className="rounded-xl border border-theme-border/14 bg-theme-surface/70 px-4 py-6 text-center text-theme-text/48">
              No line changes to review.
            </div>
          ) : (
            blocks.map((block) => (
              <DiffBlockCard
                key={block.id}
                block={block}
                selectedLineId={selectedLineId}
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
