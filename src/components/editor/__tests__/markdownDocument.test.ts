import { describe, expect, it } from 'vitest';

import {
  buildMarkdownVisualUnits,
  buildMarkdownDiffUnits,
  createMarkdownEditTransaction,
  insertEmptyParagraphAfterBlock,
  insertEmptyParagraphAtEnd,
  insertEmptyParagraphBeforeBlock,
  insertMarkdownBlockBefore,
  materializeEmptyParagraphLine,
  parseMarkdownDocument,
} from '../markdownDocument';

describe('markdownDocument shared edit model', () => {
  it('captures block format hints and editor kinds for a mixed markdown document', () => {
    const content = [
      '---',
      'title: Example',
      '---',
      '',
      '## Heading',
      '',
      '1) first',
      '2) second',
      '',
      '```ts',
      'const answer = 42;',
      '```',
      '',
      '| A | B |',
      '| :--- | ---: |',
      '| 1 | 2 |',
    ].join('\n');

    const document = parseMarkdownDocument(content);

    expect(document.blocks[0].kind).toBe('frontmatter');
    expect(document.blocks[0].formatHints.frontmatterDelimiter).toBe('---');

    const headingBlock = document.blocks.find((block) => block.kind === 'heading');
    expect(headingBlock?.formatHints.headingSpacing).toBe(' ');
    expect(headingBlock?.activeEditorKind).toBe('rich_text');

    const listBlock = document.blocks.find((block) => block.kind === 'list');
    expect(listBlock?.formatHints.orderedDelimiter).toBe(')');

    const codeBlock = document.blocks.find((block) => block.kind === 'code');
    expect(codeBlock?.formatHints.fenceMarker).toBe('`');
    expect(codeBlock?.formatHints.fenceLength).toBe(3);
    expect(codeBlock?.activeEditorKind).toBe('code');

    const tableBlock = document.blocks.find((block) => block.kind === 'table');
    expect(tableBlock?.formatHints.tableAlignment).toEqual(['left', 'right']);
    expect(tableBlock?.activeEditorKind).toBe('table_grid');
  });

  it('tracks footnote dependencies and builds block-local edit transactions', () => {
    const content = ['Paragraph with note[^1].', '', '[^1]: original note'].join('\n');
    const document = parseMarkdownDocument(content);

    const paragraphBlock = document.blocks.find((block) => block.kind === 'paragraph');
    const footnoteBlock = document.blocks.find((block) => block.kind === 'footnote');

    expect(paragraphBlock?.dependencyIds).toEqual(['footnote:1']);
    expect(footnoteBlock?.dependencyIds).toEqual(['footnote:1']);

    const transaction = createMarkdownEditTransaction(footnoteBlock!, '[^1]: updated note', [paragraphBlock!.id]);
    expect(transaction.patches).toEqual([
      {
        blockId: footnoteBlock!.id,
        startOffset: footnoteBlock!.startOffset,
        endOffset: footnoteBlock!.endOffset,
        markdown: '[^1]: updated note',
      },
    ]);
    expect(transaction.dependentBlockIds).toEqual([paragraphBlock!.id]);
    expect(transaction.selectionRestoreHint).toBe(footnoteBlock!.stableId);
    expect(transaction.reparseMode).toBe('transition');
  });

  it('marks mermaid and html blocks with dedicated editor kinds', () => {
    const content = ['```mermaid', 'graph TD', '  A-->B', '```', '', '<div>hello</div>'].join('\n');
    const document = parseMarkdownDocument(content);

    const codeBlock = document.blocks.find((block) => block.kind === 'code');
    const htmlBlock = document.blocks.find((block) => block.kind === 'html');

    expect(codeBlock?.activeEditorKind).toBe('mermaid');
    expect(htmlBlock?.activeEditorKind).toBe('source_drawer');
  });

  it('recognizes standalone image markdown even when the parser leaves it as paragraph text', () => {
    const content = '![chart](data:image/svg+xml,%3Csvg%20viewBox%3D%220%200%20120%2072%22%3E%3C/svg%3E "preview")';
    const document = parseMarkdownDocument(content);

    expect(document.blocks[0]?.kind).toBe('image');
    expect(document.blocks[0]?.activeEditorKind).toBe('image');
  });

  it('pairs removed and added blocks as modified only when their kinds are compatible', () => {
    const base = ['> [!NOTE] Base callout', '', 'Base paragraph'].join('\n');
    const draft = ['Draft paragraph', '', '> [!NOTE] Draft callout'].join('\n');

    const units = buildMarkdownDiffUnits(base, draft).map((unit) => ({
      status: unit.status,
      baseKind: unit.baseBlock?.kind ?? null,
      draftKind: unit.draftBlock?.kind ?? null,
    }));

    expect(units).toContainEqual({
      status: 'modified',
      baseKind: 'callout',
      draftKind: 'callout',
    });
    expect(units).not.toContainEqual({
      status: 'modified',
      baseKind: 'callout',
      draftKind: 'paragraph',
    });
    expect(units).not.toContainEqual({
      status: 'modified',
      baseKind: 'paragraph',
      draftKind: 'callout',
    });
  });

  it('keeps inserted paragraphs separate from nearby modified paragraphs', () => {
    const base = ['# Heading', '', 'Intro paragraph.'].join('\n');
    const draft = ['# Heading', '', 'Between heading and intro', '', 'Intro paragraph updated.'].join('\n');

    const units = buildMarkdownDiffUnits(base, draft).map((unit) => ({
      status: unit.status,
      base: unit.baseBlock?.markdown ?? null,
      draft: unit.draftBlock?.markdown ?? null,
    }));

    expect(units).toContainEqual({
      status: 'added',
      base: null,
      draft: 'Between heading and intro',
    });
    expect(units).toContainEqual({
      status: 'modified',
      base: 'Intro paragraph.',
      draft: 'Intro paragraph updated.',
    });
    expect(units).not.toContainEqual({
      status: 'modified',
      base: 'Intro paragraph.',
      draft: 'Between heading and intro',
    });
  });

  it('inserts a new block between existing blocks without merging into neighbors', () => {
    const content = ['# Heading', '', 'Paragraph'].join('\n');
    const document = parseMarkdownDocument(content);
    const paragraphBlock = document.blocks.find((block) => block.kind === 'paragraph');

    expect(
      insertMarkdownBlockBefore(content, paragraphBlock || null, 'Inserted paragraph')
    ).toBe(['# Heading', '', 'Inserted paragraph', '', 'Paragraph'].join('\n'));
  });

  it('inserts a new block before the first block without adding stray leading blank lines', () => {
    const content = ['# Heading', '', 'Paragraph'].join('\n');
    const document = parseMarkdownDocument(content);

    expect(insertMarkdownBlockBefore(content, document.blocks[0] || null, 'Inserted paragraph')).toBe(
      ['Inserted paragraph', '', '# Heading', '', 'Paragraph'].join('\n')
    );
  });

  it('does not surface the first structural blank line between blocks as an empty paragraph unit', () => {
    const document = parseMarkdownDocument(['# Heading', '', 'Paragraph'].join('\n'));

    expect(buildMarkdownVisualUnits(document).filter((unit) => unit.kind === 'empty_paragraph_line')).toHaveLength(0);
  });

  it('surfaces extra blank lines between blocks as empty paragraph units', () => {
    const document = parseMarkdownDocument(['# Heading', '', '', 'Paragraph'].join('\n'));

    const emptyUnits = buildMarkdownVisualUnits(document).filter((unit) => unit.kind === 'empty_paragraph_line');
    expect(emptyUnits).toHaveLength(1);
  });

  it('surfaces trailing blank lines as empty paragraph units', () => {
    const document = parseMarkdownDocument('Paragraph\n');

    const emptyUnits = buildMarkdownVisualUnits(document).filter((unit) => unit.kind === 'empty_paragraph_line');
    expect(emptyUnits).toHaveLength(1);
  });

  it('inserts a real empty paragraph before an existing block', () => {
    const content = ['# Heading', '', 'Paragraph'].join('\n');
    const document = parseMarkdownDocument(content);
    const paragraphBlock = document.blocks.find((block) => block.kind === 'paragraph');

    expect(insertEmptyParagraphBeforeBlock(content, document, paragraphBlock!.id)).toEqual({
      content: ['# Heading', '', '', 'Paragraph'].join('\n'),
      insertedUnitId: 'empty-paragraph:11',
    });
  });

  it('inserts a real empty paragraph after an existing block', () => {
    const content = ['# Heading', '', 'Paragraph'].join('\n');
    const document = parseMarkdownDocument(content);
    const headingBlock = document.blocks.find((block) => block.kind === 'heading');

    expect(insertEmptyParagraphAfterBlock(content, document, headingBlock!.id)).toEqual({
      content: ['# Heading', '', '', 'Paragraph'].join('\n'),
      insertedUnitId: 'empty-paragraph:11',
    });
  });

  it('inserts a trailing empty paragraph at document end', () => {
    expect(insertEmptyParagraphAtEnd('Paragraph')).toEqual({
      content: 'Paragraph\n',
      insertedUnitId: 'empty-paragraph:9',
    });
  });

  it('materializes an empty paragraph line into a real paragraph block', () => {
    const content = ['# Heading', '', '', 'Paragraph'].join('\n');
    const document = parseMarkdownDocument(content);
    const emptyUnit = buildMarkdownVisualUnits(document).find((unit) => unit.kind === 'empty_paragraph_line');

    expect(materializeEmptyParagraphLine(content, emptyUnit!, 'Inserted paragraph')).toEqual({
      content: ['# Heading', '', 'Inserted paragraph', '', 'Paragraph'].join('\n'),
      insertedBlockStartOffset: 11,
    });
  });
});
