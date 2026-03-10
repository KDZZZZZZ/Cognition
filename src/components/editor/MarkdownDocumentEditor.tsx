import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { diffChars } from 'diff';
import type { DiffEventDTO } from '../../types';
import { MarkdownContent } from '../ui/MarkdownContent';
import { MermaidDiagram } from '../ui/MermaidDiagram';
import { diffInlineDeleteClassName, diffInlineInsertClassName } from '../ui/markdownShared';
import { CodeMirrorBlockEditor } from './CodeMirrorBlockEditor';
import { RawMarkdownEditor } from './RawMarkdownEditor';
import { TiptapMarkdownEditor } from './TiptapMarkdownEditor';
import { buildRowsFromContents } from './diffRows';
import { buildDiffBlocks } from './diffMarkdown/buildBlocks';
import { DiffBlockCard } from './diffMarkdown/renderBlocks';
import {
  type EmptyParagraphLineUnit,
  type MarkdownEditBlock,
  type MarkdownDiffUnit,
  type MarkdownVisualUnit,
  buildMarkdownVisualUnits,
  buildMarkdownDiffUnits,
  insertEmptyParagraphAfterBlock,
  insertEmptyParagraphAtEnd,
  insertEmptyParagraphBeforeBlock,
  materializeEmptyParagraphLine,
  removeMarkdownBlock,
  removeEmptyParagraphLine,
  parseMarkdownDocument,
  replaceMarkdownBlock,
} from './markdownDocument';
import { renderMathMarkdown, stripMathDelimiters } from './markdownNormalization';

function calloutTone(kind: string) {
  if (kind === 'warning' || kind === 'caution') return 'border-amber-500/30 bg-amber-500/10 text-amber-900';
  if (kind === 'danger' || kind === 'error') return 'border-rose-500/30 bg-rose-500/10 text-rose-900';
  if (kind === 'tip' || kind === 'success') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900';
  return 'border-sky-500/30 bg-sky-500/8 text-theme-text';
}

interface MarkdownDocumentEditorProps {
  fileId: string;
  fileName: string;
  content: string;
  baseContent: string;
  pendingDiffEvent?: DiffEventDTO | null;
  pendingDiffLoading?: boolean;
  onChange: (markdown: string) => void;
  onViewportChange?: (payload: {
    scrollTop: number;
    scrollHeight: number;
    visibleUnit: 'line';
    visibleStart: number;
    visibleEnd: number;
  }) => void;
  availableSessions?: { id: string; name: string }[];
  defaultSessionId?: string;
  sourceFile?: { id: string; name: string };
  onAddReferenceToSession?: (
    sessionId: string,
    reference: {
      sourceFileId: string;
      sourceFileName: string;
      markdown: string;
      plainText: string;
    }
  ) => void;
  onRunSelectionAction?: (params: {
    action: 'fix' | 'check';
    targetSessionId: string;
    markdown: string;
    plainText: string;
    sourceFileId: string;
    sourceFileName: string;
  }) => Promise<void> | void;
}

function InterBlockInsertHandle({
  onInsert,
}: {
  onInsert: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="Insert paragraph"
      onDoubleClick={(event) => {
        event.preventDefault();
        onInsert();
      }}
      className="group relative -my-1 block h-3 w-full cursor-text border-0 bg-transparent p-0 outline-none"
    >
      <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-transparent transition-colors group-hover:bg-theme-border/16" />
    </button>
  );
}

function normalizeTableRow(line: string) {
  const raw = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return raw.split('|').map((cell) => cell.trim());
}

type VisualListItem = {
  indent: number;
  ordered: boolean;
  marker: '-' | '*' | '+' | '.' | ')';
  checked: boolean | null;
  text: string;
};

function parseFrontmatter(markdown: string) {
  const match = markdown.match(/^(---|\+\+\+)\s*\n([\s\S]*?)\n\1\s*$/);
  if (!match) return null;
  return {
    delimiter: match[1],
    entries: match[2]
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const separator = line.indexOf(':');
        return {
          key: line.slice(0, separator).trim(),
          value: line.slice(separator + 1).trim(),
        };
      }),
  };
}

function serializeFrontmatter(delimiter: string, entries: Array<{ key: string; value: string }>) {
  return `${delimiter}\n${entries.map((entry) => `${entry.key}: ${entry.value}`).join('\n')}\n${delimiter}`;
}

function parseCallout(markdown: string) {
  const lines = markdown.split('\n');
  const first = lines[0]?.match(/^\s*>\s*\[!(\w+)\](?:\s+(.*))?\s*$/);
  if (!first) return null;
  const body = lines
    .slice(1)
    .map((line) => {
      const match = line.match(/^\s*>\s?(.*)$/);
      return match ? match[1] : line;
    })
    .join('\n')
    .trim();
  return {
    kind: first[1].toLowerCase(),
    title: first[2]?.trim() || '',
    body,
  };
}

function serializeCallout(kind: string, title: string, body: string) {
  const header = `> [!${kind.toUpperCase()}]${title.trim() ? ` ${title.trim()}` : ''}`;
  const bodyLines = body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
    .trim();
  return bodyLines ? `${header}\n${bodyLines}` : header;
}

function parseCodeFence(markdown: string) {
  const match = markdown.match(/^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1\s*$/);
  if (!match) return null;
  return {
    fence: match[1],
    language: match[2].trim(),
    code: match[3],
  };
}

function serializeCodeFence(fence: string, language: string, code: string) {
  return `${fence}${language.trim() ? language.trim() : ''}\n${code}\n${fence}`;
}

function canParseTable(markdown: string) {
  const lines = markdown.split('\n').filter((line) => line.trim().length > 0);
  return lines.length >= 2 && /\|/.test(lines[0]) && /^[:|\-\s]+$/.test(lines[1].replace(/[A-Za-z0-9]/g, ''));
}

function parseTable(markdown: string) {
  const lines = markdown.split('\n').filter((line) => line.trim().length > 0);
  if (!canParseTable(markdown) || lines.length < 2) return null;
  return {
    header: normalizeTableRow(lines[0]),
    alignment: normalizeTableRow(lines[1]).map((cell) => {
      const value = cell.trim();
      const left = value.startsWith(':');
      const right = value.endsWith(':');
      if (left && right) return 'center' as const;
      if (left) return 'left' as const;
      if (right) return 'right' as const;
      return 'none' as const;
    }),
    rows: lines.slice(2).map(normalizeTableRow),
  };
}

function serializeTable(
  header: string[],
  rows: string[][],
  alignment: Array<'left' | 'center' | 'right' | 'none'> = header.map(() => 'none')
) {
  const normalizedAlignment = header.map((_, index) => alignment[index] || 'none');
  const headerRow = `| ${header.join(' | ')} |`;
  const separator = `| ${normalizedAlignment
    .map((item) => {
      if (item === 'left') return ':---';
      if (item === 'center') return ':---:';
      if (item === 'right') return '---:';
      return '---';
    })
    .join(' | ')} |`;
  const bodyRows = rows.map((row) => `| ${row.join(' | ')} |`);
  return [headerRow, separator, ...bodyRows].join('\n');
}

function normalizeIndentWidth(indent: string) {
  return indent.replace(/\t/g, '  ').length;
}

function indentSpaces(count: number) {
  return ' '.repeat(Math.max(0, count));
}

function isKeyboardEventComposing(event: React.KeyboardEvent<HTMLElement>) {
  const nativeEvent = event.nativeEvent as KeyboardEvent & { keyCode?: number };
  return Boolean(nativeEvent.isComposing || nativeEvent.keyCode === 229);
}

function canParseList(markdown: string) {
  const lines = markdown.split('\n').filter((line) => line.trim().length > 0);
  return lines.length > 0 && lines.every((line) => /^(\s*)([-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/.test(line));
}

function parseList(markdown: string) {
  return markdown
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = line.match(/^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/);
      if (!match) return null;
      const token = match[2];
      return {
        indent: normalizeIndentWidth(match[1] || ''),
        ordered: /^\d/.test(token),
        marker: /^\d/.test(token) ? (token.endsWith(')') ? ')' : '.') : (token as '-' | '*' | '+'),
        checked: typeof match[3] === 'string' ? match[3].toLowerCase() === 'x' : null,
        text: match[4],
      };
    });
}

function serializeList(items: VisualListItem[]) {
  const counters = new Map<number, number>();
  return items
    .map((item) => {
      const checkbox = item.checked === null ? '' : ` [${item.checked ? 'x' : ' '}]`;
      if (item.ordered) {
        const nextCount = (counters.get(item.indent) || 0) + 1;
        counters.set(item.indent, nextCount);
        const orderedDelimiter = item.marker === ')' ? ')' : '.';
        return `${indentSpaces(item.indent)}${nextCount}${orderedDelimiter}${checkbox} ${item.text}`;
      }
      const bulletMarker = item.marker === '-' || item.marker === '*' || item.marker === '+' ? item.marker : '-';
      return `${indentSpaces(item.indent)}${bulletMarker}${checkbox} ${item.text}`;
    })
    .join('\n');
}

function nextAlignmentValue(value: 'left' | 'center' | 'right' | 'none') {
  if (value === 'none') return 'left' as const;
  if (value === 'left') return 'center' as const;
  if (value === 'center') return 'right' as const;
  return 'none' as const;
}

function listMarkerLabel(items: Array<{ indent: number; ordered: boolean }>, targetIndex: number) {
  if (!items[targetIndex]?.ordered) return '•';
  let count = 0;
  for (let index = 0; index <= targetIndex; index += 1) {
    if (items[index]?.ordered && items[index]?.indent === items[targetIndex].indent) {
      count += 1;
    }
  }
  return `${count}.`;
}

function isPersistableEmptyBlockMarkdown(kind: string, markdown: string) {
  const normalized = markdown.replace(/\r/g, '');
  if (kind === 'paragraph') return normalized.trim().length === 0;
  if (kind === 'heading') return normalized.replace(/^#{1,6}\s*/, '').trim().length === 0;
  if (kind === 'blockquote') {
    return normalized
      .split('\n')
      .map((line) => line.replace(/^\s*>\s?/, '').trim())
      .join('')
      .length === 0;
  }
  return false;
}

type BlockFocusDirection = 'up' | 'down';
type BlockActivationEdge = 'start' | 'end';
type BlockActivationPoint = {
  x: number;
  y: number;
};
type BlockActivationRequest = {
  edge?: BlockActivationEdge | null;
  row?: number | null;
  col?: number | null;
  point?: BlockActivationPoint | null;
  textOffset?: number | null;
};

const BLOCK_NAV_TARGET_SELECTOR = '[data-block-nav-target="true"]';
const BLOCK_TEXT_EDITABLE_SELECTOR =
  'textarea, [contenteditable="true"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"])';

function resolveArrowDirection(key: string): BlockFocusDirection | null {
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  return null;
}

function isTextareaBoundary(target: HTMLElement, direction: BlockFocusDirection) {
  if (!(target instanceof HTMLTextAreaElement)) return false;
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  if (start !== end) return false;
  return direction === 'up' ? start === 0 : end === target.value.length;
}

function isSingleLineTextInput(target: HTMLElement) {
  if (!(target instanceof HTMLInputElement)) return false;
  const type = target.type.toLowerCase();
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'date', 'month', 'week', 'time'].includes(type);
}

function focusCaretTarget(target: HTMLElement | null, edge: BlockActivationEdge) {
  if (!target) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const position = edge === 'start' ? 0 : target.value.length;
    target.focus();
    if (typeof target.setSelectionRange === 'function') {
      target.setSelectionRange(position, position);
    }
    return true;
  }

  const contenteditable = target.closest('[contenteditable="true"]') as HTMLElement | null;
  if (contenteditable) {
    contenteditable.focus();
    const selection = contenteditable.ownerDocument.defaultView?.getSelection();
    if (!selection) return true;
    const range = contenteditable.ownerDocument.createRange();
    range.selectNodeContents(contenteditable);
    range.collapse(edge === 'start');
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  target.focus();
  return true;
}

function createCaretRangeFromPoint(doc: Document, point: BlockActivationPoint) {
  const caretDoc = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };

  if (typeof caretDoc.caretPositionFromPoint === 'function') {
    const caretPosition = caretDoc.caretPositionFromPoint(point.x, point.y);
    if (caretPosition) {
      const range = doc.createRange();
      range.setStart(caretPosition.offsetNode, caretPosition.offset);
      range.collapse(true);
      return range;
    }
  }

  if (typeof caretDoc.caretRangeFromPoint === 'function') {
    const range = caretDoc.caretRangeFromPoint(point.x, point.y);
    if (range) {
      range.collapse(true);
      return range;
    }
  }

  return null;
}

function readTextOffsetAtPoint(root: HTMLElement | null, point: BlockActivationPoint | null) {
  if (!root || !point) return null;
  const doc = root.ownerDocument;
  const measure = doc.createRange();
  measure.selectNodeContents(root);
  const totalTextLength = measure.toString().length;
  const measuredRange = measure as Range & {
    getBoundingClientRect?: () => DOMRect;
  };
  if (typeof measuredRange.getBoundingClientRect === 'function') {
    const textRect = measuredRange.getBoundingClientRect();
    if (textRect.width > 0) {
      if (point.x <= textRect.left) return 0;
      if (point.x >= textRect.right) return totalTextLength;
    }
  }

  const range = createCaretRangeFromPoint(doc, point);
  if (!range || !root.contains(range.startContainer)) return null;
  measure.setEnd(range.startContainer, range.startOffset);
  return measure.toString().length;
}

function readTextClientRect(root: HTMLElement | null) {
  if (!root) return null;
  const doc = root.ownerDocument;
  const measure = doc.createRange();
  measure.selectNodeContents(root);
  const measuredRange = measure as Range & {
    getBoundingClientRect?: () => DOMRect;
  };
  if (typeof measuredRange.getBoundingClientRect !== 'function') return null;
  const rect = measuredRange.getBoundingClientRect();
  return rect.width > 0 ? rect : null;
}

function resolvePreviewTextRoot(root: HTMLElement | null, target: HTMLElement | null) {
  if (!root) return null;
  const targetElement = target;

  const directTextRoot = targetElement?.closest(
    '.tiptap-markdown-editor, .ProseMirror, [role="textbox"], [contenteditable="true"], [contenteditable="false"], p, h1, h2, h3, h4, h5, h6, blockquote, li, td, th'
  ) as HTMLElement | null;
  if (directTextRoot && root.contains(directTextRoot)) {
    return directTextRoot;
  }

  const explicitNavRoot = targetElement?.closest(BLOCK_NAV_TARGET_SELECTOR) as HTMLElement | null;
  if (explicitNavRoot && root.contains(explicitNavRoot)) {
    return explicitNavRoot;
  }

  const nestedTextRoot = root.querySelector(
    '.tiptap-markdown-editor, .ProseMirror, [role="textbox"], [contenteditable="true"], [contenteditable="false"]'
  ) as HTMLElement | null;
  if (nestedTextRoot) {
    return nestedTextRoot;
  }

  return root;
}

