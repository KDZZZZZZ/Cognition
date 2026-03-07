import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { Fragment } from 'react';
import 'katex/dist/katex.min.css';
import { markdownCodeBlockClassName, markdownProseClassName, renderKatexToHtml, diffInlineDeleteClassName, diffInlineInsertClassName } from './markdownShared';

interface MarkdownContentProps {
  content: string;
  className?: string;
  variant?: 'default' | 'diff';
  hideFootnotesSection?: boolean;
}

interface MarkdownSegment {
  kind: 'markdown' | 'callout';
  content: string;
  calloutKind?: string;
  calloutTitle?: string;
}

function extractFrontmatter(content: string) {
  const match = content.match(/^(---|\+\+\+)\s*\n([\s\S]*?)\n\1(?:\n+|$)/);

  if (!match) {
    return {
      entries: [] as Array<[string, string]>,
      body: content,
    };
  }

  const entries = match[2]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf(':');
      if (separator === -1) return [line, ''] as [string, string];
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as [string, string];
    });

  return {
    entries,
    body: content.slice(match[0].length).replace(/^\n+/, ''),
  };
}

function calloutTone(kind: string) {
  if (kind === 'warning' || kind === 'caution') return 'border-amber-500/30 bg-amber-500/10 text-amber-900';
  if (kind === 'danger' || kind === 'error') return 'border-rose-500/30 bg-rose-500/10 text-rose-900';
  if (kind === 'tip' || kind === 'success') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900';
  return 'border-sky-500/30 bg-sky-500/8 text-theme-text';
}

function formatCalloutTitle(kind: string) {
  const normalized = kind.trim().toLowerCase();
  if (!normalized) return 'Callout';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function splitMarkdownSegments(content: string): MarkdownSegment[] {
  const lines = content.split('\n');
  const segments: MarkdownSegment[] = [];
  let markdownBuffer: string[] = [];

  const flushMarkdown = () => {
    if (markdownBuffer.length === 0) return;
    const markdownContent = markdownBuffer.join('\n');
    if (markdownContent.trim().length > 0) {
      segments.push({ kind: 'markdown', content: markdownContent });
    }
    markdownBuffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const calloutMatch = line.match(/^\s*>\s*\[!([A-Za-z]+)\](?:\s+(.*))?\s*$/);

    if (!calloutMatch) {
      markdownBuffer.push(line);
      continue;
    }

    flushMarkdown();

    const calloutKind = calloutMatch[1].toLowerCase();
    const calloutTitle = formatCalloutTitle(calloutKind);
    const calloutLines: string[] = [];
    if (calloutMatch[2]?.trim()) {
      calloutLines.push(calloutMatch[2].trim());
    }

    let cursor = index + 1;
    while (cursor < lines.length) {
      const quotedLineMatch = lines[cursor].match(/^\s*>\s?(.*)$/);
      if (!quotedLineMatch) break;
      calloutLines.push(quotedLineMatch[1]);
      cursor += 1;
    }

    segments.push({
      kind: 'callout',
      content: calloutLines.join('\n').trim(),
      calloutKind,
      calloutTitle,
    });

    index = cursor - 1;
  }

  flushMarkdown();
  return segments;
}

export function MarkdownContent({ content, className, variant = 'default', hideFootnotesSection = false }: MarkdownContentProps) {
  const isDiffVariant = variant === 'diff';
  const { entries, body } = extractFrontmatter(content);
  const segments = splitMarkdownSegments(body);

  const renderMarkdownBody = (markdown: string) => (
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
      {markdown}
    </ReactMarkdown>
  );

  return (
    <div
      className={`${markdownProseClassName} ${hideFootnotesSection ? '[&_section[data-footnotes]]:hidden [&_.footnotes]:hidden' : ''} ${className || ''}`}
    >
      {entries.length > 0 ? (
        <div className="mb-4 overflow-x-auto rounded-md border border-theme-border/20">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="border border-theme-border/20 px-2 py-1 text-left font-semibold">Key</th>
                <th className="border border-theme-border/20 px-2 py-1 text-left font-semibold">Value</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([entryKey, entryValue]) => (
                <tr key={entryKey}>
                  <td className="border border-theme-border/20 px-2 py-1 font-mono text-xs">{entryKey}</td>
                  <td className="border border-theme-border/20 px-2 py-1">{entryValue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {body.trim().length > 0 ? (
        segments.map((segment, index) => (
          <Fragment key={`${segment.kind}-${index}`}>
            {segment.kind === 'callout' ? (
              <aside className={`my-4 rounded-lg border px-3 py-2 ${calloutTone(segment.calloutKind || 'note')}`}>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em]">
                  {segment.calloutTitle}
                </div>
                <div className="flex flex-col gap-1">
                  {segment.content.trim().length > 0 ? renderMarkdownBody(segment.content) : null}
                </div>
              </aside>
            ) : (
              renderMarkdownBody(segment.content)
            )}
          </Fragment>
        ))
      ) : null}
    </div>
  );
}
