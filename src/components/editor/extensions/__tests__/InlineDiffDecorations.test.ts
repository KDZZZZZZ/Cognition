import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';

import {
  collectInlineDiffDescriptors,
  collectVisibleChars,
  markdownToInlineDiffText,
} from '../InlineDiffDecorations';

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
  },
});

describe('InlineDiffDecorations', () => {
  it('normalizes markdown into comparable visible text', () => {
    expect(markdownToInlineDiffText('# Hello **world**\n\n> quote')).toBe('Helloworldquote');
  });

  it('strips raw html tags while deriving comparable text', () => {
    expect(markdownToInlineDiffText('before <span data-x=\"1\">inside</span> after')).toBe('beforeinsideafter');
  });

  it('collects visible non-whitespace characters with document positions', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('a b')])]);

    expect(collectVisibleChars(doc)).toEqual([
      { char: 'a', from: 1, to: 2 },
      { char: 'b', from: 3, to: 4 },
    ]);
  });

  it('emits added inline ranges for newly inserted text', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello brave world')])]);
    const state = EditorState.create({ schema, doc });

    expect(collectInlineDiffDescriptors(state, 'hello world')).toEqual([
      {
        kind: 'added',
        from: 7,
        to: 12,
        text: 'brave',
      },
    ]);
  });

  it('emits removed widgets at the matching insertion point', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello world')])]);
    const state = EditorState.create({ schema, doc });

    expect(collectInlineDiffDescriptors(state, 'hello brave world')).toEqual([
      {
        kind: 'removed',
        pos: 7,
        text: 'brave',
      },
    ]);
  });

  it('skips long removed widgets that would become noisy pills', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello world')])]);
    const state = EditorState.create({ schema, doc });

    expect(collectInlineDiffDescriptors(state, 'hello thisisaverylongremovedsegment world')).toEqual([]);
  });

  it('skips removed widgets that are only punctuation noise', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('hello world')])]);
    const state = EditorState.create({ schema, doc });

    expect(collectInlineDiffDescriptors(state, '!hello world')).toEqual([]);
  });
});
