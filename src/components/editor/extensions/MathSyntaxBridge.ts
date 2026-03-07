import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode, NodeType } from '@tiptap/pm/model';
import { Fragment } from '@tiptap/pm/model';
import { Plugin, TextSelection } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';

export interface MathSyntaxBridgeOptions {
  maxScanBlocks: number;
  neighborRadius: number;
  enableDisplay: boolean;
  enableInline: boolean;
  maxInitialTransforms: number;
}

const BRIDGE_META_KEY = 'mathSyntaxBridgeApplied';

interface TopLevelBlock {
  node: ProseMirrorNode;
  pos: number;
  index: number;
  parent: ProseMirrorNode | null;
  childIndex: number;
}

interface SameParagraphDisplayMatch {
  kind: 'sameParagraphDisplay';
  blockIndex: number;
  before: string;
  after: string;
  latex: string;
}

interface MultilineDisplayMatch {
  kind: 'multilineDisplay';
  openIndex: number;
  closeIndex: number;
  latex: string;
}

interface InlineMatch {
  start: number;
  end: number;
  latex: string;
}

interface InlineTextRun {
  startChildIndex: number;
  endChildIndex: number;
  matches: InlineMatch[];
}

interface InlineParagraphMatch {
  kind: 'inlineParagraph';
  blockIndex: number;
  matches: InlineMatch[];
  runs: InlineTextRun[];
}

type BridgeMatch = SameParagraphDisplayMatch | MultilineDisplayMatch | InlineParagraphMatch;

export const MathSyntaxBridge = Extension.create<MathSyntaxBridgeOptions>({
  name: 'mathSyntaxBridge',
  priority: 1200,

  addOptions() {
    return {
      maxScanBlocks: 32,
      neighborRadius: 2,
      enableDisplay: true,
      enableInline: true,
      maxInitialTransforms: 256,
    };
  },

  onCreate() {
    let guard = 0;
    while (guard < this.options.maxInitialTransforms) {
      const tr = createBridgeTransaction(this.editor.state, {
        options: this.options,
      });
      if (!tr) break;
      this.editor.view.dispatch(tr);
      guard += 1;
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, oldState, newState) => {
          const docChanged = transactions.some((tr) => tr.docChanged);
          if (!docChanged) return null;
          if (transactions.some((tr) => tr.getMeta(BRIDGE_META_KEY))) return null;

          return createBridgeTransaction(newState, {
            oldState,
            options: this.options,
          });
        },
      }),
    ];
  },
});

interface BuildContext {
  oldState?: EditorState;
  options: MathSyntaxBridgeOptions;
}

export function createBridgeTransaction(state: EditorState, context: BuildContext): Transaction | null {
  const paragraphType = state.schema.nodes.paragraph;
  const inlineMathType = state.schema.nodes.inlineMath;
  if (!paragraphType || !inlineMathType) return null;

  const blocks = collectTopLevelBlocks(state.doc);
  const candidateIndexes = collectCandidateIndexes(blocks, state, context.oldState, context.options.neighborRadius);
  if (candidateIndexes.length === 0) return null;

  const match = findFirstMatch(blocks, candidateIndexes, paragraphType, context.options);
  if (!match) return null;

  return buildBridgeTransaction(state, blocks, match, paragraphType, inlineMathType);
}

export function findFirstMatch(
  blocks: TopLevelBlock[],
  candidateIndexes: number[],
  paragraphType: NodeType,
  options: MathSyntaxBridgeOptions
): BridgeMatch | null {
  if (options.enableDisplay) {
    for (const index of candidateIndexes) {
      const multiline = findMultilineDisplayMatch(blocks, index, paragraphType, options.maxScanBlocks);
      if (multiline) return multiline;
    }

    for (const index of candidateIndexes) {
      const sameParagraph = findSameParagraphDisplayMatch(blocks, index, paragraphType);
      if (sameParagraph) return sameParagraph;
    }
  }

  if (options.enableInline) {
    for (const index of candidateIndexes) {
      const inlineMatch = findInlineParagraphMatch(blocks, index, paragraphType);
      if (inlineMatch) return inlineMatch;
    }
  }

  return null;
}

