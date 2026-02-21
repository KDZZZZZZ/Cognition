import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { diffArrays } from 'diff';
import 'katex/dist/katex.min.css';
import katex from 'katex';

interface RenderedDiffViewerProps {
  oldContent: string;
  newContent: string;
  mode?: 'split' | 'inline';
}

const MarkdownContent = ({ content, className }: { content: string; className?: string }) => (
  <div className={`prose prose-sm max-w-none text-theme-text ${className || ''}`}>
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeKatex]}
      components={{
        pre: ({ node, ...props }) => (
          <pre className="bg-theme-text/8 border border-theme-border/20 paper-divider p-2 rounded overflow-x-auto" {...props} />
        ),
        code: ({ node, className, children, ...props }) => (
          <code className={`${className || ''} bg-theme-text/8 px-1 py-0.5 rounded text-xs`} {...props}>
            {children}
          </code>
        ),
        span: ({ node, className, children, ...props }) => {
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
            <span className={className} {...props}>
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

export function RenderedDiffViewer({ oldContent, newContent, mode = 'inline' }: RenderedDiffViewerProps) {
  const diffs = useMemo(() => {
    const splitter = /\n{2,}/;
    const oldBlocks = oldContent.split(splitter);
    const newBlocks = newContent.split(splitter);
    return diffArrays(oldBlocks, newBlocks);
  }, [oldContent, newContent]);

  const splitRows = useMemo(() => {
    if (mode !== 'split') return [];

    const rows = [];
    let i = 0;
    while (i < diffs.length) {
      const part = diffs[i];
      if (!part.added && !part.removed) {
        rows.push({ left: part.value, right: part.value, type: 'equal' as const });
        i += 1;
      } else if (part.removed) {
        if (i + 1 < diffs.length && diffs[i + 1].added) {
          rows.push({ left: part.value, right: diffs[i + 1].value, type: 'modify' as const });
          i += 2;
        } else {
          rows.push({ left: part.value, right: [], type: 'delete' as const });
          i += 1;
        }
      } else if (part.added) {
        rows.push({ left: [], right: part.value, type: 'add' as const });
        i += 1;
      }
    }
    return rows;
  }, [diffs, mode]);

  if (mode === 'split') {
    return (
      <div className="w-full h-full overflow-y-auto bg-theme-bg text-sm">
        <div className="grid grid-cols-2 divide-x divide-theme-border/20 min-h-full">
          <div
            className="sticky top-0 border-b border-theme-border/30 paper-divider-dashed p-2 text-center text-xs font-semibold tracking-[0.06em] text-theme-text/55 uppercase z-10"
            style={{ backgroundColor: 'var(--theme-surface)' }}
          >
            Original
          </div>
          <div
            className="sticky top-0 border-b border-theme-border/30 paper-divider-dashed p-2 text-center text-xs font-semibold tracking-[0.06em] text-theme-text/55 uppercase z-10"
            style={{ backgroundColor: 'var(--theme-surface)' }}
          >
            Modified
          </div>

          {splitRows.map((row, rowIndex) => (
            <React.Fragment key={rowIndex}>
              <div
                className={`p-4 ${
                  row.type === 'delete'
                    ? 'bg-red-50'
                    : row.type === 'modify'
                      ? 'bg-theme-text/5'
                      : ''
                } ${row.type === 'delete' ? 'diff-deletion' : ''}`}
              >
                {row.left.map((block, i) => (
                  <div key={i} className="mb-4 last:mb-0">
                    <MarkdownContent content={block} className={row.type === 'delete' ? 'opacity-70' : ''} />
                  </div>
                ))}
              </div>

              <div
                className={`p-4 ${
                  row.type === 'add'
                    ? 'bg-green-50'
                    : row.type === 'modify'
                      ? 'bg-theme-text/5'
                      : ''
                } ${row.type === 'add' ? 'diff-addition' : ''}`}
              >
                {row.right.map((block, i) => (
                  <div key={i} className="mb-4 last:mb-0">
                    <MarkdownContent content={block} />
                  </div>
                ))}
              </div>
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-y-auto p-4 bg-theme-bg text-sm">
      <div className="max-w-4xl mx-auto space-y-4">
        {diffs.map((part, index) => {
          if (part.value.length === 0) return null;

          let bgClass = '';
          let borderClass = 'border-theme-border/20';
          let label: React.ReactNode = null;

          if (part.added) {
            bgClass = 'bg-green-50/70';
            borderClass = 'border-green-300/80';
            label = <div className="text-[10px] font-bold text-green-700 uppercase tracking-wider mb-1">Added</div>;
          } else if (part.removed) {
            bgClass = 'bg-red-50/70';
            borderClass = 'border-red-300/80';
            label = <div className="text-[10px] font-bold text-red-700 uppercase tracking-wider mb-1">Removed</div>;
          }

          return (
            <div key={index} className="flex flex-col gap-2">
              {part.value.map((blockContent, i) => (
                <div
                  key={i}
                  className={`relative p-4 rounded-lg border ${bgClass} ${borderClass} transition-colors ${
                    part.added ? 'diff-addition' : ''
                  } ${part.removed ? 'diff-deletion' : ''}`}
                >
                  {label}
                  <MarkdownContent
                    content={blockContent}
                    className={part.removed ? 'opacity-70 grayscale-[30%]' : ''}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
