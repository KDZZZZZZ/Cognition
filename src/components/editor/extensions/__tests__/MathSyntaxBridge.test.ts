import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import {
  addIndexWithNeighbors,
  buildBridgeTransaction,
  clampTextSelectionPos,
  collectCandidateIndexes,
  collectIndexesOverlappingRange,
  collectTopLevelBlocks,
  createBridgeTransaction,
  createDisplayParagraph,
  findBlockIndexAtPos,
  findDisplayDelimiterPair,
  findFirstMatch,
  findInlineClose,
  findInlineMatches,
  findInlineParagraphMatch,
  findMultilineDisplayMatch,
  findSameParagraphDisplayMatch,
  findUnescaped,
  isPlainTopLevelParagraph,
  isEscaped,
} from '../MathSyntaxBridge';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    inlineMath: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: {
        latex: { default: '' },
        evaluate: { default: 'no' },
        display: { default: 'no' },
      },
      toDOM: (node) => ['span', { 'data-type': 'inlineMath', 'data-latex': node.attrs.latex }, node.attrs.latex],
      parseDOM: [{ tag: 'span[data-type="inlineMath"]' }],
    },
  },
  marks: {
    strong: {
      parseDOM: [{ tag: 'strong' }],
      toDOM: () => ['strong', 0],
    },
  },
});

const nestedSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    bulletList: { group: 'block', content: 'listItem+' },
    listItem: { content: 'paragraph+' },
    text: { group: 'inline' },
    inlineMath: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: {
        latex: { default: '' },
        evaluate: { default: 'no' },
        display: { default: 'no' },
      },
      toDOM: (node) => ['span', { 'data-type': 'inlineMath', 'data-latex': node.attrs.latex }, node.attrs.latex],
      parseDOM: [{ tag: 'span[data-type="inlineMath"]' }],
    },
  },
  marks: {
    strong: {
      parseDOM: [{ tag: 'strong' }],
      toDOM: () => ['strong', 0],
    },
  },
});

function createState(lines: string[]) {
  const doc = schema.node(
    'doc',
    null,
    lines.map((line) => schema.node('paragraph', null, line ? schema.text(line) : undefined))
  );
  const selectionPos = Math.min(3, doc.content.size);
  return EditorState.create({ schema, doc, selection: TextSelection.create(doc, selectionPos) });
}

function createNestedState(lines: string[]) {
  const doc = nestedSchema.node('doc', null, [
    nestedSchema.node(
      'bulletList',
      null,
      lines.map((line) =>
        nestedSchema.node(
          'listItem',
          null,
          nestedSchema.node(
            'paragraph',
            null,
            line ? nestedSchema.text(line) : undefined
          )
        )
      )
    ),
  ]);
  const selectionPos = Math.min(5, doc.content.size);
  return EditorState.create({
    schema: nestedSchema,
    doc,
    selection: TextSelection.create(doc, selectionPos),
  });
}

function createNestedMultiParagraphState(lines: string[]) {
  const doc = nestedSchema.node('doc', null, [
    nestedSchema.node(
      'bulletList',
      null,
      nestedSchema.node(
        'listItem',
        null,
        lines.map((line) =>
          nestedSchema.node(
            'paragraph',
            null,
            line ? nestedSchema.text(line) : undefined
          )
        )
      )
    ),
  ]);
  const selectionPos = Math.min(5, doc.content.size);
  return EditorState.create({
    schema: nestedSchema,
    doc,
    selection: TextSelection.create(doc, selectionPos),
  });
}

