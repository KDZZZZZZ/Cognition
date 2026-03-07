import CodeMirror from '@uiw/react-codemirror';
import { indentWithTab } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';
import { useMemo } from 'react';

interface CodeMirrorBlockEditorProps {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}

const codeMirrorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    color: 'var(--theme-text)',
    fontSize: '13px',
  },
  '.cm-content': {
    minHeight: '220px',
    fontFamily: 'ui-monospace, SFMono-Regular, SFMono, Menlo, Monaco, Consolas, Liberation Mono, monospace',
    lineHeight: '1.6',
    padding: '12px',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, SFMono, Menlo, Monaco, Consolas, Liberation Mono, monospace',
  },
  '.cm-lineNumbers': {
    color: 'color-mix(in srgb, var(--theme-text) 40%, transparent)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'color-mix(in srgb, var(--theme-text) 40%, transparent)',
    border: 'none',
  },
  '.cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--theme-text) 4%, transparent)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '.cm-focused': {
    outline: 'none',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--theme-primary, #2563eb) 22%, transparent)',
  },
});

export function CodeMirrorBlockEditor({ value, onChange, autoFocus = false }: CodeMirrorBlockEditorProps) {
  const extensions = useMemo(() => [EditorView.lineWrapping, codeMirrorTheme, keymap.of([indentWithTab])], []);

  return (
    <div className="overflow-hidden rounded-xl border border-theme-border/16 bg-theme-surface/10">
      <CodeMirror
        value={value}
        height="auto"
        minHeight="220px"
        basicSetup={{
          foldGutter: false,
          dropCursor: false,
          allowMultipleSelections: false,
        }}
        editable
        autoFocus={autoFocus}
        extensions={extensions}
        onChange={onChange}
      />
    </div>
  );
}
