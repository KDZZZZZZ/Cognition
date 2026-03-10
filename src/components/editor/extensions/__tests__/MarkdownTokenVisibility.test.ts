import { Schema } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import { collectActiveMarkdownTokens } from '../MarkdownTokenVisibility';

const schema = new Schema({
  nodes: {
    doc: {
      content: 'block+',
    },
    paragraph: {
      group: 'block',
      content: 'inline*',
      parseDOM: [{ tag: 'p' }],
      toDOM: () => ['p', 0],
    },
    text: {
      group: 'inline',
    },
    inlineMath: {
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      attrs: {
        latex: { default: '' },
      },
      parseDOM: [
        {
          tag: 'math-inline',
          getAttrs: (node) => ({
            latex: (node as HTMLElement).getAttribute('data-latex') || '',
          }),
        },
      ],
      toDOM: (node) => ['math-inline', { 'data-latex': node.attrs.latex }],
    },
  },
  marks: {
    bold: {
      parseDOM: [{ tag: 'strong' }],
      toDOM: () => ['strong', 0],
    },
    italic: {
      parseDOM: [{ tag: 'em' }],
      toDOM: () => ['em', 0],
    },
    strike: {
      parseDOM: [{ tag: 's' }],
      toDOM: () => ['s', 0],
    },
    code: {
      parseDOM: [{ tag: 'code' }],
      toDOM: () => ['code', 0],
    },
    link: {
      attrs: {
        href: { default: '' },
        title: { default: null },
      },
      inclusive: false,
      parseDOM: [
        {
          tag: 'a',
          getAttrs: (node) => ({
            href: (node as HTMLElement).getAttribute('href') || '',
            title: (node as HTMLElement).getAttribute('title'),
          }),
        },
      ],
      toDOM: (node) => ['a', { href: node.attrs.href, title: node.attrs.title }, 0],
    },
  },
});

function positionInsideText(doc: Parameters<typeof TextSelection.create>[0], needle: string) {
  let resolved = -1;

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    const index = node.text.indexOf(needle);
    if (index === -1) return true;
    resolved = pos + index + 1;
    return false;
  });

  if (resolved === -1) {
    throw new Error(`Unable to find text position for "${needle}".`);
  }

  return resolved;
}

describe('MarkdownTokenVisibility', () => {
  it('emits bold markers around the active strong token', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('prefix '),
        schema.text('bold', [schema.marks.bold.create()]),
        schema.text(' suffix'),
      ]),
    ]);

    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, positionInsideText(doc, 'bold')),
    });

    expect(collectActiveMarkdownTokens(state)).toEqual([
      {
        kind: 'bold',
        from: 8,
        to: 12,
        open: '**',
        close: '**',
      },
    ]);
  });

  it('emits link markers with href and title for the active link token', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('Read '),
        schema.text('docs', [
          schema.marks.link.create({
            href: 'https://platform.openai.com/docs',
            title: 'OpenAI Docs',
          }),
        ]),
      ]),
    ]);

    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, positionInsideText(doc, 'docs')),
    });

    expect(collectActiveMarkdownTokens(state)).toEqual([
      {
        kind: 'link',
        from: 6,
        to: 10,
        open: '[',
        close: '](https://platform.openai.com/docs "OpenAI Docs")',
      },
    ]);
  });

  it('emits inline math markers when the inline math node is selected', () => {
    const inlineMath = schema.node('inlineMath', { latex: 'a+b' });
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('x '), inlineMath, schema.text(' y')]),
    ]);

    let inlineMathPos = -1;
    doc.descendants((node, pos) => {
      if (node.type === schema.nodes.inlineMath) {
        inlineMathPos = pos;
        return false;
      }
      return true;
    });

    const state = EditorState.create({
      schema,
      doc,
      selection: NodeSelection.create(doc, inlineMathPos),
    });

    expect(collectActiveMarkdownTokens(state)).toEqual([
      {
        kind: 'inlineMath',
        from: inlineMathPos,
        to: inlineMathPos + inlineMath.nodeSize,
        open: '$',
        close: '$',
      },
    ]);
  });

  it('does not emit markers when the selection is outside markdown tokens', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('plain text only')]),
    ]);

    const state = EditorState.create({
      schema,
      doc,
      selection: TextSelection.create(doc, positionInsideText(doc, 'plain')),
    });

    expect(collectActiveMarkdownTokens(state)).toEqual([]);
  });
});
