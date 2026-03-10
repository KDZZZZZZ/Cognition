import type { Content, Root } from 'mdast';
import type { DiffRenderRow } from '../diffRows';
import {
  classifyMarkdownNode,
  detectMarkdownCallout,
  parseMarkdownRoot,
} from '../markdownDocument';
import type { DiffBlock, DiffBlockKind, DiffCalloutMeta } from './types';
import { buildReviewUnits } from './buildReviewUnits';

function parseRoot(content: string): Root | null {
  return parseMarkdownRoot(content);
}

function reviewTextForRow(row: DiffRenderRow) {
  return row.newText ?? row.oldText ?? '';
}

function hasPosition(node: Content) {
  return Boolean(node.position?.start.line && node.position?.end.line);
}

function isBlankBlockText(text: string) {
  return text.trim().length === 0;
}

function contentFromRows(rows: DiffRenderRow[], side: 'old' | 'new') {
  return rows
    .map((row) => (side === 'old' ? row.oldText : row.newText))
    .filter((line): line is string => line !== null)
    .join('\n');
}

function rowsForNodeRange(rows: DiffRenderRow[], node: Content, side: 'old' | 'new') {
  const startLine = node.position?.start.line;
  const endLine = node.position?.end.line;
  if (!startLine || !endLine) return [];

  return rows.filter((row) => {
    const lineNumber = side === 'old' ? row.oldLineNumber : row.newLineNumber;
    return lineNumber !== null && lineNumber >= startLine && lineNumber <= endLine;
  });
}

function pickPrimaryNode(root: Root | null): Content | null {
  if (!root || root.children.length === 0) return null;
  return (root.children.find((child) => child.type !== 'definition') || root.children[0]) as Content;
}

function detectCallout(node: Content | null): DiffCalloutMeta | null {
  return detectMarkdownCallout(node);
}

function classifyNode(node: Content | null, markdown: string): DiffBlockKind {
  if (!node) return 'blank';
  if (node.type === 'code' && (node as any).lang === 'mermaid') {
    return 'mermaid';
  }

  const kind = classifyMarkdownNode(node, markdown);
  if (kind === 'image') {
    return 'paragraph';
  }
  return kind as DiffBlockKind;
}

function isStructuralChange(oldNode: Content | null, newNode: Content | null) {
  if (!oldNode || !newNode) return false;
  if (oldNode.type !== newNode.type) return true;
  if (oldNode.type === 'heading' && (oldNode as any).depth !== (newNode as any).depth) return true;
  if (oldNode.type === 'list' && Boolean((oldNode as any).ordered) !== Boolean((newNode as any).ordered)) return true;
  if (oldNode.type === 'code' && (oldNode as any).lang !== (newNode as any).lang) return true;
  return false;
}

function buildFallbackBlocks(rows: DiffRenderRow[], occupied: Set<string>) {
  const blocks: Array<{ start: number; end: number }> = [];
  let start = -1;

  rows.forEach((row, index) => {
    const uncoveredChangedRow = row.status !== 'equal' && !occupied.has(row.id);
    if (!uncoveredChangedRow) {
      if (start !== -1) {
        blocks.push({ start, end: index - 1 });
        start = -1;
      }
      return;
    }

    if (start === -1) start = index;
  });

  if (start !== -1) {
    blocks.push({ start, end: rows.length - 1 });
  }

  return blocks;
}

function createBlockFromRows(
  id: string,
  blockRows: DiffRenderRow[],
  preferredNode: Content | null
): DiffBlock | null {
  if (blockRows.length === 0 || !blockRows.some((row) => row.status !== 'equal')) {
    return null;
  }

  const oldText = contentFromRows(blockRows, 'old');
  const newText = contentFromRows(blockRows, 'new');
  const oldRoot = parseRoot(oldText);
  const newRoot = parseRoot(newText);
  const oldNode = pickPrimaryNode(oldRoot);
  const newNode = pickPrimaryNode(newRoot);
  const effectiveNode = newNode || oldNode || preferredNode;
  const kind = classifyNode(effectiveNode, newText || oldText);

  return {
    id,
    kind,
    rows: blockRows,
    changedRows: blockRows.filter((row) => row.status !== 'equal'),
    reviewText: blockRows.map(reviewTextForRow).join('\n'),
    oldText,
    newText,
    compact: blockRows.length <= 2,
    structural: isStructuralChange(oldNode, newNode),
    reviewNode: effectiveNode,
    oldRoot,
    newRoot,
    callout: detectCallout(effectiveNode),
    reviewUnits: [],
  };
}

function markOccupiedRows(occupied: Set<string>, rows: DiffRenderRow[]) {
  for (const row of rows) {
    if (row.status === 'equal') continue;
    occupied.add(row.id);
  }
}

export function buildDiffBlocks(rows: DiffRenderRow[]): DiffBlock[] {
  const oldRoot = parseRoot(contentFromRows(rows, 'old'));
  const newRoot = parseRoot(contentFromRows(rows, 'new'));
  const occupied = new Set<string>();
  const blocks: DiffBlock[] = [];

  for (const node of newRoot?.children || []) {
    if (!hasPosition(node as Content)) continue;
    const blockRows = rowsForNodeRange(rows, node as Content, 'new');
    const block = createBlockFromRows(
      `new-${(node as Content).position?.start.line || 1}-${(node as Content).position?.end.line || 1}`,
      blockRows,
      node as Content
    );
    if (!block) continue;
    markOccupiedRows(occupied, blockRows);
    blocks.push(block);
  }

  for (const node of oldRoot?.children || []) {
    if (!hasPosition(node as Content)) continue;
    const blockRows = rowsForNodeRange(rows, node as Content, 'old');
    if (!blockRows.some((row) => row.status !== 'equal' && !occupied.has(row.id))) {
      continue;
    }
    const block = createBlockFromRows(
      `old-${(node as Content).position?.start.line || 1}-${(node as Content).position?.end.line || 1}`,
      blockRows,
      node as Content
    );
    if (!block) continue;
    markOccupiedRows(occupied, blockRows);
    blocks.push(block);
  }

  for (const { start, end } of buildFallbackBlocks(rows, occupied)) {
    const blockRows = rows.slice(start, end + 1);
    const reviewText = blockRows.map(reviewTextForRow).join('\n');
    const block = createBlockFromRows(
      `fallback-${start + 1}-${end + 1}`,
      blockRows,
      null
    );
    if (!block) continue;
    blocks.push({
      ...block,
      kind: isBlankBlockText(reviewText) ? 'blank' : block.kind,
    });
  }

  return blocks
    .sort((left, right) => {
      const leftLine = left.rows[0]?.reviewLineNumber || 0;
      const rightLine = right.rows[0]?.reviewLineNumber || 0;
      return leftLine - rightLine;
    })
    .map((block) => ({
      ...block,
      reviewUnits: buildReviewUnits(block),
    }));
}
