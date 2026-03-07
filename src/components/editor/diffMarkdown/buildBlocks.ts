import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Content, Parent, Root } from 'mdast';
import type { DiffRenderRow } from '../diffRows';
import type { DiffBlock, DiffBlockKind, DiffCalloutMeta } from './types';
import { buildReviewUnits } from './buildReviewUnits';

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkGfm)
  .use(remarkMath);

function parseRoot(content: string): Root | null {
  if (!content.trim()) return null;
  return processor.parse(content) as Root;
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

function pickPrimaryNode(root: Root | null): Content | null {
  if (!root || root.children.length === 0) return null;
  return (root.children.find((child) => child.type !== 'definition') || root.children[0]) as Content;
}

function isTaskListNode(node: Content | null) {
  return Boolean(
    node &&
      node.type === 'list' &&
      (node as any).children?.some((child: any) => typeof child?.checked === 'boolean')
  );
}

function detectCallout(node: Content | null): DiffCalloutMeta | null {
  if (!node || node.type !== 'blockquote') return null;
  const firstChild = (node as Parent).children?.[0] as Content | undefined;
  if (!firstChild || firstChild.type !== 'paragraph') return null;
  const firstText = ((firstChild as Parent).children?.[0] as any)?.value;
  if (typeof firstText !== 'string') return null;
  const match = firstText.match(/^\[!(\w+)\]\s*(.*)$/);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase(),
    title: match[2]?.trim() || null,
  };
}

function classifyNode(node: Content | null): DiffBlockKind {
  if (!node) return 'blank';
  if (node.type === 'heading') return 'heading';
  if (node.type === 'paragraph') return 'paragraph';
  if (node.type === 'blockquote') return detectCallout(node) ? 'callout' : 'blockquote';
  if (node.type === 'list') return isTaskListNode(node) ? 'task_list' : 'list';
  if (node.type === 'code') {
    return (node as any).lang === 'mermaid' ? 'mermaid' : 'code';
  }
  if (node.type === 'math') return 'math';
  if (node.type === 'table') return 'table';
  if (node.type === 'html') return 'html';
  if (node.type === 'yaml' || (node as any).type === 'toml') return 'frontmatter';
  if (node.type === 'footnoteDefinition') return 'footnote';
  if (node.type === 'thematicBreak') return 'thematic_break';
  return 'unknown';
}

function isStructuralChange(oldNode: Content | null, newNode: Content | null) {
  if (!oldNode || !newNode) return false;
  if (oldNode.type !== newNode.type) return true;
  if (oldNode.type === 'heading' && (oldNode as any).depth !== (newNode as any).depth) return true;
  if (oldNode.type === 'list' && Boolean((oldNode as any).ordered) !== Boolean((newNode as any).ordered)) return true;
  if (oldNode.type === 'code' && (oldNode as any).lang !== (newNode as any).lang) return true;
  return false;
}

function buildFallbackBlocks(rows: DiffRenderRow[], occupied: Set<number>) {
  const blocks: Array<{ start: number; end: number }> = [];
  let start = -1;

  rows.forEach((row, index) => {
    const uncoveredChangedRow = row.status !== 'equal' && !occupied.has(index);
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

export function buildDiffBlocks(rows: DiffRenderRow[]): DiffBlock[] {
  const reviewLines = rows.map(reviewTextForRow);
  const reviewRoot = parseRoot(reviewLines.join('\n'));
  const occupied = new Set<number>();
  const blocks: DiffBlock[] = [];

  for (const node of reviewRoot?.children || []) {
    if (!hasPosition(node as Content)) continue;
    const startIndex = ((node as Content).position?.start.line || 1) - 1;
    const endIndex = ((node as Content).position?.end.line || 1) - 1;
    const blockRows = rows.slice(startIndex, endIndex + 1);
    if (!blockRows.some((row) => row.status !== 'equal')) {
      continue;
    }

    for (let index = startIndex; index <= endIndex; index += 1) {
      occupied.add(index);
    }

    const oldText = contentFromRows(blockRows, 'old');
    const newText = contentFromRows(blockRows, 'new');
    const oldRoot = parseRoot(oldText);
    const newRoot = parseRoot(newText);
    const oldNode = pickPrimaryNode(oldRoot);
    const newNode = pickPrimaryNode(newRoot);
    const effectiveNode = newNode || oldNode;
    const kind = classifyNode(effectiveNode);

    blocks.push({
      id: `block-${startIndex + 1}-${endIndex + 1}`,
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
    });
  }

  for (const { start, end } of buildFallbackBlocks(rows, occupied)) {
    const blockRows = rows.slice(start, end + 1);
    const reviewText = blockRows.map(reviewTextForRow).join('\n');
    const oldText = contentFromRows(blockRows, 'old');
    const newText = contentFromRows(blockRows, 'new');
    const oldRoot = parseRoot(oldText);
    const newRoot = parseRoot(newText);
    const oldNode = pickPrimaryNode(oldRoot);
    const newNode = pickPrimaryNode(newRoot);

    blocks.push({
      id: `fallback-${start + 1}-${end + 1}`,
      kind: isBlankBlockText(reviewText) ? 'blank' : classifyNode(newNode || oldNode),
      rows: blockRows,
      changedRows: blockRows.filter((row) => row.status !== 'equal'),
      reviewText,
      oldText,
      newText,
      compact: blockRows.length <= 2,
      structural: isStructuralChange(oldNode, newNode),
      reviewNode: newNode || oldNode,
      oldRoot,
      newRoot,
      callout: detectCallout(newNode || oldNode),
      reviewUnits: [],
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
