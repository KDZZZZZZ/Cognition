import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import katex from 'katex';
import 'katex/dist/katex.min.css';

interface MarkdownContentProps {
  content: string;
  className?: string;
  variant?: 'default' | 'diff';
}

export function MarkdownContent({ content, className, variant = 'default' }: MarkdownContentProps) {
  const isDiffVariant = variant === 'diff';

  return (
    <div
      className={`prose prose-sm max-w-none text-theme-text prose-headings:mb-2 prose-headings:mt-3 prose-headings:text-theme-text prose-p:my-2 prose-p:text-theme-text prose-strong:text-theme-text prose-li:my-1 prose-li:text-theme-text prose-a:text-theme-text prose-blockquote:text-theme-text/72 prose-pre:bg-transparent prose-pre:text-theme-text prose-pre:p-0 prose-code:text-theme-text prose-code:before:content-none prose-code:after:content-none [&_.katex-display]:my-1 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display>.katex]:inline-block [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ${className || ''}`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeKatex]}
        components={{
          pre: ({ node, ...props }) => (
            <pre
              className="overflow-x-auto rounded-md border border-theme-border/20 p-2 paper-divider"
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
                className={`${codeClassName || ''} ${isDiffVariant ? 'rounded-sm border border-emerald-500/24 bg-emerald-500/16 px-1 py-0.5 text-[0.92em] text-theme-text' : 'rounded bg-theme-text/8 px-1 py-0.5 text-xs text-theme-text'}`}
                style={isDiffVariant ? { fontFamily: 'inherit' } : undefined}
                {...props}
              >
                {children}
              </code>
            );
          },
          del: ({ node, className: delClassName, children, ...props }: any) => (
            <del
              className={`${delClassName || ''} ${isDiffVariant ? 'rounded-sm bg-rose-500/14 px-1 py-0.5 text-theme-text/72 decoration-rose-700/80' : ''}`}
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
              try {
                const html = katex.renderToString(String(latex), {
                  throwOnError: false,
                  displayMode: isDisplayMode,
                });
                return <span dangerouslySetInnerHTML={{ __html: html }} />;
              } catch {
                return <span className="text-red-600">{String(latex)}</span>;
              }
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