export function buildBridgeTransaction(
  state: EditorState,
  blocks: TopLevelBlock[],
  match: BridgeMatch,
  paragraphType: NodeType,
  inlineMathType: NodeType
): Transaction | null {
  const tr = state.tr;
  const originalSelectionPos = state.selection.to;

  if (match.kind === 'multilineDisplay') {
    const openBlock = blocks[match.openIndex];
    const closeBlock = blocks[match.closeIndex];
    const displayParagraph = createDisplayParagraph(paragraphType, inlineMathType, match.latex);
    const trailingParagraph = paragraphType.create();

    const from = openBlock.pos;
    const to = closeBlock.pos + closeBlock.node.nodeSize;
    tr.replaceWith(from, to, Fragment.fromArray([displayParagraph, trailingParagraph]));

    if (!tr.docChanged) return null;

    const desiredPos = clampTextSelectionPos(from + displayParagraph.nodeSize + 1, tr.doc);
    tr.setSelection(TextSelection.create(tr.doc, desiredPos));
    tr.setMeta(BRIDGE_META_KEY, true);
    return tr;
  }

  if (match.kind === 'sameParagraphDisplay') {
    const block = blocks[match.blockIndex];
    const replacement: ProseMirrorNode[] = [];

    if (match.before.length > 0) {
      replacement.push(paragraphType.create(null, paragraphType.schema.text(match.before)));
    }
    replacement.push(createDisplayParagraph(paragraphType, inlineMathType, match.latex));

    const trailingText = match.after;
    replacement.push(
      trailingText.length > 0
        ? paragraphType.create(null, paragraphType.schema.text(trailingText))
        : paragraphType.create()
    );

    const from = block.pos;
    const to = block.pos + block.node.nodeSize;
    tr.replaceWith(from, to, Fragment.fromArray(replacement));

    if (!tr.docChanged) return null;

    const trailingIndex = replacement.length - 1;
    const trailingStart = from + replacement
      .slice(0, trailingIndex)
      .reduce((sum, node) => sum + node.nodeSize, 0);
    const desiredPos = clampTextSelectionPos(trailingStart + 1 + trailingText.length, tr.doc);

    tr.setSelection(TextSelection.create(tr.doc, desiredPos));
    tr.setMeta(BRIDGE_META_KEY, true);
    return tr;
  }

  const block = blocks[match.blockIndex];
  const children = buildInlineParagraphChildren(block.node, match.runs || [], paragraphType, inlineMathType);

  const paragraph = paragraphType.create(null, children.length > 0 ? children : undefined);
  const from = block.pos;
  const to = block.pos + block.node.nodeSize;

  tr.replaceWith(from, to, paragraph);
  if (!tr.docChanged) return null;

  const mappedSelection = clampTextSelectionPos(tr.mapping.map(originalSelectionPos, 1), tr.doc);
  tr.setSelection(TextSelection.create(tr.doc, mappedSelection));
  tr.setMeta(BRIDGE_META_KEY, true);
  return tr;
}

export function collectTopLevelBlocks(doc: ProseMirrorNode): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  doc.descendants((node, pos, parent, index) => {
    if (node.type.name !== 'paragraph') {
      return true;
    }

    blocks.push({
      node,
      pos,
      index: blocks.length,
      parent: parent ?? null,
      childIndex: typeof index === 'number' ? index : blocks.length,
    });
    return true;
  });
  return blocks;
}

