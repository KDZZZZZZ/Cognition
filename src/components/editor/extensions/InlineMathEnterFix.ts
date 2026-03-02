import { Extension } from '@tiptap/core';

/**
 * Fallback Enter handler:
 * - Runs with low priority, so default StarterKit/list/code handlers execute first.
 * - Only kicks in when those handlers don't handle Enter.
 * - Forces a regular block split at current cursor/selection end.
 *
 * This keeps Enter behavior independent from inline math while still covering
 * atom-node cursor edge cases.
 */
export const InlineMathEnterFix = Extension.create({
  name: 'inlineMathEnterFix',
  priority: 1,

  addKeyboardShortcuts() {
    const fallbackSplit = (withHardBreak: boolean) => {
      const { state } = this.editor;
      const { selection } = state;
      if (!selection.$from.parent.isTextblock) return false;

      const cursorPos = selection.to;
      const chain = this.editor.chain().setTextSelection(cursorPos);
      if (withHardBreak) {
        if (!this.editor.can().chain().setTextSelection(cursorPos).setHardBreak().run()) {
          return false;
        }
        return chain.setHardBreak().run();
      }
      if (!this.editor.can().chain().setTextSelection(cursorPos).splitBlock().run()) {
        return false;
      }
      return chain.splitBlock().run();
    };

    return {
      Enter: () => fallbackSplit(false),
      'Shift-Enter': () => fallbackSplit(true),
    };
  },
});
