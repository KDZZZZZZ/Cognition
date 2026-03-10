import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { diffChars } from 'diff';
import { toString } from 'mdast-util-to-string';
import type { Root } from 'mdast';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

interface InlineDiffOptions {
  baseMarkdown: string;
  enabled: boolean;
}

interface VisibleChar {
  char: string;
  from: number;
  to: number;
}

export type InlineDiffDescriptor =
  | {
      kind: 'added';
      from: number;
      to: number;
      text: string;
    }
  | {
      kind: 'removed';
      pos: number;
      text: string;
    };

const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkGfm)
  .use(remarkMath);

const inlineDiffDecorationsKey = new PluginKey<DecorationSet>('inlineDiffDecorations');

export const InlineDiffDecorations = Extension.create<InlineDiffOptions>({
  name: 'inlineDiffDecorations',

  addOptions() {
    return {
      baseMarkdown: '',
      enabled: false,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;

    return [
      new Plugin({
        key: inlineDiffDecorationsKey,
        state: {
          init: (_config, state) => buildInlineDiffDecorationSet(state, options),
          apply: (tr, value, _oldState, newState) => {
            if (!tr.docChanged) {
              return value;
            }
            return buildInlineDiffDecorationSet(newState, options);
          },
        },
        props: {
          decorations(state) {
            return inlineDiffDecorationsKey.getState(state) || null;
          },
        },
      }),
    ];
  },
});

export function markdownToInlineDiffText(markdown: string) {
  if (!markdown.trim()) return '';

  try {
    const root = processor.parse(markdown) as Root;
    return toString(root).replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  } catch {
    return markdown.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  }
}

export function collectVisibleChars(doc: ProseMirrorNode) {
  const chars: VisibleChar[] = [];

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;

    for (let index = 0; index < node.text.length; index += 1) {
      const char = node.text[index];
      if (/\s/.test(char)) continue;
      chars.push({
        char,
        from: pos + index,
        to: pos + index + 1,
      });
    }

    return true;
  });

  return chars;
}

export function collectInlineDiffDescriptors(state: EditorState, baseMarkdown: string): InlineDiffDescriptor[] {
  const baseText = markdownToInlineDiffText(baseMarkdown);
  if (!baseText) return [];

  const visibleChars = collectVisibleChars(state.doc);
  const currentText = visibleChars.map((item) => item.char).join('');
  if (!currentText && !baseText) return [];

  const descriptors: InlineDiffDescriptor[] = [];
  const parts = diffChars(baseText, currentText);
  let currentOffset = 0;

  for (const part of parts) {
    if (part.added) {
      const chars = visibleChars.slice(currentOffset, currentOffset + part.value.length);
      for (const range of mergeVisibleRanges(chars)) {
        descriptors.push({
          kind: 'added',
          from: range.from,
          to: range.to,
          text: part.value,
        });
      }
      currentOffset += part.value.length;
      continue;
    }

    if (part.removed) {
      if (!shouldRenderRemovedWidget(part.value)) {
        continue;
      }
      descriptors.push({
        kind: 'removed',
        pos: resolveWidgetPos(visibleChars, currentOffset, state.doc),
        text: part.value,
      });
      continue;
    }

    currentOffset += part.value.length;
  }

  return descriptors;
}

function buildInlineDiffDecorationSet(state: EditorState, options: InlineDiffOptions) {
  if (!options.enabled || !options.baseMarkdown.trim()) {
    return DecorationSet.empty;
  }

  const decorations = collectInlineDiffDescriptors(state, options.baseMarkdown).map((descriptor, index) => {
    if (descriptor.kind === 'added') {
      return Decoration.inline(descriptor.from, descriptor.to, {
        class: 'diff-addition',
      });
    }

    return Decoration.widget(
      descriptor.pos,
      () => createRemovedWidget(descriptor.text),
      {
        side: -1,
        key: `inline-diff-removed:${descriptor.pos}:${descriptor.text}:${index}`,
      }
    );
  });

  return DecorationSet.create(state.doc, decorations);
}

function createRemovedWidget(text: string) {
  const element = document.createElement('span');
  element.className = 'diff-deletion';
  element.textContent = text;
  element.contentEditable = 'false';
  element.ariaHidden = 'true';
  element.style.pointerEvents = 'none';
  return element;
}

function mergeVisibleRanges(chars: VisibleChar[]) {
  if (chars.length === 0) return [];

  const ranges = [{ from: chars[0].from, to: chars[0].to }];

  for (const char of chars.slice(1)) {
    const previous = ranges[ranges.length - 1];
    if (previous.to === char.from) {
      previous.to = char.to;
      continue;
    }
    ranges.push({ from: char.from, to: char.to });
  }

  return ranges;
}

function resolveWidgetPos(chars: VisibleChar[], offset: number, doc: ProseMirrorNode) {
  const nextChar = chars[offset];
  if (nextChar) return nextChar.from;

  const previousChar = chars[offset - 1];
  if (previousChar) return previousChar.to;

  return doc.childCount > 0 ? 1 : 0;
}

function shouldRenderRemovedWidget(text: string) {
  const compact = text.trim();
  if (!compact) return false;
  if (compact.length > 24) return false;
  if (/[<>]/.test(compact)) return false;
  if (!/[\p{L}\p{N}]/u.test(compact)) return false;
  return true;
}