export function collectCandidateIndexes(
  blocks: TopLevelBlock[],
  newState: EditorState,
  oldState: EditorState | undefined,
  neighborRadius: number
): number[] {
  if (blocks.length === 0) return [];

  const picked = new Set<number>();

  if (!oldState) {
    for (const block of blocks) {
      picked.add(block.index);
    }
    return [...picked];
  }

  const diffStart = oldState.doc.content.findDiffStart(newState.doc.content);
  const diffEnd = oldState.doc.content.findDiffEnd(newState.doc.content);

  if (diffStart !== null) {
    const rangeStart = Math.max(0, diffStart - 1);
    const rangeEnd = Math.max(rangeStart, (diffEnd?.b ?? diffStart) + 1);
    collectIndexesOverlappingRange(blocks, rangeStart, rangeEnd, neighborRadius, picked);
  }

  const selectionBlockIndex = findBlockIndexAtPos(blocks, newState.selection.to);
  if (selectionBlockIndex >= 0) {
    addIndexWithNeighbors(selectionBlockIndex, blocks.length, neighborRadius, picked);
  }

  if (picked.size === 0) {
    for (const block of blocks) {
      picked.add(block.index);
    }
  }

  return [...picked].sort((a, b) => a - b);
}

export function collectIndexesOverlappingRange(
  blocks: TopLevelBlock[],
  from: number,
  to: number,
  neighborRadius: number,
  picked: Set<number>
) {
  for (const block of blocks) {
    const blockStart = block.pos;
    const blockEnd = block.pos + block.node.nodeSize;
    const overlaps = blockStart <= to && blockEnd >= from;
    if (!overlaps) continue;
    addIndexWithNeighbors(block.index, blocks.length, neighborRadius, picked);
  }
}

export function addIndexWithNeighbors(index: number, max: number, radius: number, picked: Set<number>) {
  const start = Math.max(0, index - radius);
  const end = Math.min(max - 1, index + radius);
  for (let i = start; i <= end; i += 1) {
    picked.add(i);
  }
}

export function findBlockIndexAtPos(blocks: TopLevelBlock[], pos: number): number {
  for (const block of blocks) {
    const start = block.pos;
    const end = block.pos + block.node.nodeSize;
    if (pos >= start && pos <= end) {
      return block.index;
    }
  }
  return -1;
}

export function findMultilineDisplayMatch(
  blocks: TopLevelBlock[],
  closeIndex: number,
  paragraphType: NodeType,
  maxScanBlocks: number
): MultilineDisplayMatch | null {
  const closeBlock = blocks[closeIndex];
  if (!isPlainTopLevelParagraph(closeBlock, paragraphType)) return null;
  if (closeBlock.node.textContent.trim() !== '$$') return null;

  const lowestOpenIndex = Math.max(0, closeIndex - maxScanBlocks);
  for (let openIndex = closeIndex - 1; openIndex >= lowestOpenIndex; openIndex -= 1) {
    const openBlock = blocks[openIndex];
    if (!isPlainTopLevelParagraph(openBlock, paragraphType)) continue;
    if (openBlock.node.textContent.trim() !== '$$') continue;
    if (openBlock.parent !== closeBlock.parent) continue;

    const between = blocks.slice(openIndex + 1, closeIndex);
    if (between.length === 0) continue;
    if (between.some((item) => !isPlainTopLevelParagraph(item, paragraphType))) continue;
    if (between.some((item) => item.parent !== openBlock.parent)) continue;
    if (closeBlock.childIndex - openBlock.childIndex !== between.length + 1) continue;
    if (
      between.some(
        (item, betweenIndex) => item.childIndex !== openBlock.childIndex + betweenIndex + 1
      )
    ) {
      continue;
    }

    const latexRaw = between.map((item) => item.node.textContent).join('\n');
    const latex = latexRaw.trim();
    if (!latex) continue;

    return {
      kind: 'multilineDisplay',
      openIndex,
      closeIndex,
      latex,
    };
  }

  return null;
}

