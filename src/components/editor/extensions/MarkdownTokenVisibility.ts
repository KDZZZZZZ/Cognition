import { Extension } from '@tiptap/core';
import type { Mark } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

type MarkdownTokenKind = 'bold' | 'italic' | 'strike' | 'code' | 'link' | 'inlineMath';

interface MarkdownTokenDescriptor {
  kind: MarkdownTokenKind;
  from: number;
  to: number;
  open: string;
  close: string;
}

interface MarkSegment {
  from: number;
  to: number;
  mark: Mark;
}

const markdownTokenVisibilityKey = new PluginKey<DecorationSet>('markdownTokenVisibility');

const MARKDOWN_MARKS: Array<{
  kind: Exclude<MarkdownTokenKind, 'inlineMath'>;
  markName: string;
  marker: (mark: Mark) => { open: string; close: string };
}> = [
  {
    kind: 'link',
    markName: 'link',
    marker: (mark) => {
      const href = String(mark.attrs?.href || '').trim();
      const title = String(mark.attrs?.title || '').trim();
      const suffix = title ? ` "${title}"` : '';
      return {
        open: '[',
        close: `](${href}${suffix})`,
      };
    },
  },
  {
    kind: 'bold',
    markName: 'bold',
    marker: () => ({ open: '**', close: '**' }),
  },
  {
    kind: 'italic',
    markName: 'italic',
    marker: () => ({ open: '*', close: '*' }),
  },
  {
    kind: 'strike',
    markName: 'strike',
    marker: () => ({ open: '~~', close: '~~' }),
  },
  {
    kind: 'code',
    markName: 'code',
    marker: () => ({ open: '`', close: '`' }),
  },
];

export const MarkdownTokenVisibility = Extension.create({
  name: 'markdownTokenVisibility',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: markdownTokenVisibilityKey,
        state: {
          init: (_config, state) => buildActiveMarkdownDecorations(state),
          apply: (tr, value, _oldState, newState) => {
            if (!tr.docChanged && !tr.selectionSet) {
              return value;
            }
            return buildActiveMarkdownDecorations(newState);
          },
        },
        props: {
          decorations(state) {
            return markdownTokenVisibilityKey.getState(state) || null;
          },
        },
      }),
    ];
  },
});

export function collectActiveMarkdownTokens(state: EditorState): MarkdownTokenDescriptor[] {
  const tokens: MarkdownTokenDescriptor[] = [];

  for (const spec of MARKDOWN_MARKS) {
    const markType = state.schema.marks[spec.markName];
    if (!markType) continue;

    const mergedSegments = mergeMarkSegments(
      collectRelevantMarkSegments(state, (mark) => mark.type === markType)
    );

    for (const segment of mergedSegments) {
      const marker = spec.marker(segment.mark);
      tokens.push({
        kind: spec.kind,
        from: segment.from,
        to: segment.to,
        open: marker.open,
        close: marker.close,
      });
    }
  }

  const inlineMathType = state.schema.nodes.inlineMath;
  if (inlineMathType) {
    const selection = state.selection;
    const scan = resolveSelectionScanWindow(state);
    state.doc.nodesBetween(scan.from, scan.to, (node, pos) => {
      if (node.type !== inlineMathType) return;

      const from = pos;
      const to = pos + node.nodeSize;
      if (!selectionTouchesRange(selection.from, selection.to, from, to)) return;

      tokens.push({
        kind: 'inlineMath',
        from,
        to,
        open: '$',
        close: '$',
      });
    });
  }

  return tokens.sort((left, right) => left.from - right.from || right.to - left.to);
}

export function buildActiveMarkdownDecorations(state: EditorState) {
  const decorations = collectActiveMarkdownTokens(state).flatMap((token) => [
    Decoration.inline(token.from, token.to, {
      class: `markdown-token-active markdown-token-active-${token.kind}`,
    }),
    Decoration.widget(token.from, () => createMarkerElement(token.kind, 'open', token.open), {
      side: -1,
      key: `${token.kind}:${token.from}:open:${token.open}`,
    }),
    Decoration.widget(token.to, () => createMarkerElement(token.kind, 'close', token.close), {
      side: 1,
      key: `${token.kind}:${token.to}:close:${token.close}`,
    }),
  ]);

  return DecorationSet.create(state.doc, decorations);
}

function createMarkerElement(kind: MarkdownTokenKind, side: 'open' | 'close', text: string) {
  const element = document.createElement('span');
  element.className = 'markdown-marker-widget';
  element.dataset.kind = kind;
  element.dataset.side = side;
  element.textContent = text;
  element.contentEditable = 'false';
  element.ariaHidden = 'true';
  return element;
}

function resolveSelectionScanWindow(state: EditorState) {
  const { from, to, empty } = state.selection;
  const max = state.doc.content.size;
  return {
    from: Math.max(0, empty ? from - 1 : from),
    to: Math.min(max, empty ? to + 1 : to),
  };
}

function collectRelevantMarkSegments(state: EditorState, matcher: (mark: Mark) => boolean) {
  const selection = state.selection;
  const scan = resolveSelectionScanWindow(state);
  const segments: MarkSegment[] = [];

  state.doc.nodesBetween(scan.from, scan.to, (node, pos) => {
    if (!node.isText || !node.text) return;

    const mark = node.marks.find(matcher);
    if (!mark) return;

    const from = pos;
    const to = pos + node.text.length;
    if (!selectionTouchesRange(selection.from, selection.to, from, to)) return;

    segments.push({ from, to, mark });
  });

  return segments;
}

function mergeMarkSegments(segments: MarkSegment[]) {
  const merged: MarkSegment[] = [];

  for (const segment of segments.sort((left, right) => left.from - right.from || left.to - right.to)) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push(segment);
      continue;
    }

    if (previous.to === segment.from && previous.mark.eq(segment.mark)) {
      previous.to = segment.to;
      continue;
    }

    merged.push(segment);
  }

  return merged;
}

function selectionTouchesRange(selectionFrom: number, selectionTo: number, rangeFrom: number, rangeTo: number) {
  if (selectionFrom === selectionTo) {
    return selectionFrom >= rangeFrom && selectionFrom <= rangeTo;
  }
  return selectionTo > rangeFrom && selectionFrom < rangeTo;
}
