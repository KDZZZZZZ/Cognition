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

const MarkdownContent = ({ content, className }: { content: string, className?: string }) => (
  <div className={`prose prose-sm max-w-none dark:prose-invert ${className}`}>
    <ReactMarkdown
      remarkPlugins={[remarkMath, remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeKatex]}
      components={{
        pre: ({node, ...props}) => <pre className="bg-gray-100 p-2 rounded overflow-x-auto" {...props} />,
        code: ({node, className, children, ...props}) => {
          const match = /language-(\w+)/.exec(className || '');
          return (
            <code className={`${className} bg-gray-100 px-1 py-0.5 rounded text-xs`} {...props}>
              {children}
            </code>
          );
        },
        span: ({node, className, children, ...props}) => {
          const latex = props['data-latex' as keyof typeof props];
          if (latex) {
            try {
              const html = katex.renderToString(String(latex), {
                throwOnError: false,
                displayMode: props['data-display'] === 'yes'
              });
              return <span dangerouslySetInnerHTML={{ __html: html }} />;
            } catch (e) {
              return <span className="text-red-500">{String(latex)}</span>;
            }
          }
          return <span className={className} {...props}>{children}</span>;
        }
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

  // Group diffs for split view
  const splitRows = useMemo(() => {
    if (mode !== 'split') return [];

    const rows = [];
    let i = 0;
    while (i < diffs.length) {
      const part = diffs[i];
      if (!part.added && !part.removed) {
        // Unchanged
        rows.push({ left: part.value, right: part.value, type: 'equal' });
        i++;
      } else if (part.removed) {
        // Check if next is added (Modification)
        if (i + 1 < diffs.length && diffs[i + 1].added) {
          rows.push({ left: part.value, right: diffs[i + 1].value, type: 'modify' });
          i += 2;
        } else {
          // Deletion
          rows.push({ left: part.value, right: [], type: 'delete' });
          i++;
        }
      } else if (part.added) {
        // Addition
        rows.push({ left: [], right: part.value, type: 'add' });
        i++;
      }
    }
    return rows;
  }, [diffs, mode]);

  if (mode === 'split') {
    return (
      <div className="w-full h-full overflow-y-auto bg-white text-sm">
        <div className="grid grid-cols-2 divide-x divide-gray-200 min-h-full">
          {/* Header */}
          <div className="sticky top-0 bg-gray-50 border-b border-gray-200 p-2 text-center text-xs font-semibold text-gray-500 uppercase z-10">Original</div>
          <div className="sticky top-0 bg-gray-50 border-b border-gray-200 p-2 text-center text-xs font-semibold text-gray-500 uppercase z-10">Modified</div>

          {splitRows.map((row, rowIndex) => (
            <React.Fragment key={rowIndex}>
              {/* Left Column */}
              <div className={`p-4 ${
                row.type === 'delete' ? 'bg-red-50' :
                row.type === 'modify' ? 'bg-yellow-50/50' : ''
              } ${row.type === 'delete' ? 'diff-deletion' : ''}`}>
                {row.left.map((block, i) => (
                  <div key={i} className="mb-4 last:mb-0">
                    <MarkdownContent content={block} className={row.type === 'delete' ? 'opacity-70' : ''} />
                  </div>
                ))}
              </div>

              {/* Right Column */}
              <div className={`p-4 ${
                row.type === 'add' ? 'bg-green-50' :
                row.type === 'modify' ? 'bg-yellow-50/50' : ''
              } ${row.type === 'add' ? 'diff-addition' : ''}`}>
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

  // Inline Mode (Existing behavior)
  return (
    <div className="w-full h-full overflow-y-auto p-4 bg-white text-sm">
      <div className="max-w-4xl mx-auto space-y-4">
        {diffs.map((part, index) => {
          if (part.value.length === 0) return null;

          let bgClass = '';
          let borderClass = 'border-transparent';
          let label = null;

          if (part.added) {
            bgClass = 'bg-green-50/50';
            borderClass = 'border-green-200';
            label = <div className="text-[10px] font-bold text-green-600 uppercase tracking-wider mb-1">Added</div>;
          } else if (part.removed) {
            bgClass = 'bg-red-50/50';
            borderClass = 'border-red-200';
            label = <div className="text-[10px] font-bold text-red-600 uppercase tracking-wider mb-1">Removed</div>;
          }

          return (
            <div key={index} className="flex flex-col gap-2">
              {part.value.map((blockContent, i) => (
                <div key={i} className={`relative p-4 rounded-lg border-2 ${bgClass} ${borderClass} transition-colors ${part.added ? 'diff-addition' : ''} ${part.removed ? 'diff-deletion' : ''}`}>
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
