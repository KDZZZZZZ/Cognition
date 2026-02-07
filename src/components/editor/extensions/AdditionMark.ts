import { Mark, mergeAttributes } from '@tiptap/core';

export interface AdditionOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    addition: {
      setAddition: () => ReturnType;
      unsetAddition: () => ReturnType;
      toggleAddition: () => ReturnType;
    };
  }
}

export const AdditionMark = Mark.create<AdditionOptions>({
  name: 'addition',

  addOptions() {
    return {
      HTMLAttributes: {
        class: 'diff-addition',
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span.diff-addition',
      },
      {
        tag: 'ins',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-diff-type': 'addition',
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setAddition:
        () =>
        ({ commands }) => {
          return commands.setMark(this.name);
        },
      unsetAddition:
        () =>
        ({ commands }) => {
          return commands.unsetMark(this.name);
        },
      toggleAddition:
        () =>
        ({ commands }) => {
          return commands.toggleMark(this.name);
        },
    };
  },
});
