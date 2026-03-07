import { diffArrays } from 'diff';
import type { Content, Parent, Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export type MarkdownBlockKind =
  | 'heading'
  | 'paragraph'
  | 'blockquote'
  | 'callout'
  | 'list'
  | 'task_list'
  | 'code'
  | 'math'
  | 'table'
  | 'html'
  | 'frontmatter'
  | 'footnote'
  | 'image'
  | 'thematic_break'
  | 'unknown';

export interface MarkdownCalloutMeta {
  kind: string;
  title: string | null;
}

export interface MarkdownBlock {
  id: string;
  key: string;
  kind: MarkdownBlockKind;
  markdown: string;
  leading: string;
  leadingStartOffset: number;
  startOffset: number;
  endOffset: number;
  node: Content | null;
  callout: MarkdownCalloutMeta | null;
}

export interface ParsedMarkdownDocument {
  content: string;
  blocks: MarkdownBlock[];
  trailing: string;
}

export interface MarkdownDiffUnit {
  id: string;
  status: 'equal' | 'modified' | 'added' | 'removed';
  baseBlock: MarkdownBlock | null;
  draftBlock: MarkdownBlock | null;
  insertBeforeDraftBlockId: string | null;
}

interface ArrayDiffPart<T> {
  value: T[];
  added?: boolean;
  removed?: boolean;
}

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkGfm)
  .use(remarkMath);

function getOffset(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeBlockMarkdown(markdown: string) {
  return markdown.replace(/\s+$/g, '').trim();
}

function isTaskListNode(node: Content | null) {
  return Boolean(
    node &&
      node.type === 'list' &&
      (node as any).children?.some((child: any) => typeof child?.checked === 'boolean')
  );
}

function detectCallout(node: Content | null): MarkdownCalloutMeta | null {
  if (!node || node.type !== 'blockquote') return null;
  const firstChild = (node as Parent).children?.[0] as Content | undefined;
  if (!firstChild || firstChild.type !== 'paragraph') return null;
  const firstText = ((firstChild as Parent).children?.[0] as any)?.value;
  if (typeof firstText !== 'string') return null;
  const [firstLine = ''] = firstText.split('\n');
  const match = firstLine.match(/^\[!(\w+)\]\s*(.*)$/);
  if (!match) return null;
  return {
    kind: match[1].toLowerCase(),
    title: match[2]?.trim() || null,
  };
}

function classifyNode(node: Content | null): MarkdownBlockKind {
  if (!node) return 'unknown';
  if (node.type === 'heading') return 'heading';
  if (node.type === 'paragraph') {
    const children = (node as Parent).children || [];
    if (children.length === 1 && children[0]?.type === 'image') return 'image';
    return 'paragraph';
  }
  if (node.type === 'blockquote') return detectCallout(node) ? 'callout' : 'blockquote';
  if (node.type === 'list') return isTaskListNode(node) ? 'task_list' : 'list';
  if (node.type === 'code') return 'code';
  if (node.type === 'math') return 'math';
  if (node.type === 'table') return 'table';
  if (node.type === 'html') return 'html';
  if (node.type === 'yaml' || (node as any).type === 'toml') return 'frontmatter';
  if (node.type === 'footnoteDefinition') return 'footnote';
  if (node.type === 'thematicBreak') return 'thematic_break';
  return 'unknown';
}

function nextDraftBlockId(parts: Array<ArrayDiffPart<MarkdownBlock>>, startIndex: number) {
  for (let index = startIndex; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.removed) continue;
    const first = part.value[0];
    if (first) return first.id;
  }
  return null;
}

function compareBlocks(left: MarkdownBlock, right: MarkdownBlock) {
  return left.kind === right.kind && normalizeBlockMarkdown(left.markdown) === normalizeBlockMarkdown(right.markdown);
}

