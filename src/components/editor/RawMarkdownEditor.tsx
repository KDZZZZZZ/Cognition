import { useEffect, useMemo, useRef } from 'react';

interface RawMarkdownEditorProps {
  content?: string;
  onChange?: (markdown: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  editable?: boolean;
  className?: string;
  notice?: string | null;
  onViewportChange?: (payload: {
    scrollTop: number;
    scrollHeight: number;
    visibleUnit: 'line';
    visibleStart: number;
    visibleEnd: number;
  }) => void;
}

export function RawMarkdownEditor({
  content = '',
  onChange,
  onBlur,
  placeholder = 'Write Markdown…',
  editable = true,
  className = '',
  notice = null,
  onViewportChange,
}: RawMarkdownEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lineHeightRef = useRef(24);
  const lineCount = useMemo(() => Math.max(1, content.split('\n').length), [content]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !onViewportChange) return;

    const computed = window.getComputedStyle(textarea);
    const parsedLineHeight = Number.parseFloat(computed.lineHeight || '');
    if (Number.isFinite(parsedLineHeight) && parsedLineHeight > 0) {
      lineHeightRef.current = parsedLineHeight;
    }

    const emitViewport = () => {
      const scrollTop = textarea.scrollTop || 0;
      const scrollHeight = Math.max(textarea.scrollHeight, textarea.clientHeight, 1);
      const lineHeight = Math.max(1, lineHeightRef.current);
      const visibleStart = Math.max(1, Math.floor(scrollTop / lineHeight) + 1);
      const visibleSpan = Math.max(1, Math.ceil(textarea.clientHeight / lineHeight));
      const visibleEnd = Math.min(lineCount, visibleStart + visibleSpan - 1);
      onViewportChange({
        scrollTop,
        scrollHeight,
        visibleUnit: 'line',
        visibleStart,
        visibleEnd,
      });
    };

    emitViewport();
    textarea.addEventListener('scroll', emitViewport, { passive: true });
    window.addEventListener('resize', emitViewport);
    return () => {
      textarea.removeEventListener('scroll', emitViewport);
      window.removeEventListener('resize', emitViewport);
    };
  }, [content, lineCount, onViewportChange]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-theme-bg">
      {notice ? (
        <div className="border-b border-theme-border/18 bg-theme-surface/20 px-4 py-2 text-[11px] text-theme-text/62">
          {notice}
        </div>
      ) : null}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(event) => onChange?.(event.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        readOnly={!editable}
        spellCheck={false}
        data-testid="raw-markdown-editor"
        className={[
          'h-full min-h-0 w-full flex-1 resize-none overflow-auto bg-theme-bg px-6 py-5 font-mono text-[14px] leading-7 text-theme-text outline-none',
          'selection:bg-theme-accent/18',
          className,
        ].join(' ')}
      />
    </div>
  );
}
