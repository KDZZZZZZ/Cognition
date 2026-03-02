import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import type { MarkdownSerializerState } from 'prosemirror-markdown';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

const PATCH_MARK = Symbol('inlineMathMarkdownSerializerPatched');

export const InlineMathMarkdownStorage = Extension.create({
  name: 'inlineMathMarkdownStorage',
  priority: 1300,

  onCreate() {
    queueMicrotask(() => {
      patchMarkdownSerializer(this.editor);
    });
  },

  onTransaction() {
    patchMarkdownSerializer(this.editor);
  },
});

export function patchMarkdownSerializer(editor: Editor) {
  const markdownStorage = (editor.storage as any)?.markdown;
  const serializer = markdownStorage?.serializer;
  if (!serializer || !serializer.nodes) return;
  if ((serializer as any)[PATCH_MARK]) return;

  serializer.nodes.inlineMath = (
    state: MarkdownSerializerState,
    node: ProseMirrorNode
  ) => {
    const latex = String((node.attrs as any)?.latex || '').trim();
    const display = String((node.attrs as any)?.display || '').toLowerCase() === 'yes';
    if (!latex) return;

    if (display) {
      state.write(`$$\n${latex}\n$$`);
    } else {
      state.write(`$${latex}$`);
    }
  };

  (serializer as any)[PATCH_MARK] = true;
}
