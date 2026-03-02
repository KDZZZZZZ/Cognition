import React, { useMemo } from 'react';
import { diffArrays } from 'diff';
import { MarkdownContent } from '../ui/MarkdownContent';
import type { DiffLineDTO } from '../../types';

interface RenderedDiffViewerProps {
  oldContent: string;
  newContent: string;
  mode?: 'split' | 'inline';
  pendingLines?: DiffLineDTO[];
  selectedLineId?: string | null;
  onSelectLine?: (lineId: string) => void;
  onApplyLineDecision?: (lineId: string, decision: 'accepted' | 'rejected') => void;
}

function normalizeLineText(value?: string | null): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function matchesPendingLine(blockContent: string, line: DiffLineDTO, kind: 'added' | 'removed'): boolean {
  const normalizedBlock = normalizeLineText(blockContent);
  const candidate = normalizeLineText(kind === 'added' ? line.new_line : line.old_line);

  if (!normalizedBlock || !candidate) return false;
  return (
    normalizedBlock === candidate ||
    normalizedBlock.includes(candidate) ||
    candidate.includes(normalizedBlock)
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
  const diffs = useMemo(() => {
    const splitter = /\n{2,}/;
    const toBlocks = (content: string) =>
      content
        .split(splitter)
        .map((block) => block.replace(/^\n+|\n+$/g, ''))
        .filter((block) => block.trim().length > 0);
    const oldBlocks = toBlocks(oldContent);
    const newBlocks = toBlocks(newContent);
    return diffArrays(oldBlocks, newBlocks);
  }, [oldContent, newContent]);

  const splitRows = useMemo(() => {
    if (mode !== 'split') return [];

    const rows = [];
    let i = 0;
    while (i < diffs.length) {
      const part = diffs[i];
      if (!part.added && !part.removed) {
        rows.push({ left: part.value, right: part.value, type: 'equal' as const });
        i += 1;
      } else if (part.removed) {
        if (i + 1 < diffs.length && diffs[i + 1].added) {
          const removedIsEmpty = part.value.every((block) => block.trim().length === 0);
          const addedIsEmpty = diffs[i + 1].value.every((block) => block.trim().length === 0);
          if (removedIsEmpty && !addedIsEmpty) {
            rows.push({ left: [], right: diffs[i + 1].value, type: 'add' as const });
          } else if (!removedIsEmpty && addedIsEmpty) {
            rows.push({ left: part.value, right: [], type: 'delete' as const });
          } else {
            rows.push({ left: part.value, right: diffs[i + 1].value, type: 'modify' as const });
          }
          i += 2;
        } else {
          if (part.value.some((block) => block.trim().length > 0)) {
            rows.push({ left: part.value, right: [], type: 'delete' as const });
          }
          i += 1;
        }
      } else if (part.added) {
        if (part.value.some((block) => block.trim().length > 0)) {
          rows.push({ left: [], right: part.value, type: 'add' as const });
        }
        i += 1;
      }
    }
    return rows;
  }, [diffs, mode]);

  if (mode === 'split') {
    return (
      <div className="w-full h-full overflow-y-auto bg-theme-bg text-sm subtle-grid">
        <div className="sticky top-0 z-10 grid grid-cols-2 divide-x divide-theme-border/20">
          <div
            className="border-b border-theme-border/30 paper-divider-dashed p-2 text-center text-xs font-semibold tracking-[0.06em] text-theme-text/55 uppercase"
            style={{ backgroundColor: 'var(--theme-surface)' }}
          >
            Original
          </div>
          <div
            className="border-b border-theme-border/30 paper-divider-dashed p-2 text-center text-xs font-semibold tracking-[0.06em] text-theme-text/55 uppercase"
            style={{ backgroundColor: 'var(--theme-surface)' }}
          >
            Modified
          </div>
        </div>

        <div className="grid grid-cols-2 divide-x divide-theme-border/20">
          {splitRows.map((row, rowIndex) => (
            <React.Fragment key={rowIndex}>
              <div
                className={`p-4 max-h-[52vh] overflow-auto ${
                  row.type === 'delete' || row.type === 'modify'
                    ? 'bg-red-50'
                    : ''
                } ${row.type === 'delete' || row.type === 'modify' ? 'diff-deletion' : ''}`}
              >
                {row.left.length ? (
                  row.left.map((block, i) => (
                    <div key={i} className="mb-4 last:mb-0">
                      <MarkdownContent content={block} className={row.type === 'delete' ? 'opacity-70' : ''} />
                    </div>
                  ))
                ) : (
                  <div className="text-xs text-theme-text/35 italic">No content</div>
                )}
              </div>

              <div
                className={`p-4 max-h-[52vh] overflow-auto ${
                  row.type === 'add' || row.type === 'modify'
                    ? 'bg-green-50'
                    : ''
                } ${row.type === 'add' || row.type === 'modify' ? 'diff-addition' : ''}`}
              >
                {row.right.length ? (
                  row.right.map((block, i) => (
                    <div key={i} className="mb-4 last:mb-0">
                      <MarkdownContent content={block} />
                    </div>
                  ))
                ) : (
                  <div className="text-xs text-theme-text/35 italic">No content</div>
                )}
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-y-auto p-4 bg-theme-bg text-sm subtle-grid">
      <div className="max-w-4xl mx-auto space-y-4">
        {diffs.map((part, index) => {
          if (part.value.length === 0) return null;

          let bgClass = '';
          let borderClass = 'border-theme-border/20';
          let label: React.ReactNode = null;

          if (part.added) {
            bgClass = 'bg-green-50/70';
            borderClass = 'border-green-300/80';
            label = <div className="text-[10px] font-bold text-green-700 uppercase tracking-wider mb-1">Added</div>;
          } else if (part.removed) {
            bgClass = 'bg-red-50/70';
            borderClass = 'border-red-300/80';
            label = <div className="text-[10px] font-bold text-red-700 uppercase tracking-wider mb-1">Removed</div>;
          }

          return (
            <div key={index} className="flex flex-col gap-2">
              {part.value.map((blockContent, i) => {
                const blockPendingLines =
                  part.added || part.removed
                    ? pendingLines.filter((line) => line.decision === 'pending' && matchesPendingLine(blockContent, line, part.added ? 'added' : 'removed'))
                    : [];
                const isSelected = blockPendingLines.some((line) => line.id === selectedLineId);

                return (
                  <div
                    key={i}
                    className={`group relative p-4 rounded-lg border ${bgClass} ${borderClass} transition-colors ${
                      part.added ? 'diff-addition' : ''
                    } ${part.removed ? 'diff-deletion' : ''} ${isSelected ? 'ring-1 ring-inset ring-theme-border/35' : ''}`}
                    onMouseEnter={() => {
                      if (blockPendingLines[0]?.id) {
                        onSelectLine?.(blockPendingLines[0].id);
                      }
                    }}
                  >
                    {label}
                    <MarkdownContent
                      content={blockContent}
                      className={part.removed ? 'opacity-70 grayscale-[30%]' : ''}
                    />
                    {blockPendingLines.length > 0 && onApplyLineDecision && (
                      <div className="absolute right-2 top-2 z-10 flex flex-col gap-1">
                        {blockPendingLines.map((line) => (
                          <div
                            key={line.id}
                            className={`flex items-center gap-1 rounded-md border border-theme-border/18 bg-theme-bg/96 px-1.5 py-1 shadow-[0_6px_18px_rgba(16,16,16,0.08)] transition-opacity ${
                              line.id === selectedLineId
                                ? 'opacity-100'
                                : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100'
                            }`}
                            onMouseEnter={() => onSelectLine?.(line.id)}
                          >
                            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-theme-text/48">
                              L{line.line_no}
                            </span>
                            <button
                              type="button"
                              onMouseDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                              onClick={(event) => {
                                event.stopPropagation();
                                onApplyLineDecision(line.id, 'accepted');
                              }}
                              className="rounded bg-green-600 px-2 py-1 text-[10px] text-white hover:bg-green-700"
                              aria-label={`Accept line ${line.line_no}`}
                            >
                              Accept
                            </button>
                            <button
                              type="button"
                              onMouseDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                              onClick={(event) => {
                                event.stopPropagation();
                                onApplyLineDecision(line.id, 'rejected');
                              }}
                              className="rounded bg-red-600 px-2 py-1 text-[10px] text-white hover:bg-red-700"
                              aria-label={`Reject line ${line.line_no}`}
                            >
                              Reject
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