function placeContenteditableCaretByTextOffset(target: HTMLElement, textOffset: number, fallbackEdge: BlockActivationEdge) {
  const doc = target.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return false;

  const walker = doc.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, textOffset);
  let current = walker.nextNode();
  while (current) {
    const textLength = current.textContent?.length ?? 0;
    if (remaining <= textLength) {
      const range = doc.createRange();
      range.setStart(current, remaining);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    remaining -= textLength;
    current = walker.nextNode();
  }

  const range = doc.createRange();
  range.selectNodeContents(target);
  range.collapse(fallbackEdge === 'start');
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function placeContenteditableCaretByPoint(target: HTMLElement, point: BlockActivationPoint, fallbackEdge: BlockActivationEdge) {
  const doc = target.ownerDocument;
  const selection = doc.defaultView?.getSelection();
  if (!selection) return false;

  let range: Range | null = createCaretRangeFromPoint(doc, point);
  if (range && !target.contains(range.startContainer)) {
    range = null;
  }

  if (!range) {
    range = doc.createRange();
    range.selectNodeContents(target);
    range.collapse(fallbackEdge === 'start');
  }

  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function resolveEditableTarget(root: HTMLElement | null, edge: BlockActivationEdge) {
  if (!root) return null;
  const editableTargets = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_TEXT_EDITABLE_SELECTOR)).filter(
    (target) => !target.hasAttribute('disabled') && target.getAttribute('aria-hidden') !== 'true'
  );
  if (editableTargets.length === 0) return null;
  return edge === 'end' ? editableTargets[editableTargets.length - 1] : editableTargets[0];
}

function focusEditableTarget(root: HTMLElement | null, edge: BlockActivationEdge) {
  return focusCaretTarget(resolveEditableTarget(root, edge), edge);
}

function focusEditableTargetAtPoint(root: HTMLElement | null, point: BlockActivationPoint, edge: BlockActivationEdge) {
  const target = resolveEditableTarget(root, edge);
  if (!target) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return focusCaretTarget(target, edge);
  }

  const contenteditable = target.closest('[contenteditable="true"]') as HTMLElement | null;
  if (!contenteditable) {
    return focusCaretTarget(target, edge);
  }

  contenteditable.focus();
  return placeContenteditableCaretByPoint(contenteditable, point, edge);
}

function focusEditableTargetAtTextOffset(root: HTMLElement | null, textOffset: number, edge: BlockActivationEdge) {
  const target = resolveEditableTarget(root, edge);
  if (!target) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const position = Math.max(0, Math.min(textOffset, target.value.length));
    target.focus();
    target.setSelectionRange(position, position);
    return true;
  }

  const contenteditable = target.closest('[contenteditable="true"]') as HTMLElement | null;
  if (!contenteditable) {
    return focusCaretTarget(target, edge);
  }

  contenteditable.focus();
  return placeContenteditableCaretByTextOffset(contenteditable, textOffset, edge);
}

function findBlockNavTarget(root: HTMLElement | null, row: number, col = 0) {
  if (!root) return null;
  const candidates = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_NAV_TARGET_SELECTOR));
  return candidates.find((candidate) => {
    return Number(candidate.dataset.blockNavRow) === row && Number(candidate.dataset.blockNavCol || 0) === col;
  }) || null;
}

function focusBlockActivation(root: HTMLElement | null, request: BlockActivationRequest | null) {
  if (!root) return false;
  const point = request?.point ?? null;
  const textOffset = typeof request?.textOffset === 'number' ? request.textOffset : null;
  const row = request?.row;
  if (typeof row === 'number' && Number.isFinite(row)) {
    const targetRoot = findBlockNavTarget(root, row, request?.col ?? 0);
    if (targetRoot) {
      const edge = request?.edge === 'end' ? 'end' : 'start';
      if (textOffset !== null) {
        return focusEditableTargetAtTextOffset(targetRoot, textOffset, edge);
      }
      if (point) {
        return focusEditableTargetAtPoint(targetRoot, point, edge);
      }
      return focusCaretTarget(resolveEditableTarget(targetRoot, edge), edge);
    }
    return false;
  }

  if (textOffset !== null) {
    return focusEditableTargetAtTextOffset(root, textOffset, request?.edge === 'end' ? 'end' : 'start');
  }

  if (point) {
    return focusEditableTargetAtPoint(root, point, request?.edge === 'end' ? 'end' : 'start');
  }

  if (request?.edge) {
    return focusEditableTarget(root, request.edge);
  }

  const defaultTarget = resolveEditableTarget(root, 'start');
  return focusCaretTarget(defaultTarget, 'start');
}

function scheduleFocusBlockActivation(root: HTMLElement | null, request: BlockActivationRequest | null, remainingAttempts = 4) {
  const run = () => {
    if (focusBlockActivation(root, request) || remainingAttempts <= 0) {
      return;
    }
    window.requestAnimationFrame(() => scheduleFocusBlockActivation(root, request, remainingAttempts - 1));
  };

  window.requestAnimationFrame(run);
}

function isContenteditableBoundary(target: HTMLElement, direction: BlockFocusDirection) {
  const root = target.closest('[contenteditable="true"]') as HTMLElement | null;
  if (!root) return false;

  const selection = root.ownerDocument.defaultView?.getSelection();
  if (!selection || !selection.rangeCount || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  const anchorNode = selection.anchorNode;
  if (!anchorNode || !root.contains(anchorNode)) return false;

  const boundaryRange = range.cloneRange();
  boundaryRange.selectNodeContents(root);
  if (direction === 'up') {
    boundaryRange.setEnd(range.startContainer, range.startOffset);
  } else {
    boundaryRange.setStart(range.endContainer, range.endOffset);
  }

  return boundaryRange.toString().length === 0;
}

function isSingleLineContenteditable(target: HTMLElement) {
  const root = target.closest('[contenteditable="true"]') as HTMLElement | null;
  if (!root) return false;
  if (root.querySelector('p,div,li,blockquote,pre,table,ul,ol,h1,h2,h3,h4,h5,h6')) return false;
  return !(root.textContent || '').includes('\n');
}

function isInputBoundary(target: HTMLElement) {
  if (!isSingleLineTextInput(target)) return false;
  const input = target as HTMLInputElement;
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? 0;
  return start === end;
}

function shouldExitEditorOnArrowBoundary(target: HTMLElement | null, direction: BlockFocusDirection) {
  if (!target) return false;
  if (target instanceof HTMLSelectElement) return false;
  if (isInputBoundary(target)) return true;
  if (isTextareaBoundary(target, direction)) return true;
  if (isSingleLineContenteditable(target)) return true;
  return isContenteditableBoundary(target, direction);
}

function BlockNavTarget({
  row,
  col = 0,
  children,
  className,
}: {
  row: number;
  col?: number;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-block-nav-target="true" data-block-nav-row={row} data-block-nav-col={col} className={className}>
      {children}
    </div>
  );
}

function findInternalNavigationTarget(root: HTMLElement | null, target: HTMLElement | null, direction: BlockFocusDirection) {
  if (!root || !target) return null;
  const currentTarget = target.closest(BLOCK_NAV_TARGET_SELECTOR) as HTMLElement | null;
  if (!currentTarget || !root.contains(currentTarget)) return null;

  const currentRow = Number(currentTarget.dataset.blockNavRow);
  const currentCol = Number(currentTarget.dataset.blockNavCol || 0);
  if (!Number.isFinite(currentRow) || !Number.isFinite(currentCol)) return null;

  const desiredRow = currentRow + (direction === 'up' ? -1 : 1);
  const nextTarget = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_NAV_TARGET_SELECTOR)).find((candidate) => {
    return Number(candidate.dataset.blockNavRow) === desiredRow && Number(candidate.dataset.blockNavCol || 0) === currentCol;
  });

  return resolveEditableTarget(nextTarget || null, direction === 'up' ? 'end' : 'start');
}

function resolvePreviewTableTarget(root: HTMLElement | null, target: HTMLElement | null, headerOffset: number) {
  if (!root || !target) return null;
  const cell = target.closest('th,td') as HTMLTableCellElement | null;
  if (!cell || !root.contains(cell)) return null;
  const table = cell.closest('table');
  const row = cell.closest('tr');
  if (!table || !row || !root.contains(table)) return null;
  const rows = Array.from(table.querySelectorAll('tr'));
  const rowIndex = rows.indexOf(row);
  if (rowIndex === -1) return null;
  return {
    row: Math.max(0, rowIndex - headerOffset),
    col: cell.cellIndex,
  };
}

function resolvePreviewListTarget(root: HTMLElement | null, target: HTMLElement | null) {
  if (!root || !target) return null;
  const navTarget = target.closest(BLOCK_NAV_TARGET_SELECTOR) as HTMLElement | null;
  if (navTarget && root.contains(navTarget)) {
    const row = Number(navTarget.dataset.blockNavRow);
    const col = Number(navTarget.dataset.blockNavCol || 0);
    if (Number.isFinite(row) && Number.isFinite(col)) {
      return { row, col };
    }
  }
  const item = target.closest('li');
  if (!item || !root.contains(item)) return null;
  const items = Array.from(root.querySelectorAll('li'));
  const row = items.indexOf(item);
  if (row === -1) return null;
  return { row, col: 0 };
}