export function parseMarkdownDocument(content: string): ParsedMarkdownDocument {
  if (!content.trim()) {
    return {
      content,
      blocks: [],
      trailing: content,
    };
  }

  const root = processor.parse(content) as Root;
  const blocks: MarkdownBlock[] = [];
  let cursor = 0;

  for (const child of root.children as Content[]) {
    const startOffset = getOffset((child as any).position?.start?.offset);
    const endOffset = getOffset((child as any).position?.end?.offset);
    if (startOffset === null || endOffset === null || endOffset < startOffset) {
      continue;
    }

    const leadingStartOffset = cursor;
    const leading = content.slice(cursor, startOffset);
    const markdown = content.slice(startOffset, endOffset);
    const kind = classifyNode(child);
    blocks.push({
      id: `block-${blocks.length}-${kind}`,
      key: `${kind}:${normalizeBlockMarkdown(markdown)}`,
      kind,
      markdown,
      leading,
      leadingStartOffset,
      startOffset,
      endOffset,
      node: child,
      callout: detectCallout(child),
    });
    cursor = endOffset;
  }

  if (blocks.length === 0) {
    return {
      content,
      blocks: [
        {
          id: 'block-0-unknown',
          key: `unknown:${normalizeBlockMarkdown(content)}`,
          kind: 'unknown',
          markdown: content,
          leading: '',
          leadingStartOffset: 0,
          startOffset: 0,
          endOffset: content.length,
          node: null,
          callout: null,
        },
      ],
      trailing: '',
    };
  }

  return {
    content,
    blocks,
    trailing: content.slice(cursor),
  };
}

export function buildMarkdownDiffUnits(baseContent: string, draftContent: string): MarkdownDiffUnit[] {
  const base = parseMarkdownDocument(baseContent);
  const draft = parseMarkdownDocument(draftContent);
  const parts = diffArrays(base.blocks, draft.blocks, { comparator: compareBlocks });
  const units: MarkdownDiffUnit[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.added && !part.removed) {
      units.push(
        ...part.value.map((block) => ({
          id: `equal-${block.id}`,
          status: 'equal' as const,
          baseBlock: block,
          draftBlock: block,
          insertBeforeDraftBlockId: null,
        }))
      );
      continue;
    }

    if (part.removed && parts[index + 1]?.added) {
      const removed = part.value;
      const added = parts[index + 1].value;
      const shared = Math.min(removed.length, added.length);
      for (let pairIndex = 0; pairIndex < shared; pairIndex += 1) {
        units.push({
          id: `modified-${removed[pairIndex].id}-${added[pairIndex].id}`,
          status: 'modified',
          baseBlock: removed[pairIndex],
          draftBlock: added[pairIndex],
          insertBeforeDraftBlockId: null,
        });
      }

      const fallbackBeforeId = nextDraftBlockId(parts, index + 2);
      for (let pairIndex = shared; pairIndex < removed.length; pairIndex += 1) {
        units.push({
          id: `removed-${removed[pairIndex].id}`,
          status: 'removed',
          baseBlock: removed[pairIndex],
          draftBlock: null,
          insertBeforeDraftBlockId: fallbackBeforeId,
        });
      }

      for (let pairIndex = shared; pairIndex < added.length; pairIndex += 1) {
        units.push({
          id: `added-${added[pairIndex].id}`,
          status: 'added',
          baseBlock: null,
          draftBlock: added[pairIndex],
          insertBeforeDraftBlockId: null,
        });
      }

      index += 1;
      continue;
    }

    if (part.removed) {
      const beforeId = nextDraftBlockId(parts, index + 1);
      units.push(
        ...part.value.map((block) => ({
          id: `removed-${block.id}`,
          status: 'removed' as const,
          baseBlock: block,
          draftBlock: null,
          insertBeforeDraftBlockId: beforeId,
        }))
      );
      continue;
    }

    units.push(
      ...part.value.map((block) => ({
        id: `added-${block.id}`,
        status: 'added' as const,
        baseBlock: null,
        draftBlock: block,
        insertBeforeDraftBlockId: null,
      }))
    );
  }

  return units;
}

export function replaceMarkdownBlock(content: string, block: MarkdownBlock, markdown: string) {
  return `${content.slice(0, block.startOffset)}${markdown}${content.slice(block.endOffset)}`;
}

export function removeMarkdownBlock(content: string, block: MarkdownBlock) {
  return `${content.slice(0, block.leadingStartOffset)}${content.slice(block.endOffset)}`;
}

export function insertMarkdownBlockBefore(
  content: string,
  beforeBlock: MarkdownBlock | null,
  markdown: string,
  leading = ''
) {
  if (!beforeBlock) {
    if (!content.trim()) return markdown;
    const separator = leading || (content.endsWith('\n\n') ? '' : '\n\n');
    return `${content}${separator}${markdown}`;
  }
  return `${content.slice(0, beforeBlock.leadingStartOffset)}${leading}${markdown}${content.slice(beforeBlock.leadingStartOffset)}`;
}

export function supportsStructuredBlockEditor(content: string) {
  const { blocks } = parseMarkdownDocument(content);
  return blocks.some((block) =>
    ['task_list', 'table', 'html', 'frontmatter', 'footnote', 'callout', 'code', 'math', 'image', 'thematic_break', 'list'].includes(
      block.kind
    )
  );
}