export function findSameParagraphDisplayMatch(
  blocks: TopLevelBlock[],
  index: number,
  paragraphType: NodeType
): SameParagraphDisplayMatch | null {
  const block = blocks[index];
  if (!isPlainTopLevelParagraph(block, paragraphType)) return null;

  const text = block.node.textContent;
  if (!text.includes('$$')) return null;

  const match = findDisplayDelimiterPair(text);
  if (!match) return null;

  const latex = match.content.trim();
  if (!latex) return null;

  return {
    kind: 'sameParagraphDisplay',
    blockIndex: index,
    before: text.slice(0, match.start),
    after: text.slice(match.end),
    latex,
  };
}

export function findInlineParagraphMatch(
  blocks: TopLevelBlock[],
  index: number,
  paragraphType: NodeType
): InlineParagraphMatch | null {
  const block = blocks[index];
  if (block.node.type !== paragraphType) return null;

  const runs = collectInlineTextRuns(block.node);
  if (!runs || runs.length === 0) return null;
  const matches = runs.flatMap((run) => run.matches);

  return {
    kind: 'inlineParagraph',
    blockIndex: index,
    matches,
    runs,
  };
}

export function isPlainTopLevelParagraph(block: TopLevelBlock, paragraphType: NodeType): boolean {
  if (block.node.type !== paragraphType) return false;
  if (block.node.childCount === 0) return true;

  for (let i = 0; i < block.node.childCount; i += 1) {
    const child = block.node.child(i);
    if (!child.isText) return false;
    if (child.marks.length > 0) return false;
  }

  return true;
}

export function collectInlineTextRuns(paragraph: ProseMirrorNode): InlineTextRun[] | null {
  const runs: InlineTextRun[] = [];
  let startChildIndex = -1;
  let bufferedText = '';

  const flush = (endChildIndex: number) => {
    if (startChildIndex < 0 || bufferedText.length === 0) {
      startChildIndex = -1;
      bufferedText = '';
      return;
    }

    if (bufferedText.includes('$')) {
      const matches = findInlineMatches(bufferedText);
      if (matches.length > 0) {
        runs.push({
          startChildIndex,
          endChildIndex,
          matches,
        });
      }
    }

    startChildIndex = -1;
    bufferedText = '';
  };

  for (let i = 0; i < paragraph.childCount; i += 1) {
    const child = paragraph.child(i);
    if (child.isText) {
      if (startChildIndex < 0) startChildIndex = i;
      bufferedText += child.text || '';
      continue;
    }

    flush(i - 1);
    if (child.type.name !== 'inlineMath') {
      return null;
    }
  }

  flush(paragraph.childCount - 1);
  return runs;
}

function buildInlineParagraphChildren(
  paragraph: ProseMirrorNode,
  runs: InlineTextRun[],
  paragraphType: NodeType,
  inlineMathType: NodeType
): ProseMirrorNode[] {
  if (runs.length === 0) {
    const children: ProseMirrorNode[] = [];
    paragraph.forEach((child) => {
      children.push(child);
    });
    return children;
  }

  const children: ProseMirrorNode[] = [];
  let runIndex = 0;

  for (let childIndex = 0; childIndex < paragraph.childCount; childIndex += 1) {
    const child = paragraph.child(childIndex);
    const currentRun = runs[runIndex];

    if (currentRun && childIndex === currentRun.startChildIndex) {
      const runNodes: ProseMirrorNode[] = [];
      for (let runChildIndex = currentRun.startChildIndex; runChildIndex <= currentRun.endChildIndex; runChildIndex += 1) {
        runNodes.push(paragraph.child(runChildIndex));
      }
      children.push(...buildInlineRunChildren(runNodes, currentRun.matches, paragraphType, inlineMathType));
      childIndex = currentRun.endChildIndex;
      runIndex += 1;
      continue;
    }

    children.push(child);
  }

  return children;
}