describe('MathSyntaxBridge helpers', () => {
  it('handles delimiter and escape parsing', () => {
    expect(findDisplayDelimiterPair('before $$x+y$$ after')?.content).toBe('x+y');
    expect(findDisplayDelimiterPair('before $$ $$ after')).toBeNull();

    expect(findInlineMatches('A $x$ and $y$')).toHaveLength(2);
    expect(findInlineMatches('escaped \\$x$')).toHaveLength(0);

    const text = String.raw`a \$ b $$ c`;
    expect(findUnescaped(text, '$$', 0)).toBe(7);
    expect(isEscaped('abc\\$d', 4)).toBe(true);
  });

  it('collects block metadata and candidate indexes', () => {
    const state = createState(['one', 'two', 'three']);
    const blocks = collectTopLevelBlocks(state.doc as any);

    expect(blocks).toHaveLength(3);
    expect(findBlockIndexAtPos(blocks as any, blocks[1].pos + 1)).toBe(1);

    const all = collectCandidateIndexes(blocks as any, state as any, undefined, 1);
    expect(all).toEqual([0, 1, 2]);

    const picked = new Set<number>();
    addIndexWithNeighbors(1, 3, 1, picked);
    expect([...picked].sort()).toEqual([0, 1, 2]);
  });

  it('finds same-paragraph, multiline, and inline matches', () => {
    const sameState = createState(['before $$x+y$$ after']);
    const sameBlocks = collectTopLevelBlocks(sameState.doc as any);
    const sameMatch = findSameParagraphDisplayMatch(sameBlocks as any, 0, schema.nodes.paragraph as any);
    expect(sameMatch?.kind).toBe('sameParagraphDisplay');

    const multiState = createState(['$$', 'E = mc^2', '$$']);
    const multiBlocks = collectTopLevelBlocks(multiState.doc as any);
    const multiMatch = findMultilineDisplayMatch(multiBlocks as any, 2, schema.nodes.paragraph as any, 8);
    expect(multiMatch?.kind).toBe('multilineDisplay');

    const inlineState = createState(['prefix $k$ suffix']);
    const inlineBlocks = collectTopLevelBlocks(inlineState.doc as any);
    const inlineMatch = findInlineParagraphMatch(inlineBlocks as any, 0, schema.nodes.paragraph as any);
    expect(inlineMatch?.kind).toBe('inlineParagraph');
    expect(inlineMatch?.matches).toHaveLength(1);
  });

  it('collects and bridges nested list paragraphs', () => {
    const nestedInlineState = createNestedState(['prefix $k$ suffix']);
    const nestedInlineBlocks = collectTopLevelBlocks(nestedInlineState.doc as any);
    expect(nestedInlineBlocks).toHaveLength(1);
    expect(findInlineParagraphMatch(nestedInlineBlocks as any, 0, nestedSchema.nodes.paragraph as any)?.kind).toBe(
      'inlineParagraph'
    );

    const nestedMultiState = createNestedMultiParagraphState(['$$', 'E = mc^2', '$$']);
    const nestedMultiBlocks = collectTopLevelBlocks(nestedMultiState.doc as any);
    expect(nestedMultiBlocks).toHaveLength(3);
    expect(
      findMultilineDisplayMatch(nestedMultiBlocks as any, 2, nestedSchema.nodes.paragraph as any, 8)?.kind
    ).toBe('multilineDisplay');

    const nestedInlineTx = createBridgeTransaction(nestedInlineState as any, {
      options: {
        maxScanBlocks: 16,
        neighborRadius: 1,
        enableDisplay: true,
        enableInline: true,
        maxInitialTransforms: 8,
      },
    } as any);
    expect(nestedInlineTx?.docChanged).toBe(true);
  });

  it('bridges inline math inside marked paragraphs without dropping marks', () => {
    const strong = schema.marks.strong.create();
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('输入', [strong]),
        schema.text(': 模型 $M_\\\\theta$, prompt $x_{prompt}$'),
      ]),
    ]);
    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, 2),
    });

    const tx = createBridgeTransaction(state as any, {
      options: {
        maxScanBlocks: 16,
        neighborRadius: 1,
        enableDisplay: true,
        enableInline: true,
        maxInitialTransforms: 8,
      },
    } as any);

    expect(tx?.docChanged).toBe(true);

    const paragraph = tx?.doc.firstChild;
    expect(paragraph?.firstChild?.marks.some((mark) => mark.type.name === 'strong')).toBe(true);
    expect(paragraph?.content.content.some((node) => node.type.name === 'inlineMath')).toBe(true);
    expect(paragraph?.textContent.includes('$M_')).toBe(false);
  });

  it('builds bridge transactions for inline and display transforms', () => {
    const inlineState = createState(['prefix $k$ suffix']);
    const inlineTx = createBridgeTransaction(inlineState as any, {
      options: {
        maxScanBlocks: 16,
        neighborRadius: 1,
        enableDisplay: true,
        enableInline: true,
        maxInitialTransforms: 4,
      },
    } as any);

    expect(inlineTx).toBeTruthy();
    expect(inlineTx?.docChanged).toBe(true);

    const displayState = createState(['before $$x$$ after']);
    const displayTx = createBridgeTransaction(displayState as any, {
      options: {
        maxScanBlocks: 16,
        neighborRadius: 1,
        enableDisplay: true,
        enableInline: false,
        maxInitialTransforms: 4,
      },
    } as any);
    expect(displayTx?.docChanged).toBe(true);

    expect(clampTextSelectionPos(0, displayState.doc as any)).toBe(1);
    expect(clampTextSelectionPos(9999, displayState.doc as any)).toBeLessThanOrEqual(displayState.doc.content.size);
  });

  it('covers createBridgeTransaction / match discovery guard branches', () => {
    const schemaNoMath = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { group: 'block', content: 'text*' },
        text: { group: 'inline' },
      },
    });
    const docNoMath = schemaNoMath.node('doc', null, [schemaNoMath.node('paragraph', null, schemaNoMath.text('$x$'))]);
    const stateNoMath = EditorState.create({ schema: schemaNoMath, doc: docNoMath });
    expect(
      createBridgeTransaction(stateNoMath as any, {
        options: {
          maxScanBlocks: 8,
          neighborRadius: 1,
          enableDisplay: true,
          enableInline: true,
          maxInitialTransforms: 2,
        },
      } as any)
    ).toBeNull();

    const blocks = collectTopLevelBlocks(createState(['plain text']).doc as any);
    expect(
      findFirstMatch(
        blocks as any,
        [0],
        schema.nodes.paragraph as any,
        {
          maxScanBlocks: 8,
          neighborRadius: 1,
          enableDisplay: false,
          enableInline: false,
          maxInitialTransforms: 1,
        }
      )
    ).toBeNull();
  });

  it('covers utility branches for range collection and paragraph checks', () => {
    const state = createState(['a', 'b', 'c']);
    const blocks = collectTopLevelBlocks(state.doc as any);

    const picked = new Set<number>();
    collectIndexesOverlappingRange(blocks as any, 999, 1000, 1, picked);
    expect([...picked]).toEqual([]);
    collectIndexesOverlappingRange(blocks as any, 0, 3, 1, picked);
    expect(picked.size).toBeGreaterThan(0);

    expect(
      collectCandidateIndexes(
        blocks as any,
        {
          ...state,
          selection: { to: -1 },
        } as any,
        state as any,
        1
      )
    ).toEqual([0, 1, 2]);

    const inlineMathNode = schema.nodes.inlineMath.create({ latex: 'x', display: 'no', evaluate: 'no' });
    const paragraphWithAtom = schema.nodes.paragraph.create(null, [inlineMathNode]);
    const fakeBlock: any = { node: paragraphWithAtom, pos: 0, index: 0 };
    expect(isPlainTopLevelParagraph(fakeBlock, schema.nodes.paragraph as any)).toBe(false);
    expect(findInlineClose('abc\n$def', 0)).toBe(-1);
  });

  it('covers bridge transaction branches for same-paragraph trailing empty and empty inline matches', () => {
    const sameState = createState(['before $$x$$']);
    const sameBlocks = collectTopLevelBlocks(sameState.doc as any);
    const sameTx = buildBridgeTransaction(
      sameState as any,
      sameBlocks as any,
      {
        kind: 'sameParagraphDisplay',
        blockIndex: 0,
        before: 'before ',
        after: '',
        latex: 'x',
      } as any,
      schema.nodes.paragraph as any,
      schema.nodes.inlineMath as any
    );
    expect(sameTx?.docChanged).toBe(true);

    const inlineState = createState(['']);
    const inlineBlocks = collectTopLevelBlocks(inlineState.doc as any);
    const inlineTx = buildBridgeTransaction(
      inlineState as any,
      inlineBlocks as any,
      {
        kind: 'inlineParagraph',
        blockIndex: 0,
        matches: [],
      } as any,
      schema.nodes.paragraph as any,
      schema.nodes.inlineMath as any
    );
    expect(inlineTx?.docChanged).toBe(true);

    const displayNode = createDisplayParagraph(schema.nodes.paragraph as any, schema.nodes.inlineMath as any, 'x+y');
    expect(displayNode.type.name).toBe('paragraph');
  });
});
