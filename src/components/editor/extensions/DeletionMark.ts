import { Mark, mergeAttributes } from '@tiptap/core';

export interface DeletionOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    deletion: {
      setDeletion: () => ReturnType;
      unsetDeletion: () => ReturnType;
      toggleDeletion: () => ReturnType;
    };
  }
}

export const DeletionMark = Mark.create<DeletionOptions>({
  name: 'deletion',

  addOptions() {
    return {
      HTMLAttributes: {
        class: 'diff-deletion',
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span.diff-deletion',
      },
      {
        tag: 'del',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-diff-type': 'deletion',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setDeletion:
        () =>
        ({ commands }) => {
          return commands.setMark(this.name);
        },
      unsetDeletion:
        () =>
        ({ commands }) => {
          return commands.unsetMark(this.name);
        },
      toggleDeletion:
        () =>
        ({ commands }) => {
          return commands.toggleMark(this.name);
        },
    };
  },
});
