import { diffArrays, diffChars } from 'diff';
import type { Content, Parent, Root } from 'mdast';
import { toString } from 'mdast-util-to-string';
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

export type MarkdownActiveEditorKind =
  | 'rich_text'
  | 'metadata_form'
  | 'task_list'
  | 'table_grid'
  | 'code'
  | 'mermaid'
  | 'math'
  | 'image'
  | 'divider'
  | 'source_drawer';

export interface MarkdownCalloutMeta {
  kind: string;
  title: string | null;
}

export interface MarkdownSourceRange {
  leadingStartOffset: number;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

export interface MarkdownFormatHints {
  listMarker?: '-' | '*' | '+' | null;
  orderedDelimiter?: '.' | ')' | null;
  fenceMarker?: '`' | '~' | null;
  fenceLength?: number | null;
  headingSpacing?: string | null;
  calloutMarker?: string | null;
  frontmatterDelimiter?: '---' | '+++' | null;
  tableAlignment?: Array<'left' | 'center' | 'right' | 'none'>;
  mathDelimiterStyle?: 'inline' | 'display' | null;
}

export interface MarkdownEditBlock {
  id: string;
  stableId: string;
  key: string;
  kind: MarkdownBlockKind;
  markdown: string;
  rawSource: string;
  leading: string;
  leadingStartOffset: number;
  startOffset: number;
  endOffset: number;
  sourceRange: MarkdownSourceRange;
  formatHints: MarkdownFormatHints;
  dependencyIds: string[];
  activeEditorKind: MarkdownActiveEditorKind;
  previewAst: Content | null;
  node: Content | null;
  callout: MarkdownCalloutMeta | null;
}

export type MarkdownBlock = MarkdownEditBlock;

export interface ParsedMarkdownDocument {
  content: string;
  blocks: MarkdownEditBlock[];
  trailing: string;
  lineMap: number[];
  dependencies: Record<string, string[]>;
  versionStamp: string;
}

export interface MarkdownEditTransactionPatch {
  blockId: string;
  startOffset: number;
  endOffset: number;
  markdown: string;
}

export interface MarkdownEditTransaction {
  patches: MarkdownEditTransactionPatch[];
  dependentBlockIds: string[];
  selectionRestoreHint: string | null;
  reparseMode: 'sync' | 'transition';
}

export interface MarkdownDiffUnit {
  id: string;
  status: 'equal' | 'modified' | 'added' | 'removed';
  baseBlock: MarkdownBlock | null;
  draftBlock: MarkdownBlock | null;
  insertBeforeDraftBlockId: string | null;
}

export interface MarkdownBlockVisualUnit {
  id: string;
  kind: 'block';
  block: MarkdownBlock;
}

export interface EmptyParagraphLineUnit {
  id: string;
  kind: 'empty_paragraph_line';
  beforeBlockId: string | null;
  afterBlockId: string | null;
  gapStartOffset: number;
  gapEndOffset: number;
  slotOffset: number;
  slotIndex: number;
  totalSlots: number;
}

export type MarkdownVisualUnit = MarkdownBlockVisualUnit | EmptyParagraphLineUnit;

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

export const markdownProcessor = processor;
const BLOCK_REPLACE_MATCH_THRESHOLD = 0.55;

function getOffset(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isStandaloneImageMarkdown(markdown: string) {
  const trimmed = markdown.trim();
  if (!trimmed.startsWith('![') || trimmed.includes('\n') || !trimmed.endsWith(')')) return false;
  const separatorIndex = trimmed.indexOf('](');
  if (separatorIndex < 2) return false;
  const payload = trimmed.slice(separatorIndex + 2, -1).trim();
  return payload.length > 0;
}

export function buildMarkdownLineMap(content: string) {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function getLineNumberAtOffset(lineMap: number[], offset: number) {
  let line = 1;
  for (let index = 0; index < lineMap.length; index += 1) {
    if (lineMap[index] > offset) break;
    line = index + 1;
  }
  return line;
}

function createVersionStamp(content: string) {
  const head = content.slice(0, 64);
  const tail = content.slice(-64);
  return `${content.length}:${head}|${tail}`;
}

export function normalizeMarkdownBlockSource(markdown: string) {
  return markdown.replace(/\s+$/g, '').trim();
}

export function isTaskListMarkdownNode(node: Content | null) {
  return Boolean(
    node &&
      node.type === 'list' &&
      (node as any).children?.some((child: any) => typeof child?.checked === 'boolean')
  );
}

export function detectMarkdownCallout(node: Content | null): MarkdownCalloutMeta | null {
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

export function classifyMarkdownNode(node: Content | null, markdown = ''): MarkdownBlockKind {
  if (!node) return 'unknown';
  if (node.type === 'heading') return 'heading';
  if (node.type === 'paragraph') {
    const children = (node as Parent).children || [];
    if (children.length === 1 && children[0]?.type === 'image') return 'image';
    if (isStandaloneImageMarkdown(markdown)) return 'image';
    return 'paragraph';
  }
  if (node.type === 'blockquote') return detectMarkdownCallout(node) ? 'callout' : 'blockquote';
  if (node.type === 'list') return isTaskListMarkdownNode(node) ? 'task_list' : 'list';
  if (node.type === 'code') return 'code';
  if (node.type === 'math') return 'math';
  if (node.type === 'table') return 'table';
  if (node.type === 'html') return 'html';
  if (node.type === 'yaml' || (node as any).type === 'toml') return 'frontmatter';
  if (node.type === 'footnoteDefinition') return 'footnote';
  if (node.type === 'thematicBreak') return 'thematic_break';
  return 'unknown';
}

export function parseMarkdownRoot(content: string): Root | null {
  if (!content.trim()) return null;
  return processor.parse(content) as Root;
}

function parseListHints(markdown: string): Pick<MarkdownFormatHints, 'listMarker' | 'orderedDelimiter'> {
  const firstLine = markdown.split('\n').find((line) => line.trim().length > 0) || '';
  const match = firstLine.match(/^(\s*)([-*+]|\d+[.)])(\s+)/);
  if (!match) {
    return {
      listMarker: null,
      orderedDelimiter: null,
    };
  }
  const token = match[2];
  if (/^\d/.test(token)) {
    return {
      listMarker: null,
      orderedDelimiter: token.endsWith(')') ? ')' : '.',
    };
  }
  return {
    listMarker: token as '-' | '*' | '+',
    orderedDelimiter: null,
  };
}

function parseCodeFenceHints(markdown: string): Pick<MarkdownFormatHints, 'fenceMarker' | 'fenceLength'> {
  const match = markdown.match(/^(`{3,}|~{3,})([^\n]*)/);
  if (!match) {
    return {
      fenceMarker: null,
      fenceLength: null,
    };
  }
  return {
    fenceMarker: match[1][0] as '`' | '~',
    fenceLength: match[1].length,
  };
}

function parseTableAlignment(markdown: string) {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [] as Array<'left' | 'center' | 'right' | 'none'>;

  return lines[1]
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => {
      const value = cell.trim();
      const left = value.startsWith(':');
      const right = value.endsWith(':');
      if (left && right) return 'center' as const;
      if (left) return 'left' as const;
      if (right) return 'right' as const;
      return 'none' as const;
    });
}

export function extractMarkdownFormatHints(kind: MarkdownBlockKind, markdown: string): MarkdownFormatHints {
  switch (kind) {
    case 'heading': {
      const match = markdown.match(/^(#{1,6})(\s+)/);
      return {
        headingSpacing: match?.[2] || ' ',
      };
    }
    case 'list':
    case 'task_list':
      return parseListHints(markdown);
    case 'code':
      return parseCodeFenceHints(markdown);
    case 'callout': {
      const match = markdown.match(/^\s*>\s*(\[!\w+\])/);
      return {
        calloutMarker: match?.[1] || null,
      };
    }
    case 'frontmatter': {
      const match = markdown.match(/^(---|\+\+\+)/);
      return {
        frontmatterDelimiter: (match?.[1] as '---' | '+++' | undefined) || null,
      };
    }
    case 'table':
      return {
        tableAlignment: parseTableAlignment(markdown),
      };
    case 'math':
      return {
        mathDelimiterStyle: markdown.trim().startsWith('$$') ? 'display' : 'inline',
      };
    default:
      return {};
  }
}

function collectFootnoteDependencyIds(markdown: string) {
  const ids = Array.from(markdown.matchAll(/\[\^([^\]]+)\]/g), (match) => `footnote:${match[1]}`);
  return ids.filter((value, index) => ids.indexOf(value) === index);
}

export function collectMarkdownDependencyIds(kind: MarkdownBlockKind, markdown: string) {
  if (kind === 'footnote') {
    const match = markdown.match(/^\[\^([^\]]+)\]:/m);
    if (match?.[1]) {
      return [`footnote:${match[1]}`];
    }
  }
  return collectFootnoteDependencyIds(markdown);
}

function resolveActiveEditorKind(kind: MarkdownBlockKind, markdown: string): MarkdownActiveEditorKind {
  switch (kind) {
    case 'frontmatter':
      return 'metadata_form';
    case 'task_list':
      return 'task_list';
    case 'table':
      return 'table_grid';
    case 'code':
      return /^(`{3,}|~{3,})mermaid\b/i.test(markdown) ? 'mermaid' : 'code';
    case 'math':
      return 'math';
    case 'image':
      return 'image';
    case 'thematic_break':
      return 'divider';
    case 'html':
    case 'unknown':
      return 'source_drawer';
    default:
      return 'rich_text';
  }
}

function createStableId(kind: MarkdownBlockKind, startLine: number, endLine: number, markdown: string) {
  const normalized = normalizeMarkdownBlockSource(markdown).replace(/\s+/g, ' ').slice(0, 80);
  return `${kind}:${startLine}:${endLine}:${normalized}`;
}

function buildFallbackUnknownBlock(content: string, lineMap: number[]) {
  const normalized = normalizeMarkdownBlockSource(content);
  const startLine = 1;
  const endLine = Math.max(1, lineMap.length);
  const stableId = createStableId('unknown', startLine, endLine, content);
  return {
    id: 'block-0-unknown',
    stableId,
    key: `unknown:${normalized}`,
    kind: 'unknown' as const,
    markdown: content,
    rawSource: content,
    leading: '',
    leadingStartOffset: 0,
    startOffset: 0,
    endOffset: content.length,
    sourceRange: {
      leadingStartOffset: 0,
      startOffset: 0,
      endOffset: content.length,
      startLine,
      endLine,
    },
    formatHints: extractMarkdownFormatHints('unknown', content),
    dependencyIds: collectMarkdownDependencyIds('unknown', content),
    activeEditorKind: resolveActiveEditorKind('unknown', content),
    previewAst: null,
    node: null,
    callout: null,
  };
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

function isListFamily(kind: MarkdownBlockKind) {
  return kind === 'list' || kind === 'task_list';
}

function isQuoteFamily(kind: MarkdownBlockKind) {
  return kind === 'blockquote' || kind === 'callout';
}

function areBlockKindsCompatible(left: MarkdownBlockKind, right: MarkdownBlockKind) {
  if (left === right) return true;
  if (isListFamily(left) && isListFamily(right)) return true;
  if (isQuoteFamily(left) && isQuoteFamily(right)) return true;
  return false;
}

function markdownToComparableBlockText(markdown: string) {
  const normalizedSource = normalizeMarkdownBlockSource(markdown).replace(/\s+/g, ' ').trim();
  if (!normalizedSource) return '';

  try {
    const root = parseMarkdownRoot(markdown);
    const visibleText = root ? toString(root).replace(/\s+/g, ' ').trim() : '';
    return visibleText || normalizedSource;
  } catch {
    return normalizedSource;
  }
}

function blockSimilarity(left: MarkdownBlock, right: MarkdownBlock) {
  if (!areBlockKindsCompatible(left.kind, right.kind)) return 0;

  const leftText = markdownToComparableBlockText(left.markdown);
  const rightText = markdownToComparableBlockText(right.markdown);

  if (!leftText && !rightText) return 1;
  if (!leftText || !rightText) return 0;

  const parts = diffChars(leftText, rightText);
  let sharedLength = 0;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      sharedLength += part.value.length;
    }
  }

  const totalLength = leftText.length + rightText.length;
  return totalLength > 0 ? (sharedLength * 2) / totalLength : 0;
}

function chooseAlignmentCandidate(left: [number, number], right: [number, number]) {
  if (left[0] !== right[0]) {
    return left[0] > right[0] ? left : right;
  }
  return left[1] >= right[1] ? left : right;
}

function alignReplaceRegion(
  removedBlocks: MarkdownBlock[],
  addedBlocks: MarkdownBlock[],
): Array<[number, number]> {
  const removedCount = removedBlocks.length;
  const addedCount = addedBlocks.length;
  if (removedCount === 0 || addedCount === 0) return [];

  const similarity = Array.from({ length: removedCount }, (_, removedIndex) =>
    Array.from({ length: addedCount }, (_, addedIndex) => blockSimilarity(removedBlocks[removedIndex], addedBlocks[addedIndex]))
  );

  const dp: Array<Array<[number, number]>> = Array.from({ length: removedCount + 1 }, () =>
    Array.from({ length: addedCount + 1 }, () => [0, 0])
  );

  for (let removedIndex = removedCount - 1; removedIndex >= 0; removedIndex -= 1) {
    for (let addedIndex = addedCount - 1; addedIndex >= 0; addedIndex -= 1) {
      let best = chooseAlignmentCandidate(dp[removedIndex + 1][addedIndex], dp[removedIndex][addedIndex + 1]);
      const score = similarity[removedIndex][addedIndex];
      if (score >= BLOCK_REPLACE_MATCH_THRESHOLD) {
        const paired: [number, number] = [
          dp[removedIndex + 1][addedIndex + 1][0] + score,
          dp[removedIndex + 1][addedIndex + 1][1] + 1,
        ];
        best = chooseAlignmentCandidate(best, paired);
      }
      dp[removedIndex][addedIndex] = best;
    }
  }

  if (dp[0][0][1] === 0) return [];

  const pairs: Array<[number, number]> = [];
  let removedIndex = 0;
  let addedIndex = 0;
  while (removedIndex < removedCount && addedIndex < addedCount) {
    const score = similarity[removedIndex][addedIndex];
    const current = dp[removedIndex][addedIndex];
    if (score >= BLOCK_REPLACE_MATCH_THRESHOLD) {
      const paired: [number, number] = [
        dp[removedIndex + 1][addedIndex + 1][0] + score,
        dp[removedIndex + 1][addedIndex + 1][1] + 1,
      ];
      if (current[0] === paired[0] && current[1] === paired[1]) {
        pairs.push([removedIndex, addedIndex]);
        removedIndex += 1;
        addedIndex += 1;
        continue;
      }
    }

    if (
      current[0] === dp[removedIndex][addedIndex + 1][0] &&
      current[1] === dp[removedIndex][addedIndex + 1][1]
    ) {
      addedIndex += 1;
      continue;
    }

    removedIndex += 1;
  }

  return pairs;
}

function buildEmptyParagraphLineId(slotOffset: number) {
  return `empty-paragraph:${slotOffset}`;
}

function collectNewlineOffsets(text: string, absoluteStartOffset: number) {
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      offsets.push(absoluteStartOffset + index);
    }
  }
  return offsets;
}

function createEmptyParagraphUnits(
  gapText: string,
  gapStartOffset: number,
  beforeBlockId: string | null,
  afterBlockId: string | null,
  baselineNewlines: number
): EmptyParagraphLineUnit[] {
  const newlineOffsets = collectNewlineOffsets(gapText, gapStartOffset);
  const slotOffsets = newlineOffsets.slice(baselineNewlines);
  return slotOffsets.map((slotOffset, slotIndex) => ({
    id: buildEmptyParagraphLineId(slotOffset),
    kind: 'empty_paragraph_line' as const,
    beforeBlockId,
    afterBlockId,
    gapStartOffset,
    gapEndOffset: gapStartOffset + gapText.length,
    slotOffset,
    slotIndex,
    totalSlots: slotOffsets.length,
  }));
}

function findBlockIndex(blocks: MarkdownBlock[], blockId: string) {
  return blocks.findIndex((block) => block.id === blockId);
}

export function compareMarkdownBlocks(left: MarkdownBlock, right: MarkdownBlock) {
  return left.kind === right.kind && normalizeMarkdownBlockSource(left.markdown) === normalizeMarkdownBlockSource(right.markdown);
}

export function buildMarkdownVisualUnits(document: ParsedMarkdownDocument): MarkdownVisualUnit[] {
  const units: MarkdownVisualUnit[] = [];

  if (document.blocks.length === 0) {
    return createEmptyParagraphUnits(document.trailing, 0, null, null, 0);
  }

  document.blocks.forEach((block, index) => {
    if (index === 0 && block.leading) {
      units.push(...createEmptyParagraphUnits(block.leading, block.leadingStartOffset, null, block.id, 0));
    }

    units.push({
      id: block.id,
      kind: 'block',
      block,
    });

    const nextBlock = document.blocks[index + 1];
    if (nextBlock) {
      units.push(
        ...createEmptyParagraphUnits(nextBlock.leading, nextBlock.leadingStartOffset, block.id, nextBlock.id, 2)
      );
      return;
    }

    if (document.trailing) {
      units.push(...createEmptyParagraphUnits(document.trailing, block.endOffset, block.id, null, 0));
    }
  });

  return units;
}

export function createMarkdownEditTransaction(
  block: MarkdownBlock,
  markdown: string,
  dependentBlockIds: string[] = []
): MarkdownEditTransaction {
  return {
    patches: [
      {
        blockId: block.id,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        markdown,
      },
    ],
    dependentBlockIds,
    selectionRestoreHint: block.stableId,
    reparseMode: 'transition',
  };
}

export function insertEmptyParagraphBeforeBlock(
  content: string,
  document: ParsedMarkdownDocument,
  beforeBlockId: string
) {
  const beforeIndex = findBlockIndex(document.blocks, beforeBlockId);
  if (beforeIndex === -1) return null;

  const beforeBlock = document.blocks[beforeIndex];
  const hasPreviousBlock = beforeIndex > 0;
  const newlineCount = collectNewlineOffsets(beforeBlock.leading, beforeBlock.leadingStartOffset).length;
  const insertionOffset = beforeBlock.startOffset;
  const insertCount = hasPreviousBlock ? Math.max(1, 3 - newlineCount) : 1;
  const insertedUnitOffset = insertionOffset + insertCount - 1;

  return {
    content: `${content.slice(0, insertionOffset)}${'\n'.repeat(insertCount)}${content.slice(insertionOffset)}`,
    insertedUnitId: buildEmptyParagraphLineId(insertedUnitOffset),
  };
}

export function insertEmptyParagraphAfterBlock(
  content: string,
  document: ParsedMarkdownDocument,
  blockId: string
) {
  const blockIndex = findBlockIndex(document.blocks, blockId);
  if (blockIndex === -1) return null;
  const nextBlock = document.blocks[blockIndex + 1];
  if (nextBlock) {
    return insertEmptyParagraphBeforeBlock(content, document, nextBlock.id);
  }
  return {
    content: `${content}\n`,
    insertedUnitId: buildEmptyParagraphLineId(content.length),
  };
}

export function insertEmptyParagraphAtEnd(content: string) {
  return {
    content: `${content}\n`,
    insertedUnitId: buildEmptyParagraphLineId(content.length),
  };
}

export function removeEmptyParagraphLine(content: string, unit: EmptyParagraphLineUnit) {
  return `${content.slice(0, unit.slotOffset)}${content.slice(unit.slotOffset + 1)}`;
}

export function materializeEmptyParagraphLine(content: string, unit: EmptyParagraphLineUnit, markdown: string) {
  const beforeExtraCount = unit.slotIndex;
  const afterExtraCount = unit.totalSlots - unit.slotIndex - 1;
  const leadingBefore = '\n'.repeat((unit.beforeBlockId ? 2 : 0) + beforeExtraCount);
  const trailingAfter = '\n'.repeat((unit.afterBlockId ? 2 : 0) + afterExtraCount);
  const insertedBlockStartOffset = unit.gapStartOffset + leadingBefore.length;

  return {
    content: `${content.slice(0, unit.gapStartOffset)}${leadingBefore}${markdown}${trailingAfter}${content.slice(unit.gapEndOffset)}`,
    insertedBlockStartOffset,
  };
}

export function parseMarkdownDocument(content: string): ParsedMarkdownDocument {
  const lineMap = buildMarkdownLineMap(content);
  if (!content.trim()) {
    return {
      content,
      blocks: [],
      trailing: content,
      lineMap,
      dependencies: {},
      versionStamp: createVersionStamp(content),
    };
  }

  const root = parseMarkdownRoot(content);
  const blocks: MarkdownEditBlock[] = [];
  let cursor = 0;

  for (const child of root?.children || []) {
    const node = child as Content;
    const startOffset = getOffset((node as any).position?.start?.offset);
    const endOffset = getOffset((node as any).position?.end?.offset);
    if (startOffset === null || endOffset === null || endOffset < startOffset) {
      continue;
    }

    const leadingStartOffset = cursor;
    const leading = content.slice(cursor, startOffset);
    const markdown = content.slice(startOffset, endOffset);
    const kind = classifyMarkdownNode(node, markdown);
    const startLine = getLineNumberAtOffset(lineMap, startOffset);
    const endLine = getLineNumberAtOffset(lineMap, Math.max(startOffset, endOffset - 1));
    const stableId = createStableId(kind, startLine, endLine, markdown);

    blocks.push({
      id: `block-${blocks.length}-${kind}`,
      stableId,
      key: `${kind}:${normalizeMarkdownBlockSource(markdown)}`,
      kind,
      markdown,
      rawSource: markdown,
      leading,
      leadingStartOffset,
      startOffset,
      endOffset,
      sourceRange: {
        leadingStartOffset,
        startOffset,
        endOffset,
        startLine,
        endLine,
      },
      formatHints: extractMarkdownFormatHints(kind, markdown),
      dependencyIds: collectMarkdownDependencyIds(kind, markdown),
      activeEditorKind: resolveActiveEditorKind(kind, markdown),
      previewAst: node,
      node,
      callout: detectMarkdownCallout(node),
    });
    cursor = endOffset;
  }

  const resolvedBlocks = blocks.length > 0 ? blocks : [buildFallbackUnknownBlock(content, lineMap)];
  const dependencies = Object.fromEntries(resolvedBlocks.map((block) => [block.id, block.dependencyIds]));

  return {
    content,
    blocks: resolvedBlocks,
    trailing: blocks.length > 0 ? content.slice(cursor) : '',
    lineMap,
    dependencies,
    versionStamp: createVersionStamp(content),
  };
}

export function buildMarkdownDiffUnits(baseContent: string, draftContent: string): MarkdownDiffUnit[] {
  const base = parseMarkdownDocument(baseContent);
  const draft = parseMarkdownDocument(draftContent);
  const parts = diffArrays(base.blocks, draft.blocks, { comparator: compareMarkdownBlocks });
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
      const fallbackBeforeId = nextDraftBlockId(parts, index + 2);
      const alignedPairs = alignReplaceRegion(removed, added);
      if (alignedPairs.length === 0) {
        const sharedCount = Math.min(removed.length, added.length);

        for (let sharedIndex = 0; sharedIndex < sharedCount; sharedIndex += 1) {
          const removedBlock = removed[sharedIndex];
          const addedBlock = added[sharedIndex];

          if (areBlockKindsCompatible(removedBlock.kind, addedBlock.kind)) {
            units.push({
              id: `modified-${removedBlock.id}-${addedBlock.id}`,
              status: 'modified',
              baseBlock: removedBlock,
              draftBlock: addedBlock,
              insertBeforeDraftBlockId: null,
            });
            continue;
          }

          units.push({
            id: `removed-${removedBlock.id}`,
            status: 'removed',
            baseBlock: removedBlock,
            draftBlock: null,
            insertBeforeDraftBlockId: addedBlock.id,
          });
          units.push({
            id: `added-${addedBlock.id}`,
            status: 'added',
            baseBlock: null,
            draftBlock: addedBlock,
            insertBeforeDraftBlockId: null,
          });
        }

        for (let removedIndex = sharedCount; removedIndex < removed.length; removedIndex += 1) {
          units.push({
            id: `removed-${removed[removedIndex].id}`,
            status: 'removed',
            baseBlock: removed[removedIndex],
            draftBlock: null,
            insertBeforeDraftBlockId: fallbackBeforeId,
          });
        }

        for (let addedIndex = sharedCount; addedIndex < added.length; addedIndex += 1) {
          units.push({
            id: `added-${added[addedIndex].id}`,
            status: 'added',
            baseBlock: null,
            draftBlock: added[addedIndex],
            insertBeforeDraftBlockId: null,
          });
        }

        index += 1;
        continue;
      }

      let removedIndex = 0;
      let addedIndex = 0;

      for (const [alignedRemovedIndex, alignedAddedIndex] of alignedPairs) {
        for (; addedIndex < alignedAddedIndex; addedIndex += 1) {
          units.push({
            id: `added-${added[addedIndex].id}`,
            status: 'added',
            baseBlock: null,
            draftBlock: added[addedIndex],
            insertBeforeDraftBlockId: null,
          });
        }

        for (; removedIndex < alignedRemovedIndex; removedIndex += 1) {
          units.push({
            id: `removed-${removed[removedIndex].id}`,
            status: 'removed',
            baseBlock: removed[removedIndex],
            draftBlock: null,
            insertBeforeDraftBlockId: added[addedIndex]?.id || fallbackBeforeId,
          });
        }

        const removedBlock = removed[alignedRemovedIndex];
        const addedBlock = added[alignedAddedIndex];
        units.push({
          id: `modified-${removedBlock.id}-${addedBlock.id}`,
          status: 'modified',
          baseBlock: removedBlock,
          draftBlock: addedBlock,
          insertBeforeDraftBlockId: null,
        });
        removedIndex = alignedRemovedIndex + 1;
        addedIndex = alignedAddedIndex + 1;
      }

      for (; removedIndex < removed.length; removedIndex += 1) {
        units.push({
          id: `removed-${removed[removedIndex].id}`,
          status: 'removed',
          baseBlock: removed[removedIndex],
          draftBlock: null,
          insertBeforeDraftBlockId: added[addedIndex]?.id || fallbackBeforeId,
        });
      }

      for (; addedIndex < added.length; addedIndex += 1) {
        units.push({
          id: `added-${added[addedIndex].id}`,
          status: 'added',
          baseBlock: null,
          draftBlock: added[addedIndex],
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
  const prefix = content.slice(0, beforeBlock.leadingStartOffset);
  const suffix = content.slice(beforeBlock.leadingStartOffset);
  const separatorBefore = beforeBlock.leadingStartOffset === 0 ? leading : leading || '\n\n';
  const separatorAfter = suffix.length > 0 && !suffix.startsWith('\n') ? '\n\n' : '';
  return `${prefix}${separatorBefore}${markdown}${separatorAfter}${suffix}`;
}
