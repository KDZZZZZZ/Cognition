import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import 'katex/dist/katex.min.css';
import { markdownCodeBlockClassName, markdownProseClassName, renderKatexToHtml, diffInlineDeleteClassName, diffInlineInsertClassName } from './markdownShared';

interface MarkdownContentProps {
  content: string;
  className?: string;
  variant?: 'default' | 'diff';
}

export function MarkdownContent({ content, className, variant = 'default' }: MarkdownContentProps) {
  const isDiffVariant = variant === 'diff';

  return (
    <div
      className={`${markdownProseClassName} ${className || ''}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeKatex]}
        components={{
          pre: ({ node, ...props }) => (
            <pre
              className={markdownCodeBlockClassName}
              style={{
                backgroundColor: 'color-mix(in srgb, var(--theme-surface-muted) 88%, transparent)',
                color: 'var(--theme-text)',
              }}
              {...props}
            />
          ),
          code: ({ node, inline, className: codeClassName, children, ...props }: any) => {
            const rawText = String(children);
            const isInlineCode = inline ?? (!codeClassName && !rawText.includes('\n'));

            if (!isInlineCode) {
              return (
                <code className={`${codeClassName || ''} bg-transparent text-theme-text text-xs`} {...props}>
                  {children}
                </code>
              );
            }
            return (
              <code
                className={`${codeClassName || ''} ${isDiffVariant ? `${diffInlineInsertClassName} border border-emerald-500/24 text-[0.92em]` : 'rounded bg-theme-text/8 px-1 py-0.5 text-xs text-theme-text'}`}
                style={isDiffVariant ? { fontFamily: 'inherit' } : undefined}
                {...props}
              >
                {children}
              </code>
            );
          },
          del: ({ node, className: delClassName, children, ...props }: any) => (
            <del
              className={`${delClassName || ''} ${isDiffVariant ? diffInlineDeleteClassName : ''}`}
              {...props}
            >
              {children}
            </del>
          ),
          span: ({ node, className: spanClassName, children, ...props }) => {
            const dataAttrs = props as Record<string, unknown>;
            const latex = dataAttrs['data-latex'];
            const isDisplayMode = dataAttrs['data-display'] === 'yes';
            if (latex) {
              const html = renderKatexToHtml(String(latex), isDisplayMode);
              if (html) {
                return <span dangerouslySetInnerHTML={{ __html: html }} />;
              }
              return <span className="text-red-600">{String(latex)}</span>;
            }
            return (
              <span className={spanClassName} {...props}>
                {children}
              </span>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