function resolvePreviewActivationRequest(
  kind: string,
  root: HTMLElement | null,
  target: HTMLElement | null,
  markdown: string,
  point: BlockActivationPoint | null
): BlockActivationRequest {
  const textRoot = resolvePreviewTextRoot(root, target);
  const textOffset = readTextOffsetAtPoint(textRoot, point);
  switch (kind) {
    case 'frontmatter':
      return { ...(resolvePreviewTableTarget(root, target, 1) || { row: 0, col: 0 }), point, textOffset };
    case 'list':
    case 'task_list':
      return { ...(resolvePreviewListTarget(root, target) || { row: 0, col: 0 }), point, textOffset };
    case 'table':
      return { ...(resolvePreviewTableTarget(root, target, 0) || { row: 0, col: 0 }), point, textOffset };
    case 'callout': {
      if (target?.closest('[data-callout-title="true"]')) {
        return { row: 0, col: 1, point, textOffset };
      }
      const bodyTarget = target?.closest('p,ul,ol,pre,table,blockquote');
      return { row: bodyTarget ? 1 : 0, col: 0, point, textOffset };
    }
    case 'code':
      return /^(`{3,}|~{3,})mermaid\b/i.test(markdown)
        ? { row: 1, col: 0, point, textOffset }
        : { row: 1, col: 0, point, textOffset };
    case 'footnote': {
      const previewRow = target?.closest<HTMLElement>('[data-footnote-preview-row]');
      const row = Number(previewRow?.dataset.footnotePreviewRow || 1);
      return { row: Number.isFinite(row) ? row : 1, col: 0, point, textOffset };
    }
    case 'image':
      return { row: 0, col: 0, point, textOffset };
    case 'html':
      return { edge: 'start', point, textOffset };
    default:
      return point || textOffset !== null ? { point, textOffset } : {};
  }
}

function shouldCreateParagraphAfterEnter(kind: string, target: HTMLElement | null) {
  if (!target) return false;
  if (!['paragraph', 'heading', 'blockquote'].includes(kind)) return false;
  return shouldExitEditorOnArrowBoundary(target, 'down');
}

function parseImage(markdown: string) {
  const trimmed = markdown.trim();
  if (!trimmed.startsWith('![') || trimmed.includes('\n') || !trimmed.endsWith(')')) return null;
  const separatorIndex = trimmed.indexOf('](');
  if (separatorIndex < 2) return null;
  const alt = trimmed.slice(2, separatorIndex);
  const payload = trimmed.slice(separatorIndex + 2, -1).trim();
  if (!payload) return null;
  const match = payload.match(/^(.*?)(?:\s+"([^"]*)")?$/);
  if (!match?.[1]) return null;
  return {
    alt,
    src: match[1].trim(),
    title: match[2] || '',
  };
}

function serializeImage(image: { alt: string; src: string; title: string }) {
  const title = image.title.trim();
  return `![${image.alt}](${image.src}${title ? ` "${title}"` : ''})`;
}

function parseHeading(markdown: string) {
  const match = markdown.match(/^(#{1,6})\s+(.*)$/);
  if (!match) return null;
  return {
    level: match[1].length,
    text: match[2],
  };
}

function serializeHeading(level: number, text: string) {
  const safeLevel = Math.max(1, Math.min(6, level));
  return `${'#'.repeat(safeLevel)} ${text}`;
}

function parseFootnote(markdown: string) {
  const lines = markdown.split('\n');
  const first = lines[0]?.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
  if (!first) return null;
  const body = [first[2], ...lines.slice(1).map((line) => line.replace(/^\s{2,4}/, ''))].join('\n').trim();
  return {
    identifier: first[1],
    body,
  };
}

function serializeFootnote(identifier: string, body: string) {
  const [firstLine = '', ...rest] = body.split('\n');
  const nextLines = rest.map((line) => `  ${line}`).join('\n');
  return nextLines ? `[^${identifier}]: ${firstLine}\n${nextLines}` : `[^${identifier}]: ${firstLine}`;
}

function joinClassNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

function fieldChangeClass(_baseValue: string | null | undefined, _nextValue: string) {
  return '';
}

function RemovedValueBadge({ value, className }: { value: string; className?: string }) {
  if (!value.trim()) return null;
  return (
    <span
      data-diff-op="delete"
      className={joinClassNames(
        diffInlineDeleteClassName,
        'inline-flex max-w-full items-center px-1.5 text-[10px] text-rose-900/80',
        className
      )}
    >
      {value}
    </span>
  );
}

function listRowDiffClass(_baseItem: VisualListItem | undefined, _item: VisualListItem) {
  return '';
}

function renderCharacterDiffContent(baseValue: string, nextValue: string) {
  const parts = diffChars(baseValue, nextValue);
  return parts.map((part, index) => {
    if (!part.value) return null;
    if (part.added) {
      return (
        <span key={`diff-insert-${index}`} data-diff-op="insert" className={diffInlineInsertClassName}>
          {part.value}
        </span>
      );
    }
    if (part.removed) {
      return (
        <del key={`diff-delete-${index}`} data-diff-op="delete" className={diffInlineDeleteClassName}>
          {part.value}
        </del>
      );
    }
    return <span key={`diff-equal-${index}`}>{part.value}</span>;
  });
}

function renderStaticDiffText(baseValue: string, nextValue: string) {
  if (baseValue === nextValue) return nextValue;
  return renderCharacterDiffContent(baseValue, nextValue);
}

function blockDiffSurfaceStyle(status: MarkdownDiffUnit['status'], enabled: boolean): CSSProperties | undefined {
  if (!enabled || status === 'equal') return undefined;

  if (status === 'added') {
    return {
      backgroundColor: 'rgba(16, 185, 129, 0.10)',
      boxShadow: 'inset 3px 0 0 rgba(16, 185, 129, 0.72)',
      borderRadius: '0.75rem',
    };
  }

  if (status === 'removed') {
    return {
      backgroundColor: 'rgba(244, 63, 94, 0.08)',
      boxShadow: 'inset 3px 0 0 rgba(244, 63, 94, 0.7)',
      borderRadius: '0.75rem',
    };
  }

  return undefined;
}

function normalizeEditableValue(value: string, multiline = false) {
  const normalized = value.replace(/\r/g, '');
  return multiline ? normalized : normalized.replace(/\n/g, ' ');
}

function readEditableValue(node: HTMLElement, multiline = false) {
  const raw = (node.textContent || '').replace(/\u00a0/g, ' ');
  return multiline ? raw.replace(/\r/g, '') : raw.replace(/\r?\n/g, ' ');
}

function EditablePlainText({
  value,
  active,
  onChange,
  onKeyDown,
  className,
  multiline = false,
  as = 'div',
  role,
  ariaLabel,
  diffBaseValue = null,
  showDiffDecorations = false,
}: {
  value: string;
  active: boolean;
  onChange: (nextValue: string) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
  className?: string;
  multiline?: boolean;
  as?: 'div' | 'span';
  role?: string;
  ariaLabel?: string;
  diffBaseValue?: string | null;
  showDiffDecorations?: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const normalizedValue = normalizeEditableValue(value, multiline);
  const normalizedBaseValue =
    diffBaseValue === null || diffBaseValue === undefined ? null : normalizeEditableValue(diffBaseValue, multiline);
  const shouldRenderStaticDiff =
    !active && showDiffDecorations && normalizedBaseValue !== null && normalizedBaseValue !== normalizedValue;

  useLayoutEffect(() => {
    if (shouldRenderStaticDiff) return;
    const node = ref.current;
    if (!node) return;
    if (node.textContent === normalizedValue) return;
    if (node.ownerDocument.activeElement === node) return;
    node.textContent = normalizedValue;
  }, [multiline, normalizedValue, shouldRenderStaticDiff]);

  const handleInput: React.FormEventHandler<HTMLElement> = (event) => {
    const nextValue = readEditableValue(event.currentTarget, multiline);
    if (nextValue !== value) {
      onChange(nextValue);
    }
  };

  const handlePaste: React.ClipboardEventHandler<HTMLElement> = (event) => {
    if (!active) return;
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    const payload = multiline ? text : text.replace(/\r?\n+/g, ' ');
    document.execCommand('insertText', false, payload);
  };

  const Tag = as;

  if (shouldRenderStaticDiff) {
    return (
      <Tag
        key={`static-diff:${as}`}
        role={role || 'textbox'}
        aria-label={ariaLabel}
        aria-multiline={multiline || undefined}
        aria-readonly="true"
        className={className}
      >
        {renderStaticDiffText(normalizedBaseValue, normalizedValue)}
      </Tag>
    );
  }

  return (
    <Tag
      key={`plain-text:${as}`}
      ref={ref as any}
      role={role || 'textbox'}
      aria-label={ariaLabel}
      aria-multiline={multiline || undefined}
      aria-readonly={!active}
      contentEditable={active}
      suppressContentEditableWarning
      spellCheck={false}
      onInput={handleInput}
      onPaste={handlePaste}
      onKeyDown={onKeyDown}
      className={className}
    />
  );
}

function SourcePreviewBlockEditor({
  markdown,
  onChange,
  notice,
}: {
  markdown: string;
  onChange: (nextMarkdown: string) => void;
  notice: string;
}) {
  return (
    <div className="space-y-3">
      {notice ? <div className="text-[11px] text-theme-text/46">{notice}</div> : null}
      <div className="min-h-[200px] overflow-hidden rounded-lg border border-theme-border/16 bg-theme-bg/70">
        <RawMarkdownEditor content={markdown} onChange={onChange} className="px-4 py-4 text-[13px] leading-6" />
      </div>
      <div className="min-h-[160px] overflow-auto rounded-lg border border-theme-border/14 bg-theme-surface/10 px-4 py-3">
        <MarkdownContent content={markdown} className="[&_p]:my-2 [&_pre]:my-2" />
      </div>
    </div>
  );
}

function HtmlSourceDrawerBlockEditor({
  markdown,
  onChange,
}: {
  markdown: string;
  onChange: (nextMarkdown: string) => void;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr),minmax(320px,38%)]">
      <div className="min-h-[220px] overflow-auto rounded-xl border border-theme-border/16 bg-theme-surface/10 px-4 py-3">
        <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-theme-text/44">
          Rendered HTML
        </div>
        <MarkdownContent content={markdown} className="[&_p]:my-2 [&_pre]:my-2" />
      </div>
      <div className="overflow-hidden rounded-xl border border-theme-border/16 bg-theme-bg/80">
        <div className="border-b border-theme-border/14 px-4 py-2 text-[11px] text-theme-text/52">
          <span>This block stays source editable in place.</span>{' '}
          <span>HTML stays rendered in place and edits through a local source drawer.</span>
        </div>
        <RawMarkdownEditor content={markdown} onChange={onChange} className="px-4 py-4 text-[13px] leading-6" />
      </div>
    </div>
  );
}

function MermaidBlockEditor({
  markdown,
  onChange,
}: {
  markdown: string;
  onChange: (nextMarkdown: string) => void;
}) {
  const parsed = parseCodeFence(markdown);
  if (!parsed) {
    return (
      <SourcePreviewBlockEditor
        markdown={markdown}
        notice="Unsupported Mermaid fenced syntax stays block-local source editable."
        onChange={onChange}
      />
    );
  }

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1.1fr),minmax(380px,0.9fr)]">
      <div className="min-w-0">
        <MermaidDiagram chart={parsed.code} title="Diagram preview" />
      </div>
      <div className="space-y-2">
        <BlockNavTarget row={0}>
          <input
            autoFocus
            value={parsed.language}
            onChange={(event) => {
              onChange(serializeCodeFence(parsed.fence, event.target.value, parsed.code));
            }}
            placeholder="Language"
            className="w-[180px] rounded-md border border-transparent bg-theme-surface/8 px-2 py-1.5 text-[12px] outline-none focus:border-theme-border/20 focus:bg-theme-bg"
          />
        </BlockNavTarget>
        <BlockNavTarget row={1}>
          <CodeMirrorBlockEditor
            autoFocus
            value={parsed.code}
            onChange={(value) => {
              onChange(serializeCodeFence(parsed.fence, parsed.language, value));
            }}
          />
        </BlockNavTarget>
      </div>
    </div>
  );
}

function MermaidBlockPreview({ markdown }: { markdown: string }) {
  const parsed = parseCodeFence(markdown);
  if (!parsed || parsed.language.trim().toLowerCase() !== 'mermaid') {
    return <MarkdownContent content={markdown} className="[&_p]:my-2 [&_pre]:my-2" hideFootnotesSection />;
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-theme-border/16 bg-theme-surface/6 px-4 py-4">
      <MermaidDiagram chart={parsed.code} title="Diagram preview" />
    </div>
  );
}

function ImageBlockPreview({ markdown }: { markdown: string }) {
  const parsed = parseImage(markdown);
  if (!parsed) {
    return <MarkdownContent content={markdown} className="[&_p]:my-2 [&_pre]:my-2" hideFootnotesSection />;
  }

  return (
    <figure className="space-y-3 rounded-2xl border border-theme-border/16 bg-theme-surface/6 p-4">
      {parsed.src ? (
        <div className="overflow-hidden rounded-xl border border-theme-border/12 bg-theme-bg/80">
          <img src={parsed.src} alt={parsed.alt} className="max-h-[320px] w-full object-contain" />
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-theme-border/16 px-4 py-10 text-center text-sm text-theme-text/42">
          Missing image source
        </div>
      )}
      <figcaption className="space-y-1 text-sm text-theme-text/62">
        <div className="font-medium text-theme-text/72">{parsed.alt || 'Untitled image'}</div>
        {parsed.title ? <div className="text-xs uppercase tracking-[0.12em] text-theme-text/42">{parsed.title}</div> : null}
      </figcaption>
    </figure>
  );
}

function FootnoteBlockPreview({ markdown }: { markdown: string }) {
  const parsed = parseFootnote(markdown);
  if (!parsed) {
    return <MarkdownContent content={markdown} className="[&_p]:my-2 [&_pre]:my-2" hideFootnotesSection />;
  }

  return (
    <div className="rounded-xl border border-theme-border/16 bg-theme-surface/6 px-4 py-3">
      <div data-footnote-preview-row="0" className="mb-2 inline-flex items-center rounded-full bg-theme-text/8 px-2.5 py-1 text-[11px] font-semibold text-theme-text/66">
        {`[^${parsed.identifier}]`}
      </div>
      <div data-footnote-preview-row="1" className="min-w-0">
        <MarkdownContent content={parsed.body || ' '} className="[&_p]:my-1.5 [&_pre]:my-2" hideFootnotesSection />
      </div>
    </div>
  );
}

function InlineRichBlockEditor(props: {
  markdown: string;
  onChange: (markdown: string) => void;
  onBlur?: () => void;
  editable?: boolean;
  autofocus?: boolean;
  placeholder?: string;
  showPlaceholderWhenReadonly?: boolean;
  inlineDiffBaseMarkdown?: string | null;
  onViewportChange?: MarkdownDocumentEditorProps['onViewportChange'];
  availableSessions?: MarkdownDocumentEditorProps['availableSessions'];
  defaultSessionId?: string;
  sourceFile?: { id: string; name: string };
  onAddReferenceToSession?: MarkdownDocumentEditorProps['onAddReferenceToSession'];
  onRunSelectionAction?: MarkdownDocumentEditorProps['onRunSelectionAction'];
}) {
  return (
    <div className="overflow-hidden bg-transparent">
      <TiptapMarkdownEditor
        content={props.markdown}
        onChange={props.onChange}
        onBlur={props.onBlur}
        placeholder={props.placeholder}
        showPlaceholderWhenReadonly={props.showPlaceholderWhenReadonly}
        editable={props.editable ?? true}
        onViewportChange={props.onViewportChange}
        availableSessions={props.availableSessions}
        defaultSessionId={props.defaultSessionId}
        sourceFile={props.sourceFile}
        inlineDiffBaseMarkdown={props.inlineDiffBaseMarkdown}
        onAddReferenceToSession={props.onAddReferenceToSession}
        onRunSelectionAction={props.onRunSelectionAction}
        chrome="inline"
        autofocus={Boolean((props.autofocus ?? true) && (props.editable ?? true))}
      />
    </div>
  );
}

function EmptyParagraphLineSurface({
  unit,
  active,
  markdown,
  onActivate,
  onChangeContent,
  onBlur,
  onKeyDownCapture,
  onViewportChange,
  availableSessions,
  defaultSessionId,
  sourceFile,
  onAddReferenceToSession,
  onRunSelectionAction,
}: {
  unit: EmptyParagraphLineUnit;
  active: boolean;
  markdown: string;
  onActivate: (event: React.MouseEvent<HTMLDivElement>) => void;
  onChangeContent: (nextMarkdown: string) => void;
  onBlur: () => void;
  onKeyDownCapture: React.KeyboardEventHandler<HTMLDivElement>;
  onViewportChange?: MarkdownDocumentEditorProps['onViewportChange'];
  availableSessions?: MarkdownDocumentEditorProps['availableSessions'];
  defaultSessionId?: string;
  sourceFile?: { id: string; name: string };
  onAddReferenceToSession?: MarkdownDocumentEditorProps['onAddReferenceToSession'];
  onRunSelectionAction?: MarkdownDocumentEditorProps['onRunSelectionAction'];
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!active) return;
    scheduleFocusBlockActivation(surfaceRef.current, { edge: 'start' });
  }, [active, unit.id]);

  return (
    <div
      ref={surfaceRef}
      data-empty-paragraph-id={unit.id}
      data-testid="markdown-empty-paragraph-line"
      className="py-0.5"
      onKeyDownCapture={active ? onKeyDownCapture : undefined}
    >
      <InlineRichBlockNodeSurface
        active={active}
        onActivate={onActivate}
        className="min-h-[1.75rem]"
        markdown={markdown}
        inlineDiffBaseMarkdown={null}
        onChange={onChangeContent}
        onBlur={onBlur}
        placeholder="Type / for commands, or start writing..."
        autofocus
        onViewportChange={onViewportChange}
        availableSessions={availableSessions}
        defaultSessionId={defaultSessionId}
        sourceFile={sourceFile}
        onAddReferenceToSession={onAddReferenceToSession}
        onRunSelectionAction={onRunSelectionAction}
      />
    </div>
  );
}

function InlineRichBlockNodeSurface(
  props: {
    active: boolean;
    onActivate?: (event: React.MouseEvent<HTMLDivElement>) => void;
    className?: string;
  } & Parameters<typeof InlineRichBlockEditor>[0]
) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  const handleActiveMouseDownCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!props.active) return;
    if (event.button !== 0) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    const target = event.target as HTMLElement | null;
    const textRoot = resolvePreviewTextRoot(surfaceRef.current, target);
    const textRect = readTextClientRect(textRoot);
    const insideEditable = Boolean(target?.closest('[contenteditable="true"]'));
    const outsideHorizontalBounds = Boolean(textRect && (event.clientX <= textRect.left || event.clientX >= textRect.right));

    if (insideEditable && !outsideHorizontalBounds) return;

    const textOffset = readTextOffsetAtPoint(textRoot, { x: event.clientX, y: event.clientY });
    if (textOffset === null) return;

    event.preventDefault();
    window.requestAnimationFrame(() => {
      focusEditableTargetAtTextOffset(surfaceRef.current, textOffset, event.clientX >= (textRect?.right ?? event.clientX) ? 'end' : 'start');
    });
  };

  const handleActiveMouseUpCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!props.active) return;
    if (event.button !== 0) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;

    const point = { x: event.clientX, y: event.clientY };
    const textRoot = resolvePreviewTextRoot(surfaceRef.current, event.target as HTMLElement | null);
    const textOffset = readTextOffsetAtPoint(textRoot, point);
    if (textOffset === null) return;

    window.requestAnimationFrame(() => {
      focusEditableTargetAtTextOffset(surfaceRef.current, textOffset, 'start');
    });
  };

  return (
    <div
      ref={surfaceRef}
      data-block-render-surface="true"
      onMouseDownCapture={props.active ? handleActiveMouseDownCapture : undefined}
      onMouseDown={!props.active ? props.onActivate : undefined}
      onMouseUpCapture={props.active ? handleActiveMouseUpCapture : undefined}
      className={`block w-full text-left outline-none cursor-text ${props.className || ''}`.trim()}
    >
      <InlineRichBlockEditor
        markdown={props.markdown}
        onChange={props.onChange}
        onBlur={props.onBlur}
        editable={props.active}
        autofocus={props.autofocus}
        placeholder={props.placeholder}
        showPlaceholderWhenReadonly={props.showPlaceholderWhenReadonly}
        inlineDiffBaseMarkdown={props.inlineDiffBaseMarkdown}
        onViewportChange={props.onViewportChange}
        availableSessions={props.availableSessions}
        defaultSessionId={props.defaultSessionId}
        sourceFile={props.sourceFile}
        onAddReferenceToSession={props.onAddReferenceToSession}
        onRunSelectionAction={props.onRunSelectionAction}
      />
    </div>
  );
}

function UnifiedBlockNodeSurface({
  active,
  onActivate,
  className,
  children,
}: {
  active: boolean;
  onActivate?: (event: React.MouseEvent<HTMLDivElement>) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-block-render-surface="true"
      onMouseDown={!active ? onActivate : undefined}
      className={`block w-full text-left outline-none cursor-text ${className || ''}`.trim()}
    >
      {children}
    </div>
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findReferencedFootnoteDefinitions(markdown: string, fullDocumentContent: string) {
  const labels = Array.from(markdown.matchAll(/\[\^([^\]]+)\]/g), (match) => match[1])
    .filter((label, index, values) => values.indexOf(label) === index)
    .filter((label) => !new RegExp(`^\\[\\^${escapeRegExp(label)}\\]:`, 'm').test(markdown));

  if (labels.length === 0) return [];

  const lines = fullDocumentContent.split('\n');

  return labels
    .map((label) => {
      const definitionPattern = new RegExp(`^\\[\\^${escapeRegExp(label)}\\]:\\s?.*$`);
      for (let index = 0; index < lines.length; index += 1) {
        if (!definitionPattern.test(lines[index])) continue;
        const collected = [lines[index]];
        let cursor = index + 1;
        while (cursor < lines.length) {
          const nextLine = lines[cursor];
          const nextIndented = /^(?: {2,}|\t)/.test(nextLine);
          const blankWithIndentedFollower =
            nextLine.trim().length === 0 && /^(?: {2,}|\t)/.test(lines[cursor + 1] || '');
          if (!nextIndented && !blankWithIndentedFollower) break;
          collected.push(nextLine);
          cursor += 1;
        }
        return collected.join('\n');
      }
      return null;
    })
    .filter((definition): definition is string => Boolean(definition));
}

function buildPreviewMarkdown(markdown: string, fullDocumentContent: string) {
  const definitions = findReferencedFootnoteDefinitions(markdown, fullDocumentContent);
  if (definitions.length === 0) return markdown;
  return `${markdown}\n\n${definitions.join('\n\n')}`;
}

function hasDistinctEditorChrome(block: Pick<MarkdownEditBlock, 'activeEditorKind'> | null) {
  if (!block) return false;
  return ['code', 'mermaid', 'math', 'image', 'source_drawer'].includes(block.activeEditorKind);
}

function MarkdownDiffPreview({ unit, fullDocumentContent }: { unit: MarkdownDiffUnit; fullDocumentContent: string }) {
  const oldContent = unit.baseBlock?.markdown ?? '';
  const newContent = unit.draftBlock?.markdown ?? '';
  const diffBlocks = useMemo(() => buildDiffBlocks(buildRowsFromContents(oldContent, newContent)), [newContent, oldContent]);
  const fallbackContent = buildPreviewMarkdown(unit.draftBlock?.markdown ?? unit.baseBlock?.markdown ?? '', fullDocumentContent);

  if (diffBlocks.length === 0) {
    return (
      <MarkdownContent
        content={fallbackContent}
        className="[&_p]:my-2 [&_blockquote]:my-2 [&_pre]:my-2"
        hideFootnotesSection
      />
    );
  }

  return (
    <div className="space-y-1">
      {diffBlocks.map((block) => (
        <DiffBlockCard key={block.id} block={block} selectedLineId={null} />
      ))}
    </div>
  );
}

function MarkdownBlockSurface({
  unit,
  active,
  draftContent,
  baseContent,
  showInlineDiffDecorations,
  onSelect,
  onBoundaryNavigate,
  activationFocusEdge,
  activationFocusRow,
  activationFocusCol,
  activationFocusPoint,
  activationFocusTextOffset,
  activationFocusKey,
  onChangeContent,
  onReplaceBlockAndInsertEmptyParagraphAfter,
  onReplaceBlockWithEmptyParagraph,
  onViewportChange,
  availableSessions,
  defaultSessionId,
  sourceFile,
  onAddReferenceToSession,
  onRunSelectionAction,
  onRequestParagraphInsertionAfterBlock,
}: {
  unit: MarkdownDiffUnit;
  active: boolean;
  draftContent: string;
  baseContent: string;
  showInlineDiffDecorations: boolean;
  onSelect: (request?: BlockActivationRequest) => void;
  onBoundaryNavigate: (direction: BlockFocusDirection) => void;
  activationFocusEdge: BlockActivationEdge | null;
  activationFocusRow: number | null;
  activationFocusCol: number | null;
  activationFocusPoint: BlockActivationPoint | null;
  activationFocusTextOffset: number | null;
  activationFocusKey: number;
  onChangeContent: (nextContent: string) => void;
  onReplaceBlockAndInsertEmptyParagraphAfter: (blockId: string, markdown: string) => void;
  onReplaceBlockWithEmptyParagraph: (blockId: string) => void;
  onRequestParagraphInsertionAfterBlock: (blockId: string) => void;
} & Pick<
  MarkdownDocumentEditorProps,
  'onViewportChange' | 'availableSessions' | 'defaultSessionId' | 'sourceFile' | 'onAddReferenceToSession' | 'onRunSelectionAction'
>) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const block = unit.draftBlock;
  const previewBlock = unit.draftBlock || unit.baseBlock;
  if (!previewBlock) return null;
  const canActivate = Boolean(block);
  const previewContextContent = unit.draftBlock ? draftContent : baseContent;
  const previewMarkdown = buildPreviewMarkdown(previewBlock.markdown, previewContextContent);
  const distinctEditorChrome = hasDistinctEditorChrome(previewBlock);
  const renderDiffDecorations = showInlineDiffDecorations && !active;
  const inlineDiffBaseMarkdown =
    renderDiffDecorations && unit.status !== 'equal' ? unit.baseBlock?.markdown ?? null : null;
  const usePreciseInlineFocus = activationFocusTextOffset !== null || activationFocusPoint !== null;

  const surfaceClassName = distinctEditorChrome
    ? `relative -mx-3 rounded-xl px-3 py-2 transition-colors ${active ? 'bg-theme-text/[0.03]' : 'bg-transparent'}`
    : 'relative';
  const surfaceStyle = blockDiffSurfaceStyle(unit.status, renderDiffDecorations);
  const previewClassName = distinctEditorChrome
    ? `block w-full text-left outline-none ${canActivate ? 'cursor-text rounded-lg transition-colors hover:bg-theme-text/[0.03]' : 'cursor-default'}`
    : `block w-full text-left outline-none ${canActivate ? 'cursor-text' : 'cursor-default'}`;

  useEffect(() => {
    if (!active) return;
    if (
      activationFocusEdge === null &&
      activationFocusRow === null &&
      activationFocusCol === null &&
      activationFocusPoint === null &&
      activationFocusTextOffset === null
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      focusBlockActivation(surfaceRef.current, {
        edge: activationFocusEdge,
        row: activationFocusRow,
        col: activationFocusCol,
        point: activationFocusPoint,
        textOffset: activationFocusTextOffset,
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    active,
    activationFocusCol,
    activationFocusEdge,
    activationFocusKey,
    activationFocusPoint,
    activationFocusRow,
    activationFocusTextOffset,
  ]);

  const commitMarkdown = (nextMarkdown: string) => {
    if (!block) return;
    if (isPersistableEmptyBlockMarkdown(block.kind, nextMarkdown)) {
      onReplaceBlockWithEmptyParagraph(block.id);
      return;
    }
    onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown));
  };

  const renderDistinctEditor = () => {
    if (!block) return null;
    switch (block.kind) {
      case 'image': {
        const parsed = parseImage(block.markdown);
        if (!parsed) {
          return (
            <SourcePreviewBlockEditor
              markdown={block.markdown}
              notice="Complex image syntax stays block-local source editable."
              onChange={(nextMarkdown) => commitMarkdown(nextMarkdown)}
            />
          );
        }
        return (
          <div className="space-y-3 py-1">
            {parsed.src ? (
              <img
                src={parsed.src}
                alt={parsed.alt}
                className="mx-auto block max-h-[420px] max-w-full rounded-xl border border-theme-border/16 bg-theme-surface/8 object-contain"
              />
            ) : (
              <div className="rounded-xl border border-dashed border-theme-border/24 px-4 py-10 text-center text-sm text-theme-text/42">
                Missing image source
              </div>
            )}
            <div className="grid gap-2 md:grid-cols-3">
              <BlockNavTarget row={0}>
                <input
                  autoFocus
                  value={parsed.src}
                  onChange={(event) => {
                    commitMarkdown(serializeImage({ ...parsed, src: event.target.value }));
                  }}
                  placeholder="Image URL"
                  className="w-full rounded-md border border-transparent bg-theme-surface/8 px-2 py-1.5 text-sm outline-none focus:border-theme-border/20 focus:bg-theme-bg"
                />
              </BlockNavTarget>
              <BlockNavTarget row={1}>
                <input
                  value={parsed.alt}
                  onChange={(event) => {
                    commitMarkdown(serializeImage({ ...parsed, alt: event.target.value }));
                  }}
                  placeholder="Alt text"
                  className="w-full rounded-md border border-transparent bg-theme-surface/8 px-2 py-1.5 text-sm outline-none focus:border-theme-border/20 focus:bg-theme-bg"
                />
              </BlockNavTarget>
              <BlockNavTarget row={2}>
                <input
                  value={parsed.title}
                  onChange={(event) => {
                    commitMarkdown(serializeImage({ ...parsed, title: event.target.value }));
                  }}
                  placeholder="Caption"
                  className="w-full rounded-md border border-transparent bg-theme-surface/8 px-2 py-1.5 text-sm outline-none focus:border-theme-border/20 focus:bg-theme-bg"
                />
              </BlockNavTarget>
            </div>
          </div>
        );
      }
      case 'code': {
        const parsed = parseCodeFence(block.markdown);
        if (!parsed) {
          return (
            <SourcePreviewBlockEditor
              markdown={block.markdown}
              notice="Unsupported fenced block syntax stays block-local source editable."
              onChange={(nextMarkdown) => commitMarkdown(nextMarkdown)}
            />
          );
        }
        if (parsed.language.trim().toLowerCase() === 'mermaid') {
          return <MermaidBlockEditor markdown={block.markdown} onChange={(nextMarkdown) => commitMarkdown(nextMarkdown)} />;
        }
        return (
          <div className="space-y-2 py-1">
            <BlockNavTarget row={0}>
              <input
                autoFocus
                value={parsed.language}
                onChange={(event) => {
                  commitMarkdown(serializeCodeFence(parsed.fence, event.target.value, parsed.code));
                }}
                placeholder="Language"
                className="w-[180px] rounded-md border border-transparent bg-theme-surface/8 px-2 py-1.5 text-[12px] outline-none focus:border-theme-border/20 focus:bg-theme-bg"
              />
            </BlockNavTarget>
            <BlockNavTarget row={1}>
              <CodeMirrorBlockEditor
                autoFocus
                value={parsed.code}
                onChange={(value) => {
                  commitMarkdown(serializeCodeFence(parsed.fence, parsed.language, value));
                }}
              />
            </BlockNavTarget>
          </div>
        );
      }
      case 'math': {
        const formula = stripMathDelimiters(block.markdown);
        return (
          <div className="space-y-3 py-1">
            <BlockNavTarget row={0}>
              <div className="rounded-xl border border-theme-border/16 bg-theme-bg px-4 py-4">
                <textarea
                  data-testid="math-formula-input"
                  autoFocus
                  value={formula}
                  onChange={(event) => {
                    commitMarkdown(renderMathMarkdown(event.target.value, true));
                  }}
                  spellCheck={false}
                  className="min-h-[180px] w-full rounded border border-theme-border/22 bg-theme-bg px-3 py-2 font-mono text-[13px] leading-6 outline-none"
                />
              </div>
            </BlockNavTarget>
            <div className="min-h-[120px] overflow-auto rounded-xl border border-theme-border/16 bg-theme-surface/10 px-4 py-4">
              <MarkdownContent content={block.markdown} />
            </div>
          </div>
        );
      }
      case 'html':
        return <HtmlSourceDrawerBlockEditor markdown={block.markdown} onChange={(nextMarkdown) => commitMarkdown(nextMarkdown)} />;
      case 'unknown':
        return (
          <SourcePreviewBlockEditor
            markdown={block.markdown}
            notice="This block stays source editable in place."
            onChange={(nextMarkdown) => commitMarkdown(nextMarkdown)}
          />
        );
      default:
        return null;
    }
  };

  const renderUnifiedOrdinaryBlock = () => {
    const workingBlock = block || previewBlock;
    switch (workingBlock.kind) {
      case 'heading': {
        const parsed = parseHeading(workingBlock.markdown);
        if (!parsed) {
          return (
            <InlineRichBlockNodeSurface
              active={active}
              onActivate={canActivate ? handleActivate : undefined}
              className={previewClassName}
              markdown={workingBlock.markdown}
              onChange={commitMarkdown}
              autofocus={!usePreciseInlineFocus}
              inlineDiffBaseMarkdown={inlineDiffBaseMarkdown}
              onViewportChange={onViewportChange}
              availableSessions={availableSessions}
              defaultSessionId={defaultSessionId}
              sourceFile={sourceFile}
              onAddReferenceToSession={onAddReferenceToSession}
              onRunSelectionAction={onRunSelectionAction}
            />
          );
        }
        return (
          <UnifiedBlockNodeSurface active={active} onActivate={canActivate ? handleActivate : undefined} className={previewClassName}>
            <div className="group relative">
              <div className="pointer-events-none absolute -left-11 top-1/2 z-10 -translate-y-1/2">
                <select
                  aria-label="Heading level"
                  disabled={!active}
                  value={parsed.level}
                  onChange={(event) => {
                    commitMarkdown(serializeHeading(Number(event.target.value), parsed.text));
                  }}
                  className={`pointer-events-auto rounded border border-transparent bg-theme-bg/86 px-1.5 py-0.5 text-[10px] font-semibold text-theme-text/42 shadow-sm outline-none transition-opacity ${
                    active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  }`}
                >
                  {[1, 2, 3, 4, 5, 6].map((level) => (
                    <option key={level} value={level}>
                      H{level}
                    </option>
                  ))}
                </select>
              </div>
              <BlockNavTarget row={0} className="min-w-0">
                <InlineRichBlockEditor
                  markdown={workingBlock.markdown}
                  editable={active}
                  autofocus={!usePreciseInlineFocus}
                  inlineDiffBaseMarkdown={inlineDiffBaseMarkdown}
                  onChange={commitMarkdown}
                  onViewportChange={onViewportChange}
                  availableSessions={availableSessions}
                  defaultSessionId={defaultSessionId}
                  sourceFile={sourceFile}
                  onAddReferenceToSession={onAddReferenceToSession}
                  onRunSelectionAction={onRunSelectionAction}
                />
              </BlockNavTarget>
            </div>
          </UnifiedBlockNodeSurface>
        );
      }
      case 'frontmatter': {
        const parsed = parseFrontmatter(workingBlock.markdown);
        const baseParsed = unit.baseBlock?.kind === 'frontmatter' ? parseFrontmatter(unit.baseBlock.markdown) : null;
        if (!parsed) {
          return (
            <SourcePreviewBlockEditor
              markdown={workingBlock.markdown}
              notice="Unknown metadata stays block-local source editable."
              onChange={(nextMarkdown) => commitMarkdown(nextMarkdown)}
            />
          );
        }
        const entries = parsed.entries.length > 0 ? parsed.entries : [{ key: '', value: '' }];
        const updateEntries = (nextEntries: Array<{ key: string; value: string }>) => {
          commitMarkdown(serializeFrontmatter(parsed.delimiter, nextEntries));
        };
        const focusFrontmatterCell = (row: number, col: number) => {
          focusBlockActivation(surfaceRef.current, { row, col });
        };
        return (
          <UnifiedBlockNodeSurface active={active} onActivate={canActivate ? handleActivate : undefined} className={previewClassName}>
            <div className="group relative py-1">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      <th className="border border-theme-border/18 px-2 py-1.5 text-left font-medium text-theme-text/56">Key</th>
                      <th className="border border-theme-border/18 px-2 py-1.5 text-left font-medium text-theme-text/56">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry, index) => {
                      const baseEntry = baseParsed?.entries[index];
                      return (
                        <tr key={`${entry.key}-${index}`} className="group/row">
                          <td className={`border border-theme-border/18 px-2 py-1.5 align-top ${fieldChangeClass(baseEntry?.key, entry.key)}`}>
                            <BlockNavTarget row={index} col={0}>
                              <EditablePlainText
                                value={entry.key}
                                active={active}
                                diffBaseValue={renderDiffDecorations ? baseEntry?.key ?? '' : null}
                                showDiffDecorations={renderDiffDecorations}
                                onChange={(nextValue) => {
                                  updateEntries(entries.map((item, itemIndex) => (itemIndex === index ? { ...item, key: nextValue } : item)));
                                }}
                                onKeyDown={(event) => {
                                  if (isKeyboardEventComposing(event)) return;
                                  if (event.key === 'Tab') {
                                    event.preventDefault();
                                    focusFrontmatterCell(index, event.shiftKey ? 0 : 1);
                                  }
                                }}
                                className="min-h-[1.25rem] w-full whitespace-pre-wrap break-words text-sm outline-none"
                                ariaLabel="Metadata key"
                              />
                            </BlockNavTarget>
                          </td>
                          <td className={`border border-theme-border/18 px-2 py-1.5 align-top ${fieldChangeClass(baseEntry?.value, entry.value)}`}>
                            <div className="relative pr-6">
                              <BlockNavTarget row={index} col={1}>
                                <EditablePlainText
                                  value={entry.value}
                                  active={active}
                                  diffBaseValue={renderDiffDecorations ? baseEntry?.value ?? '' : null}
                                  showDiffDecorations={renderDiffDecorations}
                                  onChange={(nextValue) => {
                                    updateEntries(entries.map((item, itemIndex) => (itemIndex === index ? { ...item, value: nextValue } : item)));
                                  }}
                                  onKeyDown={(event) => {
                                    if (isKeyboardEventComposing(event)) return;
                                    if (event.key === 'Tab') {
                                      event.preventDefault();
                                      if (event.shiftKey) {
                                        focusFrontmatterCell(index, 0);
                                        return;
                                      }
                                      if (index === entries.length - 1) {
                                        const nextEntries = [...entries, { key: '', value: '' }];
                                        updateEntries(nextEntries);
                                        scheduleFocusBlockActivation(surfaceRef.current, { row: nextEntries.length - 1, col: 0 });
                                        return;
                                      }
                                      focusFrontmatterCell(index + 1, 0);
                                    }
                                  }}
                                  className="min-h-[1.25rem] w-full whitespace-pre-wrap break-words text-sm outline-none"
                                  ariaLabel="Metadata value"
                                />
                              </BlockNavTarget>
                              {renderDiffDecorations && baseEntry?.value && !entry.value.trim() ? (
                                <RemovedValueBadge value={baseEntry.value} className="mt-1" />
                              ) : null}
                              <button
                                type="button"
                                disabled={!active}
                                onClick={() => {
                                  const nextEntries = entries.filter((_, itemIndex) => itemIndex !== index);
                                  updateEntries(nextEntries.length > 0 ? nextEntries : []);
                                }}
                                className={`absolute right-0 top-1/2 -translate-y-1/2 rounded px-1 text-[11px] text-theme-text/42 transition-opacity hover:bg-theme-text/8 ${
                                  active ? 'opacity-0 group-hover/row:opacity-100' : 'pointer-events-none opacity-0'
                                }`}
                              >
                                ×
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="pointer-events-none absolute right-1 top-1 z-10">
                <button
                  type="button"
                  disabled={!active}
                  aria-label="Add field"
                  onClick={() => {
                    const nextEntries = [...entries, { key: '', value: '' }];
                    updateEntries(nextEntries);
                    scheduleFocusBlockActivation(surfaceRef.current, { row: nextEntries.length - 1, col: 0 });
                  }}
                  className={`pointer-events-auto rounded px-1 py-0.5 text-[10px] font-semibold text-theme-text/34 transition-opacity hover:bg-theme-text/8 ${
                    active ? 'opacity-0 group-hover:opacity-100' : 'pointer-events-none opacity-0'
                  }`}
                >
                  +
                </button>
              </div>
            </div>
          </UnifiedBlockNodeSurface>
        );
      }
      case 'list':
      case 'task_list': {
        if (!canParseList(workingBlock.markdown)) {
          return (
            <InlineRichBlockNodeSurface
              active={active}
              onActivate={canActivate ? handleActivate : undefined}
              className={previewClassName}
              markdown={workingBlock.markdown}
              onChange={commitMarkdown}
              autofocus={!usePreciseInlineFocus}
              inlineDiffBaseMarkdown={inlineDiffBaseMarkdown}
              onViewportChange={onViewportChange}
              availableSessions={availableSessions}
              defaultSessionId={defaultSessionId}
              sourceFile={sourceFile}
              onAddReferenceToSession={onAddReferenceToSession}
              onRunSelectionAction={onRunSelectionAction}
            />
          );
        }
        const parsed = (parseList(workingBlock.markdown).filter(Boolean) as VisualListItem[]) || [];
        const baseParsed = inlineDiffBaseMarkdown ? ((parseList(inlineDiffBaseMarkdown).filter(Boolean) as VisualListItem[]) || []) : [];
        const defaultItem: VisualListItem = {
          indent: 0,
          ordered: false,
          marker: '-' as const,
          checked: workingBlock.kind === 'task_list' ? false : null,
          text: '',
        };
        const items: VisualListItem[] = parsed.length > 0 ? parsed : [defaultItem];
        const commitItems = (nextItems: VisualListItem[]) => {
          commitMarkdown(serializeList(nextItems));
        };
        return (
          <UnifiedBlockNodeSurface active={active} onActivate={canActivate ? handleActivate : undefined} className={previewClassName}>
            <div className="space-y-0.5 py-0.5">
              {items.map((item, index) => {
                const baseItem = baseParsed[index];
                const rowChanged =
                  !baseItem ||
                  baseItem.text !== item.text ||
                  baseItem.checked !== item.checked ||
                  baseItem.ordered !== item.ordered ||
                  baseItem.indent !== item.indent;
                return (
                  <BlockNavTarget
                    key={`list-item-${index}`}
                    row={index}
                    className={`group relative flex items-start gap-2 rounded-sm ${renderDiffDecorations && rowChanged ? listRowDiffClass(baseItem, item) : ''}`}
                  >
                    <button
                      type="button"
                      disabled={!active}
                      aria-label={item.checked === null ? (item.ordered ? 'Switch to bullet list item' : 'Switch to numbered list item') : 'Toggle task completion'}
                      onClick={() => {
                        if (item.checked === null) {
                          commitItems(
                            items.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, ordered: !entry.ordered, marker: (entry.ordered ? '-' : '.') as '-' | '.' }
                                : entry
                            )
                          );
                          return;
                        }
                        commitItems(items.map((entry, entryIndex) => (entryIndex === index ? { ...entry, checked: !entry.checked } : entry)));
                      }}
                      className={`mt-0.5 shrink-0 rounded px-0 text-sm leading-6 text-theme-text/58 ${active ? 'hover:bg-theme-text/8' : 'pointer-events-none'}`}
                      style={{ marginLeft: `${item.indent * 0.55}rem`, minWidth: item.checked === null ? '1.5rem' : '1rem' }}
                    >
                      {item.checked === null ? (
                        listMarkerLabel(items, index)
                      ) : (
                        <span
                          className={`mt-0.5 inline-flex size-4 items-center justify-center rounded border border-theme-border/25 text-[11px] ${
                            item.checked ? 'bg-theme-text text-theme-bg' : 'bg-transparent text-transparent'
                          }`}
                        >
                          ✓
                        </span>
                      )}
                    </button>
                    <div className="min-w-0 flex-1 pr-16">
                      <EditablePlainText
                        value={item.text}
                        active={active}
                        diffBaseValue={renderDiffDecorations ? baseItem?.text ?? '' : null}
                        showDiffDecorations={renderDiffDecorations}
                        onChange={(nextValue) => {
                          commitItems(items.map((entry, entryIndex) => (entryIndex === index ? { ...entry, text: nextValue } : entry)));
                        }}
                        onKeyDown={(event) => {
                          if (isKeyboardEventComposing(event)) return;
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            if (item.text.trim().length === 0) {
                              const nextItems = items.filter((_, itemIndex) => itemIndex !== index);
                              if (nextItems.length > 0) {
                                if (block) {
                                  onReplaceBlockAndInsertEmptyParagraphAfter(block.id, serializeList(nextItems));
                                  return;
                                }
                              } else if (block) {
                                onReplaceBlockWithEmptyParagraph(block.id);
                                return;
                              }
                              return;
                            }
                            const nextItems = [...items];
                            nextItems.splice(index + 1, 0, {
                              indent: item.indent,
                              ordered: item.ordered,
                              marker: item.marker,
                              checked: item.checked === null ? null : false,
                              text: '',
                            });
                            commitItems(nextItems);
                            window.requestAnimationFrame(() => {
                              onSelect({ row: index + 1, col: 0 });
                            });
                            return;
                          }
                          if (event.key === 'Tab') {
                            event.preventDefault();
                            commitItems(
                              items.map((entry, entryIndex) =>
                                entryIndex === index ? { ...entry, indent: Math.max(0, entry.indent + (event.shiftKey ? -2 : 2)) } : entry
                              )
                            );
                            return;
                          }
                          if (event.key === 'Backspace' && item.text.length === 0) {
                            event.preventDefault();
                            const nextItems = items.filter((_, itemIndex) => itemIndex !== index);
                            commitItems(nextItems.length > 0 ? nextItems : [defaultItem]);
                          }
                        }}
                        className="min-h-[1.5rem] w-full whitespace-pre-wrap break-words text-sm leading-6 text-theme-text outline-none"
                        ariaLabel="List item"
                      />
                      {renderDiffDecorations && baseItem?.text && !item.text.trim() ? <RemovedValueBadge value={baseItem.text} className="mt-1" /> : null}
                    </div>
                    <div className={`absolute right-0 top-0 flex h-6 items-center gap-0.5 transition-opacity ${active ? 'opacity-0 group-hover:opacity-100' : 'pointer-events-none opacity-0'}`}>
                      <button
                        type="button"
                        aria-label={item.checked === null ? 'Convert to task item' : 'Convert to bullet item'}
                        disabled={!active}
                        onClick={() => {
                          commitItems(
                            items.map((entry, entryIndex) =>
                              entryIndex === index
                                ? {
                                    ...entry,
                                    checked: entry.checked === null ? false : null,
                                    ordered: entry.checked === null ? false : entry.ordered,
                                    marker: entry.checked === null ? '-' : entry.marker,
                                  }
                                : entry
                            )
                          );
                        }}
                        className="rounded px-1 text-[11px] leading-5 text-theme-text/45 hover:bg-theme-text/8"
                      >
                        {item.checked === null ? '[]' : '•'}
                      </button>
                      <button
                        type="button"
                        aria-label="Insert item below"
                        disabled={!active}
                        onClick={() => {
                          const nextItems = [...items];
                          nextItems.splice(index + 1, 0, {
                            indent: item.indent,
                            ordered: item.ordered,
                            marker: item.marker,
                            checked: item.checked === null ? null : false,
                            text: '',
                          });
                          commitItems(nextItems);
                          window.requestAnimationFrame(() => {
                            onSelect({ row: index + 1, col: 0 });
                          });
                        }}
                        className="rounded px-1 text-[11px] leading-5 text-theme-text/45 hover:bg-theme-text/8"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        aria-label="Remove item"
                        disabled={!active}
                        onClick={() => {
                          const nextItems = items.filter((_, itemIndex) => itemIndex !== index);
                          commitItems(nextItems.length > 0 ? nextItems : [defaultItem]);
                        }}
                        className="rounded px-1 text-[11px] leading-5 text-theme-text/45 hover:bg-theme-text/8"
                      >
                        ×
                      </button>
                    </div>
                  </BlockNavTarget>
                );
              })}
              {renderDiffDecorations && baseParsed.length > items.length ? (
                <div className="space-y-1 pt-1">
                  {baseParsed.slice(items.length).map((item, index) => (
                    <div key={`removed-${index}`} className="pl-2 text-sm text-theme-text/52">
                      <RemovedValueBadge value={`${item.checked === null ? (item.ordered ? '1.' : item.marker) : item.checked ? '[x]' : '[ ]'} ${item.text}`} />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </UnifiedBlockNodeSurface>
        );
      }
      case 'table': {
        const parsed = parseTable(workingBlock.markdown);
        const baseParsed = unit.baseBlock?.kind === 'table' ? parseTable(unit.baseBlock.markdown) : null;
        if (!parsed) {
          return (
            <SourcePreviewBlockEditor
              markdown={workingBlock.markdown}
              notice="Complex tables stay block-local source editable."
              onChange={(nextMarkdown) => commitMarkdown(nextMarkdown)}
            />
          );
        }
        const updateTable = (
          nextHeader: string[],
          nextRows: string[][],
          nextAlignment: Array<'left' | 'center' | 'right' | 'none'> = parsed.alignment
        ) => {
          commitMarkdown(serializeTable(nextHeader, nextRows, nextAlignment));
        };
        const focusTableCell = (row: number, col: number) => focusBlockActivation(surfaceRef.current, { row, col });
        const cellAlignClass = (value: 'left' | 'center' | 'right' | 'none') => {
          if (value === 'center') return 'text-center';
          if (value === 'right') return 'text-right';
          return 'text-left';
        };
        return (
          <UnifiedBlockNodeSurface active={active} onActivate={canActivate ? handleActivate : undefined} className={previewClassName}>
            <div className="group relative py-1">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      {parsed.header.map((cell, cellIndex) => (
                        <th
                          key={`head-${cellIndex}`}
                          className={`border border-theme-border/20 px-2 py-1 align-top font-medium text-theme-text/72 ${cellAlignClass(parsed.alignment[cellIndex] || 'none')} ${fieldChangeClass(baseParsed?.header[cellIndex], cell)}`}
                        >
                          <div className="group/cell relative pr-9">
                            <BlockNavTarget row={0} col={cellIndex} className="min-w-0">
                              <EditablePlainText
                                value={cell}
                                active={active}
                                diffBaseValue={renderDiffDecorations ? baseParsed?.header[cellIndex] ?? '' : null}
                                showDiffDecorations={renderDiffDecorations}
                                onChange={(nextValue) => {
                                  updateTable(
                                    parsed.header.map((value, index) => (index === cellIndex ? nextValue : value)),
                                    parsed.rows,
                                    parsed.alignment
                                  );
                                }}
                                onKeyDown={(event) => {
                                  if (isKeyboardEventComposing(event)) return;
                                  if (event.key === 'Tab') {
                                    event.preventDefault();
                                    if (event.shiftKey && cellIndex > 0) {
                                      focusTableCell(0, cellIndex - 1);
                                      return;
                                    }
                                    if (!event.shiftKey && cellIndex < parsed.header.length - 1) {
                                      focusTableCell(0, cellIndex + 1);
                                      return;
                                    }
                                    focusTableCell(parsed.rows.length > 0 ? 1 : 0, event.shiftKey ? 0 : 0);
                                  }
                                  if (event.key === 'Enter') {
                                    event.preventDefault();
                                  }
                                }}
                                className={`min-h-[1.25rem] w-full whitespace-pre-wrap break-words text-inherit leading-5 outline-none ${cellAlignClass(parsed.alignment[cellIndex] || 'none')}`}
                                ariaLabel={`Table header ${cellIndex + 1}`}
                              />
                            </BlockNavTarget>
                            <div className={`absolute right-0 top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition-opacity ${active ? 'opacity-0 group-hover/cell:opacity-100' : 'pointer-events-none opacity-0'}`}>
                              <button
                                type="button"
                                aria-label={`Cycle alignment for column ${cellIndex + 1}`}
                                disabled={!active}
                                onClick={() => {
                                  updateTable(
                                    parsed.header,
                                    parsed.rows,
                                    parsed.alignment.map((value, index) => (index === cellIndex ? nextAlignmentValue(value) : value))
                                  );
                                }}
                                className="rounded px-1 text-[10px] font-semibold uppercase text-theme-text/38 hover:bg-theme-text/8"
                              >
                                {parsed.alignment[cellIndex] === 'none' ? '-' : parsed.alignment[cellIndex].charAt(0)}
                              </button>
                              <button
                                type="button"
                                aria-label={`Remove column ${cellIndex + 1}`}
                                disabled={!active || parsed.header.length <= 1}
                                onClick={() => {
                                  if (parsed.header.length <= 1) return;
                                  updateTable(
                                    parsed.header.filter((_, index) => index !== cellIndex),
                                    parsed.rows.map((row) => row.filter((_, index) => index !== cellIndex)),
                                    parsed.alignment.filter((_, index) => index !== cellIndex)
                                  );
                                }}
                                className="rounded px-1 text-[11px] text-theme-text/42 hover:bg-theme-text/8 disabled:cursor-not-allowed disabled:opacity-25"
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.rows.map((row, rowIndex) => (
                      <tr key={`row-${rowIndex}`} className="group/row">
                        {row.map((cell, cellIndex) => {
                          const baseCell = baseParsed?.rows[rowIndex]?.[cellIndex];
                          return (
                            <td
                              key={`cell-${rowIndex}-${cellIndex}`}
                              className={`border border-theme-border/20 px-2 py-1 align-top ${cellAlignClass(parsed.alignment[cellIndex] || 'none')} ${fieldChangeClass(baseCell, cell)}`}
                            >
                              <div className={`relative ${cellIndex === row.length - 1 ? 'pr-6' : ''}`}>
                                <BlockNavTarget row={rowIndex + 1} col={cellIndex}>
                                  <EditablePlainText
                                    value={cell}
                                    active={active}
                                    diffBaseValue={renderDiffDecorations ? baseCell ?? '' : null}
                                    showDiffDecorations={renderDiffDecorations}
                                    onChange={(nextValue) => {
                                      updateTable(
                                        parsed.header,
                                        parsed.rows.map((currentRow, currentRowIndex) =>
                                          currentRowIndex === rowIndex
                                            ? currentRow.map((value, currentCellIndex) => (currentCellIndex === cellIndex ? nextValue : value))
                                            : currentRow
                                        ),
                                        parsed.alignment
                                      );
                                    }}
                                    onKeyDown={(event) => {
                                      if (isKeyboardEventComposing(event)) return;
                                      if (event.key === 'Tab') {
                                        event.preventDefault();
                                        const nextCol = cellIndex + (event.shiftKey ? -1 : 1);
                                        const nextRow = rowIndex + 1;
                                        if (nextCol >= 0 && nextCol < row.length) {
                                          focusTableCell(nextRow, nextCol);
                                          return;
                                        }
                                        if (event.shiftKey) {
                                          if (nextRow > 1) {
                                            focusTableCell(nextRow - 1, parsed.header.length - 1);
                                            return;
                                          }
                                          focusTableCell(0, parsed.header.length - 1);
                                          return;
                                        }
                                        if (nextRow < parsed.rows.length) {
                                          focusTableCell(nextRow + 1, 0);
                                          return;
                                        }
                                        const appendedRows = [...parsed.rows, Array.from({ length: parsed.header.length }, () => '')];
                                        updateTable(parsed.header, appendedRows, parsed.alignment);
                                        scheduleFocusBlockActivation(surfaceRef.current, { row: appendedRows.length, col: 0 });
                                      }
                                      if (event.key === 'Enter') {
                                        event.preventDefault();
                                      }
                                    }}
                                    className={`min-h-[1.25rem] w-full whitespace-pre-wrap break-words text-inherit leading-5 outline-none ${cellAlignClass(parsed.alignment[cellIndex] || 'none')}`}
                                    ariaLabel={`Table row ${rowIndex + 1} column ${cellIndex + 1}`}
                                  />
                                </BlockNavTarget>
                                {renderDiffDecorations && baseCell && !cell.trim() ? <RemovedValueBadge value={baseCell} className="mt-1" /> : null}
                                {cellIndex === row.length - 1 ? (
                                  <button
                                    type="button"
                                    aria-label={`Remove row ${rowIndex + 1}`}
                                    disabled={!active}
                                    onClick={() => {
                                      updateTable(parsed.header, parsed.rows.filter((_, index) => index !== rowIndex), parsed.alignment);
                                    }}
                                    className={`absolute right-0 top-1/2 -translate-y-1/2 rounded px-1 text-[11px] text-theme-text/42 transition-opacity hover:bg-theme-text/8 ${
                                      active ? 'opacity-0 group-hover/row:opacity-100' : 'pointer-events-none opacity-0'
                                    }`}
                                  >
                                    ×
                                  </button>
                                ) : null}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="pointer-events-none absolute right-1 top-1 z-10">
                <div className={`pointer-events-auto inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold text-theme-text/38 transition-opacity ${active ? 'opacity-0 group-hover:opacity-100' : 'pointer-events-none opacity-0'}`}>
                  <button
                    type="button"
                    aria-label="Add row"
                    disabled={!active}
                    onClick={() => {
                      const nextRows = [...parsed.rows, Array.from({ length: Math.max(1, parsed.header.length) }, () => '')];
                      updateTable(parsed.header, nextRows, parsed.alignment);
                      scheduleFocusBlockActivation(surfaceRef.current, { row: nextRows.length, col: 0 });
                    }}
                    className="rounded px-1 py-0.5 hover:bg-theme-text/8"
                  >
                    +R
                  </button>
                  <button
                    type="button"
                    aria-label="Add column"
                    disabled={!active}
                    onClick={() => {
                      const nextHeader = [...parsed.header, ''];
                      const nextAlignment = [...parsed.alignment, 'none' as const];
                      const nextRows = parsed.rows.map((row) => [...row, '']);
                      updateTable(nextHeader, nextRows, nextAlignment);
                    }}
                    className="rounded px-1 py-0.5 hover:bg-theme-text/8"
                  >
                    +C
                  </button>
                  <button
                    type="button"
                    aria-label="Remove last row"
                    disabled={!active || parsed.rows.length === 0}
                    onClick={() => {
                      updateTable(parsed.header, parsed.rows.slice(0, -1), parsed.alignment);
                    }}
                    className="rounded px-1 py-0.5 hover:bg-theme-text/8 disabled:cursor-not-allowed disabled:opacity-25"
                  >
                    -R
                  </button>
                  <button
                    type="button"
                    aria-label="Remove last column"
                    disabled={!active || parsed.header.length <= 1}
                    onClick={() => {
                      if (parsed.header.length <= 1) return;
                      updateTable(parsed.header.slice(0, -1), parsed.rows.map((row) => row.slice(0, -1)), parsed.alignment.slice(0, -1));
                    }}
                    className="rounded px-1 py-0.5 hover:bg-theme-text/8 disabled:cursor-not-allowed disabled:opacity-25"
                  >
                    -C
                  </button>
                </div>
              </div>
            </div>
          </UnifiedBlockNodeSurface>
        );
      }
      case 'callout': {
        const parsed = parseCallout(workingBlock.markdown);
        const baseParsed = unit.baseBlock?.kind === 'callout' ? parseCallout(unit.baseBlock.markdown) : null;
        if (!parsed) {
          return (
            <SourcePreviewBlockEditor
              markdown={workingBlock.markdown}
              notice="Unknown callout syntax stays block-local source editable."
              onChange={(nextMarkdown) => commitMarkdown(nextMarkdown)}
            />
          );
        }
        return (
          <UnifiedBlockNodeSurface active={active} onActivate={canActivate ? handleActivate : undefined} className={previewClassName}>
            <div className={`group rounded-xl border px-3 py-2 ${calloutTone(parsed.kind)}`}>
              <div className="mb-2 flex items-start gap-2">
                <BlockNavTarget row={0} col={0} className="shrink-0">
                  <div className={`relative inline-flex items-center rounded-full px-0.5 ${fieldChangeClass(baseParsed?.kind, parsed.kind)}`}>
                    <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-current/72">
                      {renderDiffDecorations
                        ? renderStaticDiffText((baseParsed?.kind ?? '').toUpperCase(), parsed.kind.toUpperCase())
                        : parsed.kind.toUpperCase()}
                    </span>
                    <select
                      aria-label="Callout kind"
                      disabled={!active}
                      value={parsed.kind}
                      onChange={(event) => {
                        commitMarkdown(serializeCallout(event.target.value, parsed.title, parsed.body));
                      }}
                      className={`absolute inset-0 h-full w-full appearance-none border-0 bg-transparent outline-none ${active ? 'cursor-pointer opacity-0' : 'pointer-events-none opacity-0'}`}
                    >
                      {['note', 'tip', 'warning', 'danger', 'success'].map((kind) => (
                        <option key={kind} value={kind}>
                          {kind.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </div>
                </BlockNavTarget>
                {parsed.title.trim() || active ? (
                  <BlockNavTarget row={0} col={1} className="min-w-0 flex-1">
                    <div data-callout-title="true">
                      <EditablePlainText
                        value={parsed.title}
                        active={active}
                        diffBaseValue={renderDiffDecorations ? baseParsed?.title ?? '' : null}
                        showDiffDecorations={renderDiffDecorations}
                        onChange={(nextValue) => {
                          commitMarkdown(serializeCallout(parsed.kind, nextValue, parsed.body));
                        }}
                        className={`min-h-[1.5rem] w-full whitespace-pre-wrap break-words text-sm font-semibold leading-6 outline-none ${fieldChangeClass(baseParsed?.title, parsed.title)}`}
                        ariaLabel="Callout title"
                      />
                    </div>
                  </BlockNavTarget>
                ) : null}
              </div>
              <BlockNavTarget row={1}>
                <InlineRichBlockEditor
                  markdown={parsed.body}
                  editable={active}
                  autofocus={activationFocusRow === 1 || (activationFocusRow === null && activationFocusEdge === null)}
                  inlineDiffBaseMarkdown={inlineDiffBaseMarkdown ? baseParsed?.body ?? '' : null}
                  onChange={(nextBody) => {
                    commitMarkdown(serializeCallout(parsed.kind, parsed.title, nextBody));
                  }}
                  onViewportChange={onViewportChange}
                  availableSessions={availableSessions}
                  defaultSessionId={defaultSessionId}
                  sourceFile={sourceFile}
                  onAddReferenceToSession={onAddReferenceToSession}
                  onRunSelectionAction={onRunSelectionAction}
                />
              </BlockNavTarget>
            </div>
          </UnifiedBlockNodeSurface>
        );
      }
      case 'footnote': {
        const parsed = parseFootnote(workingBlock.markdown);
        const baseParsed = unit.baseBlock?.kind === 'footnote' ? parseFootnote(unit.baseBlock.markdown) : null;
        if (!parsed) {
          return (
            <SourcePreviewBlockEditor
              markdown={workingBlock.markdown}
              notice="Complex footnotes stay block-local source editable."
              onChange={(nextMarkdown) => commitMarkdown(nextMarkdown)}
            />
          );
        }
        return (
          <UnifiedBlockNodeSurface active={active} onActivate={canActivate ? handleActivate : undefined} className={previewClassName}>
            <div className="rounded-xl border border-theme-border/16 bg-theme-surface/6 px-4 py-3">
              <div className="space-y-2">
                <BlockNavTarget row={0}>
                  <div data-footnote-preview-row="0" className="inline-flex items-center rounded-full bg-theme-text/8 px-2.5 py-1 text-[11px] font-semibold text-theme-text/66">
                    <span className="shrink-0">[^</span>
                    <EditablePlainText
                      as="span"
                      value={parsed.identifier}
                      active={active}
                      diffBaseValue={renderDiffDecorations ? baseParsed?.identifier ?? '' : null}
                      showDiffDecorations={renderDiffDecorations}
                      onChange={(nextIdentifier) => {
                        if (!block) return;
                        const updatedContent = draftContent.split(`[^${parsed.identifier}]`).join(`[^${nextIdentifier}]`);
                        const reparsedBlock =
                          parseMarkdownDocument(updatedContent).blocks.find((item) => item.id === block.id) || block;
                        onChangeContent(replaceMarkdownBlock(updatedContent, reparsedBlock, serializeFootnote(nextIdentifier, parsed.body)));
                      }}
                      className={`min-w-[1ch] whitespace-pre-wrap break-words outline-none ${fieldChangeClass(baseParsed?.identifier, parsed.identifier)}`}
                      ariaLabel="Footnote identifier"
                    />
                    <span className="shrink-0">]</span>
                  </div>
                </BlockNavTarget>
                <div data-footnote-preview-row="1">
                  <BlockNavTarget row={1}>
                    <InlineRichBlockEditor
                      markdown={parsed.body}
                      editable={active}
                      autofocus={activationFocusRow === 1 || (activationFocusRow === null && activationFocusEdge === null)}
                      inlineDiffBaseMarkdown={inlineDiffBaseMarkdown ? baseParsed?.body ?? '' : null}
                      onChange={(nextBody) => {
                        commitMarkdown(serializeFootnote(parsed.identifier, nextBody));
                      }}
                      onViewportChange={onViewportChange}
                      availableSessions={availableSessions}
                      defaultSessionId={defaultSessionId}
                      sourceFile={sourceFile}
                      onAddReferenceToSession={onAddReferenceToSession}
                      onRunSelectionAction={onRunSelectionAction}
                    />
                  </BlockNavTarget>
                </div>
              </div>
            </div>
          </UnifiedBlockNodeSurface>
        );
      }
      case 'thematic_break':
        return (
          <UnifiedBlockNodeSurface active={active} onActivate={canActivate ? handleActivate : undefined} className={previewClassName}>
            <div className="group flex items-center gap-3 py-2">
              <hr className="flex-1 border-0 border-t border-dashed border-theme-border/35" />
              <button
                type="button"
                aria-label="Remove divider"
                disabled={!active}
                onClick={() => {
                  commitMarkdown('');
                }}
                className={`rounded px-1 text-[11px] text-theme-text/45 transition-opacity hover:bg-theme-text/8 ${
                  active ? 'opacity-0 group-hover:opacity-100' : 'pointer-events-none opacity-0'
                }`}
              >
                ×
              </button>
            </div>
          </UnifiedBlockNodeSurface>
        );
      default:
        return (
          <InlineRichBlockNodeSurface
            active={active}
            onActivate={canActivate ? handleActivate : undefined}
            className={previewClassName}
            markdown={workingBlock.markdown}
            onChange={commitMarkdown}
            autofocus={!usePreciseInlineFocus}
            inlineDiffBaseMarkdown={inlineDiffBaseMarkdown}
            onViewportChange={onViewportChange}
            availableSessions={availableSessions}
            defaultSessionId={defaultSessionId}
            sourceFile={sourceFile}
            onAddReferenceToSession={onAddReferenceToSession}
            onRunSelectionAction={onRunSelectionAction}
          />
        );
    }
  };

  const handleActivate = (event?: React.MouseEvent<HTMLDivElement>) => {
    if (!canActivate) return;
    event?.preventDefault();
    onSelect(
      resolvePreviewActivationRequest(
        previewBlock.kind,
        event?.currentTarget || null,
        event?.target as HTMLElement | null,
        previewBlock.markdown,
        event ? { x: event.clientX, y: event.clientY } : null
      )
    );
  };

  const handleActiveKeyDownCapture = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      active &&
      event.key === 'Enter' &&
      !event.defaultPrevented &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      block &&
      shouldCreateParagraphAfterEnter(previewBlock.kind, event.target as HTMLElement | null)
    ) {
      event.preventDefault();
      onRequestParagraphInsertionAfterBlock(block.id);
      return;
    }

    const direction = resolveArrowDirection(event.key);
    if (!active || !direction || event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!shouldExitEditorOnArrowBoundary(event.target as HTMLElement | null, direction)) return;
    const internalTarget = findInternalNavigationTarget(surfaceRef.current, event.target as HTMLElement | null, direction);
    if (internalTarget) {
      event.preventDefault();
      focusCaretTarget(internalTarget, direction === 'up' ? 'end' : 'start');
      return;
    }
    event.preventDefault();
    onBoundaryNavigate(direction);
  };

  const usesUnifiedOrdinaryRenderer = canActivate && !distinctEditorChrome && previewBlock.kind !== 'unknown';
  const shouldRenderDiffPreview = renderDiffDecorations && unit.status !== 'equal' && (!canActivate || distinctEditorChrome);

  return (
    <div
      ref={surfaceRef}
      data-block-id={previewBlock.id}
      data-block-kind={previewBlock.kind}
      data-block-status={unit.status}
      data-block-editor-chrome={distinctEditorChrome ? 'distinct' : 'inline'}
      className={surfaceClassName}
      style={surfaceStyle}
      onKeyDownCapture={active ? handleActiveKeyDownCapture : undefined}
    >
      {usesUnifiedOrdinaryRenderer ? renderUnifiedOrdinaryBlock() : active ? renderDistinctEditor() : (
        <div
          data-block-render-surface="true"
          onMouseDown={canActivate ? handleActivate : undefined}
          className={previewClassName}
        >
          {shouldRenderDiffPreview ? (
            <MarkdownDiffPreview unit={unit} fullDocumentContent={previewContextContent} />
          ) : previewBlock.activeEditorKind === 'mermaid' ? (
            <MermaidBlockPreview markdown={previewMarkdown} />
          ) : previewBlock.kind === 'image' ? (
            <ImageBlockPreview markdown={previewMarkdown} />
          ) : previewBlock.kind === 'footnote' ? (
            <FootnoteBlockPreview markdown={previewMarkdown} />
          ) : (
            <MarkdownContent
              content={previewMarkdown}
              className="[&_p]:my-2 [&_blockquote]:my-2 [&_pre]:my-2"
              hideFootnotesSection
            />
          )}
        </div>
      )}
    </div>
  );
}

export function MarkdownDocumentEditor({
  fileId,
  fileName,
  content,
  baseContent,
  pendingDiffEvent: _pendingDiffEvent = null,
  pendingDiffLoading: _pendingDiffLoading = false,
  onChange,
  onViewportChange,
  availableSessions = [],
  defaultSessionId,
  sourceFile,
  onAddReferenceToSession,
  onRunSelectionAction,
}: MarkdownDocumentEditorProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const emptyParagraphDraftTimersRef = useRef(new Map<string, number>());
  const pendingInsertionActivationRef = useRef<{
    insertedBlockStartOffset: number;
    edge: BlockActivationEdge;
  } | null>(null);
  const pendingEmptyParagraphActivationRef = useRef<string | null>(null);
  const pendingBlockActivationRef = useRef<{ blockId: string; edge: BlockActivationEdge } | null>(null);
  const activationSequenceRef = useRef(0);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [emptyParagraphDrafts, setEmptyParagraphDrafts] = useState<Record<string, string>>({});
  const [activationState, setActivationState] = useState<{
    blockId: string;
    edge: BlockActivationEdge | null;
    row: number | null;
    col: number | null;
    point: BlockActivationPoint | null;
    textOffset: number | null;
    key: number;
  } | null>(null);
  const hasPendingDiff = Boolean(_pendingDiffEvent);
  const emptyParagraphDraftsRef = useRef<Record<string, string>>({});
  const visualUnitsRef = useRef<MarkdownVisualUnit[]>([]);

  const parsedDraft = useMemo(() => parseMarkdownDocument(content), [content]);
  const visualUnits = useMemo(() => buildMarkdownVisualUnits(parsedDraft), [parsedDraft]);
  const diffUnits = useMemo(() => buildMarkdownDiffUnits(baseContent, content), [baseContent, content]);
  const visibleUnitCount = useMemo(() => visualUnits.length, [visualUnits]);
  const draftDiffUnitByBlockId = useMemo(() => {
    const next = new Map<string, MarkdownDiffUnit>();
    diffUnits.forEach((unit) => {
      if (unit.draftBlock) {
        next.set(unit.draftBlock.id, unit);
      }
    });
    return next;
  }, [diffUnits]);
  const removedDiffUnitsByAnchorId = useMemo(() => {
    const next = new Map<string | null, MarkdownDiffUnit[]>();
    diffUnits.forEach((unit) => {
      if (unit.status !== 'removed') return;
      const anchorId = unit.insertBeforeDraftBlockId ?? null;
      const bucket = next.get(anchorId) || [];
      bucket.push(unit);
      next.set(anchorId, bucket);
    });
    return next;
  }, [diffUnits]);

  const pendingInsertionActivationTarget = useMemo(() => {
    const pending = pendingInsertionActivationRef.current;
    if (!pending) return null;
    const block =
      parsedDraft.blocks.find((item) => item.startOffset === pending.insertedBlockStartOffset) ||
      parsedDraft.blocks.find(
        (item) => item.startOffset <= pending.insertedBlockStartOffset && item.endOffset >= pending.insertedBlockStartOffset
      ) ||
      parsedDraft.blocks[parsedDraft.blocks.length - 1];
    if (!block) return null;
    return {
      blockId: block.id,
      edge: pending.edge,
      row: null,
      col: null,
      point: null,
      textOffset: null,
      key: activationSequenceRef.current + 1,
    };
  }, [parsedDraft.blocks]);

  const pendingEmptyParagraphActivationTarget = useMemo(() => {
    const pending = pendingEmptyParagraphActivationRef.current;
    if (!pending || !visualUnits.some((unit) => unit.id === pending)) return null;
    return {
      blockId: pending,
      edge: 'start' as const,
      row: null,
      col: null,
      point: null,
      textOffset: null,
      key: activationSequenceRef.current + 1,
    };
  }, [visualUnits]);

  const pendingBlockActivationTarget = useMemo(() => {
    const pending = pendingBlockActivationRef.current;
    if (!pending || !parsedDraft.blocks.some((block) => block.id === pending.blockId)) return null;
    return {
      blockId: pending.blockId,
      edge: pending.edge,
      row: null,
      col: null,
      point: null,
      textOffset: null,
      key: activationSequenceRef.current + 1,
    };
  }, [parsedDraft.blocks]);

  const effectiveActivationState = useMemo(() => {
    if (activationState && visualUnits.some((unit) => unit.id === activationState.blockId)) {
      return activationState;
    }
    return pendingEmptyParagraphActivationTarget || pendingInsertionActivationTarget || pendingBlockActivationTarget;
  }, [activationState, pendingBlockActivationTarget, pendingEmptyParagraphActivationTarget, pendingInsertionActivationTarget, visualUnits]);

  const effectiveActiveBlockId = effectiveActivationState?.blockId || null;

  useEffect(() => {
    emptyParagraphDraftsRef.current = emptyParagraphDrafts;
  }, [emptyParagraphDrafts]);

  useEffect(() => {
    visualUnitsRef.current = visualUnits;
  }, [visualUnits]);

  useEffect(() => {
    if (!activeBlockId) return;
    if (!visualUnits.some((unit) => unit.id === activeBlockId)) {
      setActivationState(null);
      setActiveBlockId(null);
    }
  }, [activeBlockId, visualUnits]);

  useEffect(() => {
    pendingInsertionActivationRef.current = null;
    pendingEmptyParagraphActivationRef.current = null;
    pendingBlockActivationRef.current = null;
    emptyParagraphDraftTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    emptyParagraphDraftTimersRef.current.clear();
    setEmptyParagraphDrafts({});
    setActivationState(null);
    setActiveBlockId(null);
  }, [fileId]);

  useEffect(() => {
    return () => {
      emptyParagraphDraftTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      emptyParagraphDraftTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const activeUnitIds = new Set(
      visualUnits.filter((unit): unit is EmptyParagraphLineUnit => unit.kind === 'empty_paragraph_line').map((unit) => unit.id)
    );
    setEmptyParagraphDrafts((previous) => {
      let changed = false;
      const next: Record<string, string> = {};
      Object.entries(previous).forEach(([unitId, markdown]) => {
        if (activeUnitIds.has(unitId)) {
          next[unitId] = markdown;
          return;
        }
        const timerId = emptyParagraphDraftTimersRef.current.get(unitId);
        if (timerId) {
          window.clearTimeout(timerId);
          emptyParagraphDraftTimersRef.current.delete(unitId);
        }
        changed = true;
      });
      return changed ? next : previous;
    });
  }, [visualUnits]);

  const activateBlock = (blockId: string, request: BlockActivationRequest = {}) => {
    activationSequenceRef.current += 1;
    setActivationState({
      blockId,
      edge: request.edge ?? null,
      row: request.row ?? null,
      col: request.col ?? null,
      point: request.point ?? null,
      textOffset: request.textOffset ?? null,
      key: activationSequenceRef.current,
    });
    setActiveBlockId(blockId);
  };

  useEffect(() => {
    const pending = pendingInsertionActivationRef.current;
    if (!pending) return;
    const targetBlock =
      parsedDraft.blocks.find((block) => block.startOffset === pending.insertedBlockStartOffset) ||
      parsedDraft.blocks.find(
        (block) => block.startOffset <= pending.insertedBlockStartOffset && block.endOffset >= pending.insertedBlockStartOffset
      ) ||
      parsedDraft.blocks[parsedDraft.blocks.length - 1];
    if (!targetBlock) return;
    pendingInsertionActivationRef.current = null;
    activateBlock(targetBlock.id, { edge: pending.edge });
  }, [parsedDraft.blocks]);

  useEffect(() => {
    const pending = pendingEmptyParagraphActivationRef.current;
    if (!pending) return;
    if (!visualUnits.some((unit) => unit.id === pending)) return;
    pendingEmptyParagraphActivationRef.current = null;
    activateBlock(pending, { edge: 'start' });
  }, [visualUnits]);

  useEffect(() => {
    const pending = pendingBlockActivationRef.current;
    if (!pending) return;
    if (!parsedDraft.blocks.some((block) => block.id === pending.blockId)) return;
    pendingBlockActivationRef.current = null;
    activateBlock(pending.blockId, { edge: pending.edge });
  }, [parsedDraft.blocks]);

  useEffect(() => {
    if (!activeBlockId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActivationState(null);
        setActiveBlockId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeBlockId]);

  useEffect(() => {
    if (!wrapperRef.current || !onViewportChange) return;
    const wrapper = wrapperRef.current;
    const emitViewport = () => {
      const scrollTop = wrapper.scrollTop || 0;
      const scrollHeight = Math.max(wrapper.scrollHeight, wrapper.clientHeight, 1);
      const totalLines = Math.max(1, content.split('\n').length);
      const maxScrollable = Math.max(1, scrollHeight - wrapper.clientHeight);
      const startRatio = Math.max(0, Math.min(1, scrollTop / maxScrollable));
      const visibleRatio = Math.max(0.02, Math.min(1, wrapper.clientHeight / scrollHeight));
      const visibleStart = Math.max(1, Math.floor(startRatio * totalLines));
      const visibleEnd = Math.min(totalLines, visibleStart + Math.max(1, Math.ceil(visibleRatio * totalLines)));
      onViewportChange({
        scrollTop,
        scrollHeight,
        visibleUnit: 'line',
        visibleStart,
        visibleEnd,
      });
    };

    emitViewport();
    wrapper.addEventListener('scroll', emitViewport, { passive: true });
    window.addEventListener('resize', emitViewport);
    return () => {
      wrapper.removeEventListener('scroll', emitViewport);
      window.removeEventListener('resize', emitViewport);
    };
  }, [content, onViewportChange]);

  const sourceDescriptor = sourceFile || { id: fileId, name: fileName };

  const requestEmptyParagraphBeforeBlock = (beforeBlockId: string) => {
    const next = insertEmptyParagraphBeforeBlock(content, parsedDraft, beforeBlockId);
    if (!next) return;
    pendingInsertionActivationRef.current = null;
    pendingEmptyParagraphActivationRef.current = next.insertedUnitId;
    onChange(next.content);
  };

  const requestEmptyParagraphAfterBlock = (blockId: string) => {
    const next = insertEmptyParagraphAfterBlock(content, parsedDraft, blockId);
    if (!next) return;
    pendingInsertionActivationRef.current = null;
    pendingEmptyParagraphActivationRef.current = next.insertedUnitId;
    onChange(next.content);
  };

  const requestEmptyParagraphAtDocumentEnd = () => {
    const next = insertEmptyParagraphAtEnd(content);
    pendingInsertionActivationRef.current = null;
    pendingEmptyParagraphActivationRef.current = next.insertedUnitId;
    onChange(next.content);
  };

  const replaceBlockWithEmptyParagraph = (blockId: string) => {
    const blockIndex = parsedDraft.blocks.findIndex((block) => block.id === blockId);
    if (blockIndex === -1) return;
    const block = parsedDraft.blocks[blockIndex];
    const nextBlock = parsedDraft.blocks[blockIndex + 1] || null;
    const contentWithoutBlock = removeMarkdownBlock(content, block);

    if (!nextBlock) {
      pendingInsertionActivationRef.current = null;
      pendingEmptyParagraphActivationRef.current = `empty-paragraph:${contentWithoutBlock.length}`;
      onChange(`${contentWithoutBlock}\n`);
      return;
    }

    const removedLength = block.endOffset - block.leadingStartOffset;
    const insertionOffset = nextBlock.startOffset - removedLength;
    const newlineCount = (nextBlock.leading.match(/\n/g) || []).length;
    const insertCount = Math.max(1, 3 - newlineCount);
    pendingInsertionActivationRef.current = null;
    pendingEmptyParagraphActivationRef.current = `empty-paragraph:${insertionOffset + insertCount - 1}`;
    onChange(
      `${contentWithoutBlock.slice(0, insertionOffset)}${'\n'.repeat(insertCount)}${contentWithoutBlock.slice(insertionOffset)}`
    );
  };

  const replaceBlockAndInsertEmptyParagraphAfter = (blockId: string, markdown: string) => {
    const block = parsedDraft.blocks.find((item) => item.id === blockId);
    if (!block) return;
    const updatedContent = replaceMarkdownBlock(content, block, markdown);
    const reparsed = parseMarkdownDocument(updatedContent);
    const next = insertEmptyParagraphAfterBlock(updatedContent, reparsed, blockId);
    if (!next) {
      onChange(updatedContent);
      return;
    }
    pendingInsertionActivationRef.current = null;
    pendingEmptyParagraphActivationRef.current = next.insertedUnitId;
    onChange(next.content);
  };

  const moveActivationFromUnit = (unitId: string, direction: BlockFocusDirection) => {
    const currentIndex = visualUnits.findIndex((unit) => unit.id === unitId);
    if (currentIndex === -1) return;
    const neighbor = direction === 'down' ? visualUnits[currentIndex + 1] : visualUnits[currentIndex - 1];
    if (neighbor) {
      activateBlock(neighbor.id, { edge: direction === 'down' ? 'start' : 'end' });
      return;
    }
    if (direction === 'down') {
      requestEmptyParagraphAtDocumentEnd();
      return;
    }
    setActivationState(null);
    setActiveBlockId(null);
  };

  const materializeEmptyParagraph = (unit: EmptyParagraphLineUnit, nextMarkdown: string) => {
    if (!nextMarkdown.trim()) return;
    const next = materializeEmptyParagraphLine(content, unit, nextMarkdown);
    pendingEmptyParagraphActivationRef.current = null;
    pendingInsertionActivationRef.current = {
      insertedBlockStartOffset: next.insertedBlockStartOffset,
      edge: 'end',
    };
    onChange(next.content);
  };

  const flushEmptyParagraphDraft = (unitId: string) => {
    const timerId = emptyParagraphDraftTimersRef.current.get(unitId);
    if (timerId) {
      window.clearTimeout(timerId);
      emptyParagraphDraftTimersRef.current.delete(unitId);
    }

    const draftMarkdown = emptyParagraphDraftsRef.current[unitId] ?? '';
    if (!draftMarkdown.trim()) {
      setEmptyParagraphDrafts((previous) => {
        if (!(unitId in previous)) return previous;
        const next = { ...previous };
        delete next[unitId];
        return next;
      });
      return;
    }

    const unit = visualUnitsRef.current.find(
      (candidate): candidate is EmptyParagraphLineUnit => candidate.kind === 'empty_paragraph_line' && candidate.id === unitId
    );
    if (!unit) {
      setEmptyParagraphDrafts((previous) => {
        if (!(unitId in previous)) return previous;
        const next = { ...previous };
        delete next[unitId];
        return next;
      });
      return;
    }

    setEmptyParagraphDrafts((previous) => {
      if (!(unitId in previous)) return previous;
      const next = { ...previous };
      delete next[unitId];
      return next;
    });
    materializeEmptyParagraph(unit, draftMarkdown);
  };

  const updateEmptyParagraphDraft = (unit: EmptyParagraphLineUnit, nextMarkdown: string) => {
    const normalized = nextMarkdown.replace(/\r/g, '');
    setEmptyParagraphDrafts((previous) => {
      if (!normalized) {
        if (!(unit.id in previous)) return previous;
        const next = { ...previous };
        delete next[unit.id];
        return next;
      }
      if (previous[unit.id] === normalized) return previous;
      return {
        ...previous,
        [unit.id]: normalized,
      };
    });

    const existingTimer = emptyParagraphDraftTimersRef.current.get(unit.id);
    if (existingTimer) {
      window.clearTimeout(existingTimer);
      emptyParagraphDraftTimersRef.current.delete(unit.id);
    }

    if (!normalized.trim()) return;

    const timerId = window.setTimeout(() => {
      flushEmptyParagraphDraft(unit.id);
    }, 600);
    emptyParagraphDraftTimersRef.current.set(unit.id, timerId);
  };

  const removeEmptyParagraphUnit = (unit: EmptyParagraphLineUnit) => {
    const nextContent = removeEmptyParagraphLine(content, unit);
    pendingInsertionActivationRef.current = null;
    pendingEmptyParagraphActivationRef.current = null;
    const timerId = emptyParagraphDraftTimersRef.current.get(unit.id);
    if (timerId) {
      window.clearTimeout(timerId);
      emptyParagraphDraftTimersRef.current.delete(unit.id);
    }
    setEmptyParagraphDrafts((previous) => {
      if (!(unit.id in previous)) return previous;
      const next = { ...previous };
      delete next[unit.id];
      return next;
    });
    if (unit.slotIndex > 0) {
      pendingEmptyParagraphActivationRef.current = `empty-paragraph:${unit.slotOffset - 1}`;
    } else if (unit.slotIndex < unit.totalSlots - 1) {
      pendingEmptyParagraphActivationRef.current = `empty-paragraph:${unit.slotOffset}`;
    } else if (unit.beforeBlockId) {
      pendingBlockActivationRef.current = { blockId: unit.beforeBlockId, edge: 'end' };
    } else if (unit.afterBlockId) {
      pendingBlockActivationRef.current = { blockId: unit.afterBlockId, edge: 'start' };
    } else {
      pendingBlockActivationRef.current = null;
      setActivationState(null);
      setActiveBlockId(null);
    }
    onChange(nextContent);
  };

  const handleEmptyParagraphKeyDownCapture = (unit: EmptyParagraphLineUnit, event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (event.key === 'Backspace' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      const raw = (target?.textContent || '').replace(/\u00a0/g, '').trim();
      if (raw.length === 0) {
        event.preventDefault();
        removeEmptyParagraphUnit(unit);
        return;
      }
    }
    const direction = resolveArrowDirection(event.key);
    if (!direction) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!shouldExitEditorOnArrowBoundary(target, direction)) return;
    event.preventDefault();
    moveActivationFromUnit(unit.id, direction);
  };

  const handleTrailingHitboxKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const direction = resolveArrowDirection(event.key);
    const lastVisualUnit = visualUnits[visualUnits.length - 1];
    if (direction === 'up' && lastVisualUnit) {
      event.preventDefault();
      activateBlock(lastVisualUnit.id, { edge: 'end' });
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    requestEmptyParagraphAtDocumentEnd();
  };

  const handleScrollMouseDownCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (
      target.closest('[data-block-id]') ||
      target.closest('[data-empty-paragraph-id]') ||
      target.closest('[data-testid="markdown-trailing-hitbox"]')
    ) {
      return;
    }
    pendingInsertionActivationRef.current = null;
    pendingEmptyParagraphActivationRef.current = null;
    pendingBlockActivationRef.current = null;
    setActivationState(null);
    setActiveBlockId(null);
  };

  const removedUnitsBeforeBlock = (blockId: string) => removedDiffUnitsByAnchorId.get(blockId) || [];
  const trailingRemovedUnits = removedDiffUnitsByAnchorId.get(null) || [];

  return (
    <div className="flex h-full min-h-0 min-w-0 bg-theme-bg" data-testid="markdown-document-editor">
      <section className="min-w-0 flex-1 bg-theme-bg">
        <div
          ref={wrapperRef}
          className="h-full min-h-0 overflow-auto px-4 py-4"
          data-testid="markdown-document-scroll"
          onMouseDownCapture={handleScrollMouseDownCapture}
        >
          <div data-testid="markdown-block-editor" className="flex flex-col gap-0 pb-8">
            {visualUnits.map((visualUnit) => {
              if (visualUnit.kind === 'empty_paragraph_line') {
                return (
                  <EmptyParagraphLineSurface
                    key={visualUnit.id}
                    unit={visualUnit}
                    active={effectiveActiveBlockId === visualUnit.id}
                    markdown={emptyParagraphDrafts[visualUnit.id] ?? ''}
                    onActivate={(event) => {
                      event.preventDefault();
                      activateBlock(visualUnit.id, { edge: 'start' });
                    }}
                    onChangeContent={(nextMarkdown) => updateEmptyParagraphDraft(visualUnit, nextMarkdown)}
                    onBlur={() => flushEmptyParagraphDraft(visualUnit.id)}
                    onKeyDownCapture={(event) => handleEmptyParagraphKeyDownCapture(visualUnit, event)}
                    onViewportChange={onViewportChange}
                    availableSessions={availableSessions}
                    defaultSessionId={defaultSessionId}
                    sourceFile={sourceDescriptor}
                    onAddReferenceToSession={onAddReferenceToSession}
                    onRunSelectionAction={onRunSelectionAction}
                  />
                );
              }

              const block = visualUnit.block;
              const unit = draftDiffUnitByBlockId.get(block.id);
              const removedUnits = removedUnitsBeforeBlock(block.id);
              return (
                <div key={block.id}>
                  <InterBlockInsertHandle onInsert={() => requestEmptyParagraphBeforeBlock(block.id)} />
                  {removedUnits.map((removedUnit) => (
                    <MarkdownBlockSurface
                      key={removedUnit.id}
                      unit={removedUnit}
                      active={false}
                      draftContent={content}
                      baseContent={baseContent}
                      showInlineDiffDecorations={hasPendingDiff}
                      onBoundaryNavigate={() => {}}
                      activationFocusEdge={null}
                      activationFocusRow={null}
                      activationFocusCol={null}
                      activationFocusPoint={null}
                      activationFocusTextOffset={null}
                      activationFocusKey={0}
                      onSelect={() => {}}
                      onReplaceBlockAndInsertEmptyParagraphAfter={() => {}}
                      onReplaceBlockWithEmptyParagraph={() => {}}
                      onRequestParagraphInsertionAfterBlock={() => {}}
                      onChangeContent={onChange}
                      onViewportChange={onViewportChange}
                      availableSessions={availableSessions}
                      defaultSessionId={defaultSessionId}
                      sourceFile={sourceDescriptor}
                      onAddReferenceToSession={onAddReferenceToSession}
                      onRunSelectionAction={onRunSelectionAction}
                    />
                  ))}
                  {unit ? (
                    <MarkdownBlockSurface
                      unit={unit}
                      active={block.id === effectiveActiveBlockId}
                      draftContent={content}
                      baseContent={baseContent}
                      showInlineDiffDecorations={hasPendingDiff}
                      onBoundaryNavigate={(direction) => {
                        moveActivationFromUnit(block.id, direction);
                      }}
                      activationFocusEdge={
                        effectiveActivationState && effectiveActivationState.blockId === block.id ? effectiveActivationState.edge : null
                      }
                      activationFocusRow={
                        effectiveActivationState && effectiveActivationState.blockId === block.id ? effectiveActivationState.row : null
                      }
                      activationFocusCol={
                        effectiveActivationState && effectiveActivationState.blockId === block.id ? effectiveActivationState.col : null
                      }
                      activationFocusPoint={
                        effectiveActivationState && effectiveActivationState.blockId === block.id ? effectiveActivationState.point : null
                      }
                      activationFocusTextOffset={
                        effectiveActivationState && effectiveActivationState.blockId === block.id ? effectiveActivationState.textOffset : null
                      }
                      activationFocusKey={
                        effectiveActivationState && effectiveActivationState.blockId === block.id ? effectiveActivationState.key : 0
                      }
                      onSelect={(request) => {
                        if (effectiveActiveBlockId === block.id) {
                          if (
                            request &&
                            (request.edge !== undefined ||
                              request.row !== undefined ||
                              request.col !== undefined ||
                              request.point !== undefined)
                          ) {
                            activateBlock(block.id, request);
                            return;
                          }
                          setActivationState(null);
                          setActiveBlockId(null);
                          return;
                        }
                        activateBlock(block.id, request || {});
                      }}
                      onReplaceBlockAndInsertEmptyParagraphAfter={replaceBlockAndInsertEmptyParagraphAfter}
                      onReplaceBlockWithEmptyParagraph={replaceBlockWithEmptyParagraph}
                      onRequestParagraphInsertionAfterBlock={requestEmptyParagraphAfterBlock}
                      onChangeContent={onChange}
                      onViewportChange={onViewportChange}
                      availableSessions={availableSessions}
                      defaultSessionId={defaultSessionId}
                      sourceFile={sourceDescriptor}
                      onAddReferenceToSession={onAddReferenceToSession}
                      onRunSelectionAction={onRunSelectionAction}
                    />
                  ) : null}
                </div>
              );
            })}
            {trailingRemovedUnits.map((removedUnit) => (
              <MarkdownBlockSurface
                key={removedUnit.id}
                unit={removedUnit}
                active={false}
                draftContent={content}
                baseContent={baseContent}
                showInlineDiffDecorations={hasPendingDiff}
                onBoundaryNavigate={() => {}}
                activationFocusEdge={null}
                activationFocusRow={null}
                activationFocusCol={null}
                activationFocusPoint={null}
                activationFocusTextOffset={null}
                activationFocusKey={0}
                onSelect={() => {}}
                onReplaceBlockAndInsertEmptyParagraphAfter={() => {}}
                onReplaceBlockWithEmptyParagraph={() => {}}
                onRequestParagraphInsertionAfterBlock={() => {}}
                onChangeContent={onChange}
                onViewportChange={onViewportChange}
                availableSessions={availableSessions}
                defaultSessionId={defaultSessionId}
                sourceFile={sourceDescriptor}
                onAddReferenceToSession={onAddReferenceToSession}
                onRunSelectionAction={onRunSelectionAction}
              />
            ))}
            <button
              type="button"
              data-testid="markdown-trailing-hitbox"
              onClick={requestEmptyParagraphAtDocumentEnd}
              onKeyDown={handleTrailingHitboxKeyDown}
              className={[
                'mt-2 min-h-[120px] w-full rounded-xl border border-dashed border-transparent px-3 py-4 text-left outline-none transition-colors',
                'hover:border-theme-border/18 hover:bg-theme-surface/5 focus:border-theme-border/24 focus:bg-theme-surface/6',
                visibleUnitCount === 0 ? 'flex items-center justify-center text-center' : '',
              ].join(' ')}
            >
              <span className="text-sm text-theme-text/38">
                {visibleUnitCount === 0 ? 'Click anywhere below to start writing.' : 'Click the blank space below to continue writing.'}
              </span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
