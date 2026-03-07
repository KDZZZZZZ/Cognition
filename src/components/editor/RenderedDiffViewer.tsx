import { useMemo } from 'react';
import { diffArrays, diffChars } from 'diff';
import { Check, X } from 'lucide-react';
import { MarkdownContent } from '../ui/MarkdownContent';
import type { DiffLineDTO } from '../../types';
import { buildRowsFromContents, buildRowsFromPendingLines, type DiffRenderRow } from './diffRows';
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

function longestRun(value: string, marker: string) {
  let longest = 0;
  let current = 0;

  for (const char of value) {
    if (char === marker) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}

function wrapInsertedSegment(text: string) {
  if (!text) return '';

  const fence = '`'.repeat(Math.max(1, longestRun(text, '`') + 1));
  const needsPadding = text.startsWith('`') || text.endsWith('`');
  const inner = needsPadding ? ` ${text} ` : text;
  return `${fence}${inner}${fence}`;
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function canUseMarkdownStrikethrough(text: string) {
  return text.length > 0 && !/[\n<>`$]/.test(text);
}

function wrapRemovedSegment(text: string) {
  if (!text) return '';
  if (canUseMarkdownStrikethrough(text)) {
    return `~~${text.replace(/~/g, '\\~')}~~`;
  }
  return `<del>${escapeHtml(text)}</del>`;
}

const MATH_TOKEN_PATTERN = /\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\n]+?\$/g;

function tokenizeDiffMarkdown(text: string) {
  const tokens: string[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MATH_TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      tokens.push(text.slice(lastIndex, start));
    }
    tokens.push(match[0]);
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }

  return tokens.filter((token) => token.length > 0);
}

function isMathToken(token: string) {
  return /^(\$\$[\s\S]*\$\$|(?<!\$)\$[^$\n]+?\$)$/.test(token);
}

function mergeTextTokenDiff(oldToken: string, newToken: string) {
  return diffChars(oldToken, newToken)
    .map((part) => {
      if (part.added) return wrapInsertedSegment(part.value);
      if (part.removed) return wrapRemovedSegment(part.value);
      return part.value;
    })
    .join('');
}

function buildMergedMarkdown(oldText: string | null, newText: string | null) {
  if (oldText === null && newText === null) return '';
  if (oldText === null) return wrapInsertedSegment(newText || '');
  if (newText === null) return wrapRemovedSegment(oldText);

  const oldTokens = tokenizeDiffMarkdown(oldText);
  const newTokens = tokenizeDiffMarkdown(newText);
  const tokenParts = diffArrays(oldTokens, newTokens);
  let merged = '';

  for (let index = 0; index < tokenParts.length; index += 1) {
    const part = tokenParts[index];

    if (!part.added && !part.removed) {
      merged += part.value.join('');
      continue;
    }

    if (part.removed && index + 1 < tokenParts.length && tokenParts[index + 1].added) {
      const removedTokens = part.value;
      const addedTokens = tokenParts[index + 1].value;
      const shared = Math.min(removedTokens.length, addedTokens.length);

      for (let offset = 0; offset < shared; offset += 1) {
        const removedToken = removedTokens[offset];
        const addedToken = addedTokens[offset];

        if (!isMathToken(removedToken) && !isMathToken(addedToken)) {
          merged += mergeTextTokenDiff(removedToken, addedToken);
        } else {
          merged += wrapRemovedSegment(removedToken);
          merged += wrapInsertedSegment(addedToken);
        }
      }

      for (const removedToken of removedTokens.slice(shared)) {
        merged += wrapRemovedSegment(removedToken);
      }
      for (const addedToken of addedTokens.slice(shared)) {
        merged += wrapInsertedSegment(addedToken);
      }

      index += 1;
      continue;
    }

    if (part.removed) {
      merged += part.value.map((token) => wrapRemovedSegment(token)).join('');
      continue;
    }

    if (part.added) {
      merged += part.value.map((token) => wrapInsertedSegment(token)).join('');
    }
  }

  return merged;
}

function rowContentText(row: DiffRenderRow) {
  return row.newText ?? row.oldText ?? '';
}

function normalizeFormattingPlainText(text: string) {
  return text.replace(/(\*\*|__|~~)/g, '').replace(/(^|[\s(])([*_])(?=\S)|(?<=\S)([*_])(?=[\s).,!?:;]|$)/g, '$1').trim();
}

function isFormattingOnlyChange(oldText: string | null, newText: string | null) {
  if (!oldText || !newText || oldText === newText) return false;
  return normalizeFormattingPlainText(oldText) === normalizeFormattingPlainText(newText);
}

function markdownForRow(row: DiffRenderRow) {
  if (row.status === 'equal') return rowContentText(row);
  if (isFormattingOnlyChange(row.oldText, row.newText)) {
    return row.newText ?? row.oldText ?? '';
  }
  return buildMergedMarkdown(row.oldText, row.newText);
}

function isTableLine(text: string) {
  const trimmed = text.trim();
  return trimmed.startsWith('|') && trimmed.includes('|', 1);
}

function isTableDelimiterLine(text: string) {
  return /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)\|?\s*$/.test(text.trim());
}

function getTableBlockRange(rows: DiffRenderRow[], rowIndex: number) {
  const line = rowContentText(rows[rowIndex]);
  if (!isTableLine(line)) return null;

  let start = rowIndex;
  while (start > 0 && isTableLine(rowContentText(rows[start - 1]))) {
    start -= 1;
  }

  let end = rowIndex;
  while (end + 1 < rows.length && isTableLine(rowContentText(rows[end + 1]))) {
    end += 1;
  }

  const blockLines = rows.slice(start, end + 1).map(rowContentText);
  if (!blockLines.some(isTableDelimiterLine)) return null;
  return { start, end };
}

function parseFenceLine(text: string) {
  const match = text.match(/^\s*(`{3,}|~{3,})/);
  if (!match) return null;
  return { marker: match[1][0], length: match[1].length };
}

function getFenceBlockRange(rows: DiffRenderRow[], rowIndex: number) {
  let openFence: { index: number; marker: string; length: number } | null = null;

  for (let index = 0; index <= rowIndex; index += 1) {
    const fence = parseFenceLine(rowContentText(rows[index]));
    if (!fence) continue;

    if (openFence && openFence.marker === fence.marker && fence.length >= openFence.length) {
      openFence = null;
    } else if (!openFence) {
      openFence = { index, ...fence };
    }
  }

  if (!openFence) return null;

  for (let index = openFence.index + 1; index < rows.length; index += 1) {
    const fence = parseFenceLine(rowContentText(rows[index]));
    if (fence && fence.marker === openFence.marker && fence.length >= openFence.length) {
      if (rowIndex <= index) {
        return { start: openFence.index, end: index };
      }
      break;
    }
  }

  return null;
}

function buildReviewMarkdown(rows: DiffRenderRow[], rowIndex: number) {
  const tableRange = getTableBlockRange(rows, rowIndex);
  if (tableRange) {
    return rows
      .slice(tableRange.start, tableRange.end + 1)
      .map((row, index) => (tableRange.start + index === rowIndex ? markdownForRow(row) : rowContentText(row)))
      .join('\n');
  }

  const fenceRange = getFenceBlockRange(rows, rowIndex);
  if (fenceRange) {
    return rows
      .slice(fenceRange.start, fenceRange.end + 1)
      .map((row) => rowContentText(row))
      .join('\n');
  }

  return markdownForRow(rows[rowIndex]);
}

function rowTone(row: DiffRenderRow) {
  if (row.decision === 'accepted') return 'bg-emerald-500/65';
  if (row.decision === 'rejected') return 'bg-rose-500/65';
  if (row.status === 'add') return 'bg-emerald-500/55';
  if (row.status === 'remove') return 'bg-rose-500/55';
  if (row.status === 'modify') return 'bg-amber-500/60';
  return 'bg-theme-text/14';
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
  rows,
  rowIndex,
  row,
  selected,
  actionable,
  onSelectLine,
  onApplyLineDecision,
}: {
  rows: DiffRenderRow[];
  rowIndex: number;
  row: DiffRenderRow;
  selected: boolean;
  actionable: boolean;
  onSelectLine?: (lineId: string) => void;
  onApplyLineDecision?: (lineId: string, decision: 'accepted' | 'rejected') => void;
}) {
  const mergedMarkdown = useMemo(() => buildReviewMarkdown(rows, rowIndex), [rowIndex, rows]);
  const lineNumber = row.newLineNumber ?? row.oldLineNumber ?? row.reviewLineNumber;

  return (
    <div
      className={`group grid grid-cols-[18px_minmax(0,1fr)] items-start gap-2 rounded-lg border px-1.5 py-1 transition-colors ${
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

      <div className="min-w-0 rounded-md border border-theme-border/10 bg-theme-bg/78 px-2.5 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2">
          <span className="select-none pt-0.5 text-[10px] leading-5 text-theme-text/26">{lineNumber}</span>
          <div data-testid="diff-merged-markdown" className="min-w-0">
            {mergedMarkdown ? (
              <MarkdownContent
                content={mergedMarkdown}
                variant="diff"
                className="prose-xs leading-6 [&_.katex-display]:my-0.5 [&_blockquote]:my-0 [&_code]:whitespace-break-spaces [&_h1]:my-0 [&_h2]:my-0 [&_h3]:my-0 [&_li]:my-0.5 [&_ol]:my-0 [&_p]:my-0 [&_pre]:my-0 [&_ul]:my-0"
              />
            ) : (
              <span className="block h-5 rounded-sm bg-theme-text/5" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
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

  const changedRows = useMemo(() => rows.filter((row) => row.status !== 'equal'), [rows]);

  return (
    <div className="flex h-full w-full flex-col bg-theme-bg text-sm">
      <div className="min-h-0 flex-1 overflow-auto bg-theme-surface/16 px-2 py-1.5">
        <div className="flex w-full flex-col gap-1.5 pr-1">
          {changedRows.length === 0 ? (
            <div className="rounded-xl border border-theme-border/14 bg-theme-surface/70 px-4 py-6 text-center text-theme-text/48">
              No line changes to review.
            </div>
          ) : (
            changedRows.map((row) => (
              <ReviewRow
                key={row.id}
                rows={rows}
                rowIndex={rows.findIndex((candidate) => candidate.id === row.id)}
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