function buildInlineRunChildren(
  runNodes: ProseMirrorNode[],
  matches: InlineMatch[],
  paragraphType: NodeType,
  inlineMathType: NodeType
): ProseMirrorNode[] {
  const children: ProseMirrorNode[] = [];
  const runLength = runNodes.reduce((sum, node) => sum + ((node.text || '').length), 0);
  let pointer = 0;

  for (const match of matches) {
    appendMarkedTextSlice(children, runNodes, pointer, match.start, paragraphType);
    children.push(
      inlineMathType.create({
        latex: match.latex,
        evaluate: 'no',
        display: 'no',
      })
    );
    pointer = match.end;
  }

  appendMarkedTextSlice(children, runNodes, pointer, runLength, paragraphType);
  return children;
}

function appendMarkedTextSlice(
  children: ProseMirrorNode[],
  runNodes: ProseMirrorNode[],
  from: number,
  to: number,
  paragraphType: NodeType
) {
  if (to <= from) return;

  let offset = 0;
  for (const node of runNodes) {
    const text = node.text || '';
    const nodeStart = offset;
    const nodeEnd = offset + text.length;
    offset = nodeEnd;

    if (to <= nodeStart || from >= nodeEnd) continue;

    const localStart = Math.max(0, from - nodeStart);
    const localEnd = Math.min(text.length, to - nodeStart);
    const slice = text.slice(localStart, localEnd);
    if (!slice) continue;

    children.push(paragraphType.schema.text(slice, node.marks));
  }
}

export function createDisplayParagraph(paragraphType: NodeType, inlineMathType: NodeType, latex: string): ProseMirrorNode {
  return paragraphType.create(
    null,
    inlineMathType.create({
      latex,
      evaluate: 'no',
      display: 'yes',
    })
  );
}

export function findDisplayDelimiterPair(text: string): { start: number; end: number; content: string } | null {
  let open = findUnescaped(text, '$$', 0);
  while (open >= 0) {
    const close = findUnescaped(text, '$$', open + 2);
    if (close < 0) return null;

    const content = text.slice(open + 2, close);
    if (content.trim().length > 0) {
      return {
        start: open,
        end: close + 2,
        content,
      };
    }

    open = findUnescaped(text, '$$', close + 2);
  }

  return null;
}

export function findInlineMatches(text: string): InlineMatch[] {
  const matches: InlineMatch[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch !== '$') {
      cursor += 1;
      continue;
    }
    if (isEscaped(text, cursor)) {
      cursor += 1;
      continue;
    }
    if (text[cursor + 1] === '$') {
      cursor += 2;
      continue;
    }

    const close = findInlineClose(text, cursor + 1);
    if (close < 0) {
      cursor += 1;
      continue;
    }

    const latexRaw = text.slice(cursor + 1, close);
    const latex = latexRaw.trim();
    if (latex.length > 0) {
      matches.push({
        start: cursor,
        end: close + 1,
        latex,
      });
      cursor = close + 1;
      continue;
    }

    cursor = close + 1;
  }

  return matches;
}

export function findInlineClose(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n') return -1;
    if (ch !== '$') continue;
    if (isEscaped(text, i)) continue;
    if (text[i + 1] === '$') continue;
    return i;
  }
  return -1;
}

export function findUnescaped(text: string, token: string, from: number): number {
  let index = Math.max(0, from);
  while (index < text.length) {
    const found = text.indexOf(token, index);
    if (found < 0) return -1;
    if (!isEscaped(text, found)) return found;
    index = found + token.length;
  }
  return -1;
}

export function isEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  let ptr = index - 1;
  while (ptr >= 0 && text[ptr] === '\\') {
    slashCount += 1;
    ptr -= 1;
  }
  return slashCount % 2 === 1;
}

export function clampTextSelectionPos(pos: number, doc: ProseMirrorNode): number {
  const clamped = Math.max(1, Math.min(pos, doc.content.size));
  try {
    return TextSelection.near(doc.resolve(clamped), 1).from;
  } catch {
    return clamped;
  }
}
