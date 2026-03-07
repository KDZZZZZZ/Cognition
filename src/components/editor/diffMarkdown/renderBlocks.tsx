import { Fragment, type ReactNode } from 'react';
import { diffArrays, diffChars, diffWordsWithSpace } from 'diff';
import { Check, Image as ImageIcon, X } from 'lucide-react';
import { toString } from 'mdast-util-to-string';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type {
  List,
  Root,
  Content,
  Parent,
  PhrasingContent,
  ListItem,
  Table,
  TableCell,
  TableRow,
} from 'mdast';
import {
  renderKatexToHtml,
  markdownCodeBlockClassName,
  diffInlineDeleteClassName,
  diffInlineInsertClassName,
  diffStructuralClassName,
  diffBlockDeleteClassName,
  diffBlockInsertClassName,
} from '../../ui/markdownShared';
import { MarkdownContent } from '../../ui/MarkdownContent';
import type { DiffRenderRow } from '../diffRows';
import type { DiffBlock, DiffCalloutMeta, ReviewUnit } from './types';
import { buildMergedLineMarkdown } from './lineMarkdown';

type ReviewDecision = 'accepted' | 'rejected';
const processor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ['yaml', 'toml'])
  .use(remarkGfm)
  .use(remarkMath);

type InlineTokenKind =
  | 'text'
  | 'strong'
  | 'emphasis'
  | 'delete'
  | 'link'
  | 'inlineCode'
  | 'inlineMath'
  | 'image'
  | 'footnoteReference'
  | 'html'
  | 'break';

interface InlineToken {
  kind: InlineTokenKind;
  value?: string;
  url?: string;
  title?: string | null;
  identifier?: string;
  alt?: string;
  children?: InlineToken[];
}

function primaryNode(root: Root | null): Content | null {
  if (!root?.children?.length) return null;
  return (root.children[0] as Content) || null;
}

function parseMarkdownRoot(content: string): Root | null {
  if (!content.trim()) return null;
  return processor.parse(content) as Root;
}

function contentFromRows(rows: DiffRenderRow[], side: 'old' | 'new') {
  return rows
    .map((row) => (side === 'old' ? row.oldText : row.newText))
    .filter((line): line is string => line !== null)
    .join('\n');
}

function sliceRowsByPosition(rows: DiffRenderRow[], node: Content | ListItem | TableRow) {
  const startLine = node.position?.start.line;
  const endLine = node.position?.end.line;
  if (!startLine || !endLine) return [];
  return rows.slice(startLine - 1, endLine);
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value: string) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function stripHtmlTags(value: string) {
  return value.replace(/<[^>]+>/g, '');
}

function isPreviewableImageUrl(url: string | undefined) {
  if (!url) return false;
  return /^(https?:\/\/|data:|blob:|\/)/i.test(url);
}

function compactResourceLabel(url: string | undefined) {
  if (!url) return 'image';
  const cleaned = url.split('?')[0]?.split('#')[0] || url;
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || cleaned;
}

function htmlOpeningTagName(value: string) {
  const match = value.match(/^<([A-Za-z][\w:-]*)(?:\s[^>]*)?>$/);
  return match ? match[1].toLowerCase() : null;
}

function htmlClosingTagName(value: string) {
  const match = value.match(/^<\/([A-Za-z][\w:-]*)\s*>$/);
  return match ? match[1].toLowerCase() : null;
}

function isSelfClosingHtml(value: string) {
  if (/\/\s*>$/.test(value)) return true;
  const tagName = htmlOpeningTagName(value);
  return Boolean(tagName && ['br', 'hr', 'img', 'input', 'meta', 'link'].includes(tagName));
}

function renderMath(value: string, displayMode: boolean, key: string, className = '') {
  const html = renderKatexToHtml(value, displayMode);
  if (!html) {
    return <span key={key} className="text-red-600">{value}</span>;
  }
  const Tag = displayMode ? 'div' : 'span';
  return <Tag key={key} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

function atomicInlineClass(op: 'equal' | 'insert' | 'delete' | 'structural', extra = '') {
  if (op === 'equal') return extra;
  return classNames(
    'mx-0.5 inline-flex items-center rounded-sm px-1.5 py-0.5 align-baseline',
    op === 'insert'
      ? 'bg-emerald-500/25 text-theme-text'
      : op === 'delete'
        ? 'bg-rose-500/20 text-theme-text/70'
        : 'bg-amber-500/10 text-theme-text',
    extra
  );
}

function renderInlineAtom(token: InlineToken, key: string, op: 'equal' | 'insert' | 'delete' | 'structural' = 'equal') {
  const stateClass =
    op === 'insert'
      ? diffInlineInsertClassName
      : op === 'delete'
        ? diffInlineDeleteClassName
        : op === 'structural'
          ? diffStructuralClassName
          : '';

  if (token.kind === 'inlineCode') {
    return (
      <code key={key} data-diff-op={op === 'equal' ? undefined : op} className={`rounded-sm px-1 py-0.5 text-[0.92em] ${stateClass || 'bg-theme-text/8 text-theme-text'}`}>
        {token.value}
      </code>
    );
  }

  if (token.kind === 'inlineMath') {
    const mathClass =
      op === 'insert'
        ? `mx-0.5 inline-flex items-center rounded-sm bg-emerald-500/20 px-1.5 py-0.5 text-theme-text`
      : op === 'delete'
          ? `mx-0.5 inline-flex items-center rounded-sm bg-rose-500/20 px-1.5 py-0.5 text-theme-text/70`
          : op === 'structural'
            ? `mx-0.5 inline-flex items-center rounded-sm border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5`
            : 'inline-flex items-center';
    return (
      <span key={key} data-diff-op={op === 'equal' ? undefined : op} className={mathClass}>
        {renderMath(token.value || '', false, `${key}-math`)}
      </span>
    );
  }

  if (token.kind === 'footnoteReference') {
    return (
      <sup key={key} data-diff-op={op === 'equal' ? undefined : op} className={`text-[0.75em] ${stateClass}`}>
        [{token.identifier}]
      </sup>
    );
  }

  if (token.kind === 'image') {
    const previewable = isPreviewableImageUrl(token.url);
    return (
      <span
        key={key}
        data-diff-op={op === 'equal' ? undefined : op}
        className={classNames(
          previewable
            ? (op === 'equal'
                ? 'my-1 inline-flex max-w-full items-center gap-2 align-middle'
                : atomicInlineClass(op, 'my-1 max-w-full gap-2 align-middle'))
            : atomicInlineClass(op, 'max-w-full gap-1.5 align-middle'),
          !previewable && op === 'equal' && 'mx-0.5 inline-flex items-center gap-1.5 align-middle text-theme-text/68'
        )}
      >
        {previewable ? (
          <img src={token.url} alt={token.alt || ''} className="max-h-40 max-w-full rounded object-contain" />
        ) : (
          <ImageIcon className="h-3.5 w-3.5 shrink-0 text-theme-text/40" />
        )}
        <span className={classNames('text-[11px]', previewable ? 'text-theme-text/60' : 'text-theme-text/70')}>
          {token.alt || compactResourceLabel(token.url)}
        </span>
      </span>
    );
  }

  if (token.kind === 'html') {
    return (
      <span
        key={key}
        data-diff-op={op === 'equal' ? undefined : op}
        className={op === 'equal' ? 'inline align-baseline' : atomicInlineClass(op)}
        dangerouslySetInnerHTML={{ __html: token.value || '' }}
      />
    );
  }

  if (token.kind === 'break') {
    return <br key={key} />;
  }

  return null;
}

function tokenizeInline(nodes: PhrasingContent[] = []): InlineToken[] {
  const splitText = (value: string): InlineToken[] => {
    if (!value) return [];
    const tokens: InlineToken[] = [];
    const pattern = /\[\^([^[\]]+)\]/g;
    let cursor = 0;
    let match = pattern.exec(value);
    while (match) {
      if (match.index > cursor) {
        tokens.push({ kind: 'text', value: value.slice(cursor, match.index) });
      }
      tokens.push({ kind: 'footnoteReference', identifier: match[1] });
      cursor = match.index + match[0].length;
      match = pattern.exec(value);
    }
    if (cursor < value.length) {
      tokens.push({ kind: 'text', value: value.slice(cursor) });
    }
    return tokens;
  };

  const serializeInlineNode = (node: PhrasingContent): string => {
    switch (node.type) {
      case 'text':
        return escapeHtml(node.value);
      case 'strong':
        return `<strong>${(node.children as PhrasingContent[]).map(serializeInlineNode).join('')}</strong>`;
      case 'emphasis':
        return `<em>${(node.children as PhrasingContent[]).map(serializeInlineNode).join('')}</em>`;
      case 'delete':
        return `<del>${(node.children as PhrasingContent[]).map(serializeInlineNode).join('')}</del>`;
      case 'link': {
        const title = node.title ? ` title="${escapeHtmlAttribute(node.title)}"` : '';
        return `<a href="${escapeHtmlAttribute(node.url)}"${title}>${(node.children as PhrasingContent[]).map(serializeInlineNode).join('')}</a>`;
      }
      case 'image': {
        const title = node.title ? ` title="${escapeHtmlAttribute(node.title)}"` : '';
        return `<img src="${escapeHtmlAttribute(node.url)}" alt="${escapeHtmlAttribute(node.alt || '')}"${title} />`;
      }
      case 'inlineCode':
        return `<code>${escapeHtml(node.value)}</code>`;
      case 'inlineMath':
        return renderKatexToHtml(node.value, false) || escapeHtml(node.value);
      case 'html':
        return node.value;
      case 'break':
        return '<br />';
      default:
        return escapeHtml(toString(node as any));
    }
  };

  const tokens: InlineToken[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    switch (node.type) {
      case 'text':
        tokens.push(...splitText(node.value));
        break;
      case 'html': {
        const openTag = htmlOpeningTagName(node.value);
        const closeTag = htmlClosingTagName(node.value);
        if (openTag && !isSelfClosingHtml(node.value)) {
          let depth = 1;
          let cursor = index + 1;
          while (cursor < nodes.length) {
            const candidate = nodes[cursor];
            if (candidate.type === 'html') {
              if (htmlOpeningTagName(candidate.value) === openTag && !isSelfClosingHtml(candidate.value)) {
                depth += 1;
              } else if (htmlClosingTagName(candidate.value) === openTag) {
                depth -= 1;
                if (depth === 0) break;
              }
            }
            cursor += 1;
          }
          const closingNode = cursor < nodes.length && nodes[cursor].type === 'html'
            ? (nodes[cursor] as Extract<PhrasingContent, { type: 'html' }>)
            : null;
          if (closingNode && htmlClosingTagName(closingNode.value) === openTag) {
            const innerHtml = nodes.slice(index + 1, cursor).map((child) => serializeInlineNode(child)).join('');
            tokens.push({ kind: 'html', value: `${node.value}${innerHtml}${closingNode.value}` });
            index = cursor;
            break;
          }
        }
        if (!closeTag) {
          tokens.push({ kind: 'html', value: node.value });
        }
        break;
      }
      case 'strong':
        tokens.push({ kind: 'strong', children: tokenizeInline(node.children as PhrasingContent[]) });
        break;
      case 'emphasis':
        tokens.push({ kind: 'emphasis', children: tokenizeInline(node.children as PhrasingContent[]) });
        break;
      case 'delete':
        tokens.push({ kind: 'delete', children: tokenizeInline(node.children as PhrasingContent[]) });
        break;
      case 'link':
        tokens.push({
          kind: 'link',
          url: node.url,
          title: node.title || undefined,
          children: tokenizeInline(node.children as PhrasingContent[]),
        });
        break;
      case 'image':
        tokens.push({ kind: 'image', url: node.url, title: node.title || undefined, alt: node.alt || undefined });
        break;
      case 'inlineCode':
        tokens.push({ kind: 'inlineCode', value: node.value });
        break;
      case 'inlineMath':
        tokens.push({ kind: 'inlineMath', value: node.value });
        break;
      case 'footnoteReference':
        tokens.push({ kind: 'footnoteReference', identifier: node.identifier });
        break;
      case 'break':
        tokens.push({ kind: 'break' });
        break;
      default:
        tokens.push({ kind: 'text', value: toString(node as any) });
        break;
    }
  }

  return tokens;
}

function tokenPlainText(token: InlineToken): string {
  if (token.kind === 'text') return token.value || '';
  if (token.kind === 'image') return token.alt || '';
  if (token.kind === 'inlineCode' || token.kind === 'inlineMath') return token.value || '';
  if (token.kind === 'html') return stripHtmlTags(token.value || '');
  if (token.kind === 'footnoteReference') return token.identifier || '';
  if (token.kind === 'break') return '\n';
  return (token.children || []).map(tokenPlainText).join('');
}

function tokenSignature(token: InlineToken): string {
  if (token.kind === 'link') {
    return `${token.kind}:${token.url || ''}:${token.title || ''}:${(token.children || []).map(tokenSignature).join('|')}`;
  }
  if (token.kind === 'image') {
    return `${token.kind}:${token.url || ''}:${token.alt || ''}`;
  }
  if (token.children) {
    return `${token.kind}:${token.children.map(tokenSignature).join('|')}`;
  }
  return `${token.kind}:${token.value || token.identifier || ''}`;
}

function renderTextDiff(oldValue: string, newValue: string, keyPrefix: string) {
  const useWordDiff = /\s/.test(`${oldValue}${newValue}`);
  const parts = useWordDiff
    ? diffWordsWithSpace(oldValue, newValue)
    : diffChars(oldValue, newValue);
  const hasSharedNonWhitespace = parts.some(
    (part) => !part.added && !part.removed && Boolean(part.value.trim())
  );
  const canRenderWholePhraseReplacement =
    useWordDiff &&
    oldValue.trim() &&
    newValue.trim() &&
    !hasSharedNonWhitespace &&
    parts.some((part) => part.added) &&
    parts.some((part) => part.removed);

  if (canRenderWholePhraseReplacement) {
    return [
      <span key={`${keyPrefix}-whole-pair`} className="mx-[1px] inline-flex items-baseline gap-px">
        <del data-diff-op="delete" className={diffInlineDeleteClassName}>
          {oldValue}
        </del>
        <span data-diff-op="insert" className={diffInlineInsertClassName}>
          {newValue}
        </span>
      </span>,
    ];
  }

  const nodes: ReactNode[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.value) continue;
    const next = parts[index + 1];
    const canPairWithNext =
      useWordDiff &&
      part.removed &&
      next?.added &&
      Boolean(part.value.trim()) &&
      Boolean(next.value.trim());

    if (canPairWithNext) {
      nodes.push(
        <span key={`${keyPrefix}-pair-${index}`} className="mx-[1px] inline-flex items-baseline gap-px">
          <del data-diff-op="delete" className={diffInlineDeleteClassName}>
            {part.value}
          </del>
          <span data-diff-op="insert" className={diffInlineInsertClassName}>
            {next.value}
          </span>
        </span>
      );
      index += 1;
      continue;
    }

    if (part.added) {
      nodes.push(
        <span key={`${keyPrefix}-a-${index}`} data-diff-op="insert" className={diffInlineInsertClassName}>
          {part.value}
        </span>
      );
      continue;
    }
    if (part.removed) {
      nodes.push(
        <del key={`${keyPrefix}-r-${index}`} data-diff-op="delete" className={diffInlineDeleteClassName}>
          {part.value}
        </del>
      );
      continue;
    }

    nodes.push(<Fragment key={`${keyPrefix}-e-${index}`}>{part.value}</Fragment>);
  }

  return nodes;
}

function renderInlineToken(token: InlineToken, key: string, op: 'equal' | 'insert' | 'delete' | 'structural' = 'equal'): ReactNode {
  if (token.kind === 'text') {
    if (op === 'insert') return <span key={key} data-diff-op="insert" className={diffInlineInsertClassName}>{token.value}</span>;
    if (op === 'delete') return <del key={key} data-diff-op="delete" className={diffInlineDeleteClassName}>{token.value}</del>;
    if (op === 'structural') return <span key={key} data-diff-op="structural" className={diffStructuralClassName}>{token.value}</span>;
    return <Fragment key={key}>{token.value}</Fragment>;
  }

  if (token.kind === 'strong' || token.kind === 'emphasis' || token.kind === 'delete') {
    const Tag = token.kind === 'strong' ? 'strong' : token.kind === 'emphasis' ? 'em' : 'del';
    return (
      <Tag key={key} className={op === 'insert' ? diffInlineInsertClassName : op === 'delete' ? diffInlineDeleteClassName : op === 'structural' ? diffStructuralClassName : ''}>
        {(token.children || []).map((child, index) => renderInlineToken(child, `${key}-${index}`, op))}
      </Tag>
    );
  }

  if (token.kind === 'link') {
    const linkClass = classNames(
      'underline underline-offset-2',
      op === 'equal'
        ? ''
        : atomicInlineClass(op, op === 'delete' ? 'line-through decoration-rose-700/80' : '')
    );
    return (
      <a key={key} data-diff-op={op === 'equal' ? undefined : op} href={token.url} title={token.title || undefined} className={linkClass}>
        {(token.children || []).map((child, index) => renderInlineToken(child, `${key}-${index}`, op === 'equal' ? 'equal' : 'equal'))}
      </a>
    );
  }

  return renderInlineAtom(token, key, op);
}

function renderInlineDiff(oldTokens: InlineToken[], newTokens: InlineToken[], keyPrefix: string): ReactNode[] {
  const requiresAtomicReplacement = (oldToken: InlineToken, newToken: InlineToken) => {
    if (oldToken.kind !== newToken.kind) return false;
    return ['html', 'image', 'inlineCode', 'inlineMath'].includes(oldToken.kind);
  };
  const parts = diffArrays<InlineToken>(oldTokens, newTokens, {
    comparator: (left, right) => tokenSignature(left) === tokenSignature(right),
  });
  const nodes: ReactNode[] = [];
  const pushAtomicPair = (key: string, oldNode: ReactNode, newNode: ReactNode) => {
    nodes.push(
      <span key={key} className="mx-0.5 inline-flex flex-wrap items-center gap-1 align-baseline">
        {oldNode}
        {newNode}
      </span>
    );
  };

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.added && !part.removed) {
      nodes.push(...part.value.map((token, tokenIndex) => renderInlineToken(token, `${keyPrefix}-eq-${index}-${tokenIndex}`)));
      continue;
    }

    if (part.removed && index + 1 < parts.length && parts[index + 1].added) {
      const removed = part.value;
      const added = parts[index + 1].value;
      const shared = Math.min(removed.length, added.length);
      for (let offset = 0; offset < shared; offset += 1) {
        const oldToken = removed[offset];
        const newToken = added[offset];
        const sameKind = oldToken.kind === newToken.kind;
        if (oldToken.kind === 'text' && newToken.kind === 'text') {
          nodes.push(...renderTextDiff(oldToken.value || '', newToken.value || '', `${keyPrefix}-txt-${index}-${offset}`));
          continue;
        }
        if (sameKind && oldToken.children && newToken.children) {
          if (oldToken.kind === 'link' && oldToken.url !== newToken.url) {
            pushAtomicPair(
              `${keyPrefix}-linkpair-${index}-${offset}`,
              renderInlineToken(oldToken, `${keyPrefix}-old-${index}-${offset}`, 'delete'),
              renderInlineToken(newToken, `${keyPrefix}-new-${index}-${offset}`, 'insert')
            );
            continue;
          }

          const Tag =
            oldToken.kind === 'strong'
              ? 'strong'
              : oldToken.kind === 'emphasis'
                ? 'em'
                : oldToken.kind === 'delete'
                  ? 'del'
                  : oldToken.kind === 'link'
                    ? 'a'
                    : null;

          if (Tag) {
            const children = renderInlineDiff(oldToken.children, newToken.children, `${keyPrefix}-nested-${index}-${offset}`);
            if (Tag === 'a') {
              nodes.push(
                <a key={`${keyPrefix}-nested-link-${index}-${offset}`} href={newToken.url} title={newToken.title || undefined} className="underline underline-offset-2">
                  {children}
                </a>
              );
            } else {
              nodes.push(<Tag key={`${keyPrefix}-nested-${index}-${offset}`}>{children}</Tag>);
            }
            continue;
          }
        }

        if (requiresAtomicReplacement(oldToken, newToken)) {
          pushAtomicPair(
            `${keyPrefix}-atomic-${index}-${offset}`,
            renderInlineToken(oldToken, `${keyPrefix}-del-${index}-${offset}`, 'delete'),
            renderInlineToken(newToken, `${keyPrefix}-ins-${index}-${offset}`, 'insert')
          );
          continue;
        }

        if (tokenPlainText(oldToken) === tokenPlainText(newToken)) {
          nodes.push(renderInlineToken(newToken, `${keyPrefix}-struct-${index}-${offset}`, 'structural'));
          continue;
        }

        nodes.push(renderInlineToken(oldToken, `${keyPrefix}-del-${index}-${offset}`, 'delete'));
        nodes.push(renderInlineToken(newToken, `${keyPrefix}-ins-${index}-${offset}`, 'insert'));
      }

      for (const [tokenIndex, token] of removed.slice(shared).entries()) {
        nodes.push(renderInlineToken(token, `${keyPrefix}-tail-del-${index}-${tokenIndex}`, 'delete'));
      }
      for (const [tokenIndex, token] of added.slice(shared).entries()) {
        nodes.push(renderInlineToken(token, `${keyPrefix}-tail-ins-${index}-${tokenIndex}`, 'insert'));
      }

      index += 1;
      continue;
    }

    if (part.removed) {
      nodes.push(...part.value.map((token, tokenIndex) => renderInlineToken(token, `${keyPrefix}-rm-${index}-${tokenIndex}`, 'delete')));
      continue;
    }

    nodes.push(...part.value.map((token, tokenIndex) => renderInlineToken(token, `${keyPrefix}-ad-${index}-${tokenIndex}`, 'insert')));
  }

  return nodes;
}

function renderInlineFromNodes(oldNodes: PhrasingContent[] = [], newNodes: PhrasingContent[] = [], keyPrefix: string) {
  return renderInlineDiff(tokenizeInline(oldNodes), tokenizeInline(newNodes), keyPrefix);
}

function renderParagraphLike(oldNode: any, newNode: any, key: string, toneClass = '') {
  const children = renderInlineFromNodes(
    (oldNode?.children || []) as PhrasingContent[],
    (newNode?.children || []) as PhrasingContent[],
    key
  );
  return <p key={key} className={`my-0 leading-6 ${toneClass}`}>{children}</p>;
}

function renderHeading(oldNode: any, newNode: any, key: string) {
  const depth = (newNode?.depth || oldNode?.depth || 1) as 1 | 2 | 3 | 4 | 5 | 6;
  const children = renderInlineFromNodes(
    (oldNode?.children || []) as PhrasingContent[],
    (newNode?.children || []) as PhrasingContent[],
    `${key}-inline`
  );
  const className = 'mt-0 mb-2 font-semibold tracking-tight text-theme-text';
  if (depth === 1) return <h1 key={key} className={`text-2xl ${className}`}>{children}</h1>;
  if (depth === 2) return <h2 key={key} className={`text-xl ${className}`}>{children}</h2>;
  if (depth === 3) return <h3 key={key} className={`text-lg ${className}`}>{children}</h3>;
  if (depth === 4) return <h4 key={key} className={`text-base ${className}`}>{children}</h4>;
  if (depth === 5) return <h5 key={key} className={`text-sm ${className}`}>{children}</h5>;
  return <h6 key={key} className={`text-sm uppercase tracking-[0.12em] ${className}`}>{children}</h6>;
}

function calloutTone(kind: string) {
  if (kind === 'warning' || kind === 'caution') return 'border-amber-500/30 bg-amber-500/10 text-amber-900';
  if (kind === 'danger' || kind === 'error') return 'border-rose-500/30 bg-rose-500/10 text-rose-900';
  if (kind === 'tip' || kind === 'success') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900';
  return 'border-sky-500/30 bg-sky-500/8 text-theme-text';
}

function stripCalloutMarker(children: any[] = []) {
  const cloned = children.map((child) => ({ ...child }));
  const first = cloned[0];
  if (first?.type !== 'paragraph') return cloned;
  const firstText = first.children?.[0];
  if (firstText?.type !== 'text' || typeof firstText.value !== 'string') return cloned;
  first.children = [...first.children];
  first.children[0] = { ...firstText, value: firstText.value.replace(/^\[!\w+\]\s*/, '') };
  return cloned;
}

function renderChildrenBlocks(oldChildren: Content[] = [], newChildren: Content[] = [], keyPrefix: string): ReactNode[] {
  const parts = diffArrays<Content>(oldChildren, newChildren, {
    comparator: (left, right) => left.type === right.type && toString(left) === toString(right),
  });
  const nodes: ReactNode[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.added && !part.removed) {
      nodes.push(...part.value.map((node, nodeIndex) => renderBlockNode(node, node, `${keyPrefix}-eq-${index}-${nodeIndex}`)));
      continue;
    }

    if (part.removed && index + 1 < parts.length && parts[index + 1].added) {
      const removed = part.value;
      const added = parts[index + 1].value;
      const shared = Math.min(removed.length, added.length);
      for (let offset = 0; offset < shared; offset += 1) {
        nodes.push(renderBlockNode(removed[offset], added[offset], `${keyPrefix}-pair-${index}-${offset}`));
      }
      for (const [nodeIndex, node] of removed.slice(shared).entries()) {
        nodes.push(
          <div key={`${keyPrefix}-rm-${index}-${nodeIndex}`} className={diffInlineDeleteClassName}>
            {renderBlockNode(node, null, `${keyPrefix}-rm-node-${index}-${nodeIndex}`)}
          </div>
        );
      }
      for (const [nodeIndex, node] of added.slice(shared).entries()) {
        nodes.push(
          <div key={`${keyPrefix}-ad-${index}-${nodeIndex}`} className={diffInlineInsertClassName}>
            {renderBlockNode(null, node, `${keyPrefix}-ad-node-${index}-${nodeIndex}`)}
          </div>
        );
      }
      index += 1;
      continue;
    }

    if (part.removed) {
      nodes.push(
        ...part.value.map((node, nodeIndex) => (
          <div key={`${keyPrefix}-del-${index}-${nodeIndex}`} className={diffInlineDeleteClassName}>
            {renderBlockNode(node, null, `${keyPrefix}-del-node-${index}-${nodeIndex}`)}
          </div>
        ))
      );
      continue;
    }

    nodes.push(
      ...part.value.map((node, nodeIndex) => (
        <div key={`${keyPrefix}-ins-${index}-${nodeIndex}`} className={diffInlineInsertClassName}>
          {renderBlockNode(null, node, `${keyPrefix}-ins-node-${index}-${nodeIndex}`)}
        </div>
      ))
    );
  }

  return nodes;
}

function renderListItem(oldItem: ListItem | null, newItem: ListItem | null, key: string) {
  const checked = typeof newItem?.checked === 'boolean' ? newItem.checked : oldItem?.checked;
  const oldChecked = typeof oldItem?.checked === 'boolean' ? oldItem.checked : null;
  const newChecked = typeof newItem?.checked === 'boolean' ? newItem.checked : null;
  const checkboxChanged = oldChecked !== null && newChecked !== null && oldChecked !== newChecked;
  const children = renderChildrenBlocks(
    (oldItem?.children || []) as Content[],
    (newItem?.children || []) as Content[],
    `${key}-children`
  );

  return (
    <li key={key} className="my-1">
      {(oldChecked !== null || newChecked !== null) ? (
        <span className={`mr-2 inline-flex h-4 w-4 items-center justify-center rounded border text-[10px] ${checkboxChanged ? diffStructuralClassName : 'border-theme-border/30 bg-theme-bg/70'}`}>
          {(checked ? 'x' : '')}
        </span>
      ) : null}
      <div className="inline-flex min-w-0 flex-col gap-1 align-top">{children}</div>
    </li>
  );
}

function renderList(oldNode: any, newNode: any, key: string) {
  const ordered = Boolean(newNode?.ordered ?? oldNode?.ordered);
  const Tag = ordered ? 'ol' : 'ul';
  const parts = diffArrays<ListItem>((oldNode?.children || []) as ListItem[], (newNode?.children || []) as ListItem[], {
    comparator: (left, right) => toString(left) === toString(right) && left.checked === right.checked,
  });
  const items: ReactNode[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.added && !part.removed) {
      items.push(...part.value.map((item, itemIndex) => renderListItem(item, item, `${key}-eq-${index}-${itemIndex}`)));
      continue;
    }

    if (part.removed && index + 1 < parts.length && parts[index + 1].added) {
      const removed = part.value;
      const added = parts[index + 1].value;
      const shared = Math.min(removed.length, added.length);
      for (let offset = 0; offset < shared; offset += 1) {
        items.push(renderListItem(removed[offset], added[offset], `${key}-pair-${index}-${offset}`));
      }
      for (const [itemIndex, item] of removed.slice(shared).entries()) {
        items.push(<div key={`${key}-rm-${index}-${itemIndex}`} className={diffInlineDeleteClassName}>{renderListItem(item, null, `${key}-rm-item-${index}-${itemIndex}`)}</div>);
      }
      for (const [itemIndex, item] of added.slice(shared).entries()) {
        items.push(<div key={`${key}-ad-${index}-${itemIndex}`} className={diffInlineInsertClassName}>{renderListItem(null, item, `${key}-ad-item-${index}-${itemIndex}`)}</div>);
      }
      index += 1;
      continue;
    }

    if (part.removed) {
      items.push(...part.value.map((item, itemIndex) => <div key={`${key}-del-${index}-${itemIndex}`} className={diffInlineDeleteClassName}>{renderListItem(item, null, `${key}-del-item-${index}-${itemIndex}`)}</div>));
      continue;
    }

    items.push(...part.value.map((item, itemIndex) => <div key={`${key}-ins-${index}-${itemIndex}`} className={diffInlineInsertClassName}>{renderListItem(null, item, `${key}-ins-item-${index}-${itemIndex}`)}</div>));
  }

  return <Tag key={key} className={`my-0 ${ordered ? 'list-decimal pl-5' : 'list-disc pl-5'}`}>{items}</Tag>;
}

function renderBlockquote(oldNode: any, newNode: any, key: string, callout: DiffCalloutMeta | null) {
  const oldChildren = callout ? stripCalloutMarker(oldNode?.children || []) : oldNode?.children || [];
  const newChildren = callout ? stripCalloutMarker(newNode?.children || []) : newNode?.children || [];
  const body = renderChildrenBlocks(oldChildren as Content[], newChildren as Content[], `${key}-body`);

  if (callout) {
    return (
      <aside key={key} className={`rounded-lg border px-3 py-2 ${calloutTone(callout.kind)}`}>
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em]">{callout.title || callout.kind}</div>
        <div className="flex flex-col gap-1">{body}</div>
      </aside>
    );
  }

  return (
    <blockquote key={key} className="my-0 border-l-2 border-theme-border/30 pl-3 text-theme-text/80">
      <div className="flex flex-col gap-1">{body}</div>
    </blockquote>
  );
}

function renderTableCell(oldCell: TableCell | null, newCell: TableCell | null, key: string) {
  return (
    <td key={key} className="border border-theme-border/20 px-2 py-1 align-top">
      {renderInlineFromNodes(
        ((oldCell?.children || []) as PhrasingContent[]),
        ((newCell?.children || []) as PhrasingContent[]),
        `${key}-cell`
      )}
    </td>
  );
}

function renderTable(oldNode: Table | null, newNode: Table | null, key: string) {
  const oldRows = (oldNode?.children || []) as TableRow[];
  const newRows = (newNode?.children || []) as TableRow[];
  const header = newRows[0] || oldRows[0] || null;
  const bodyParts = diffArrays<TableRow>(oldRows.slice(1), newRows.slice(1), {
    comparator: (left, right) => toString(left) === toString(right),
  });

  const bodyRows: ReactNode[] = [];
  for (let index = 0; index < bodyParts.length; index += 1) {
    const part = bodyParts[index];
    if (!part.added && !part.removed) {
      bodyRows.push(
        ...part.value.map((row, rowIndex) => (
          <tr key={`${key}-eq-${index}-${rowIndex}`}>
            {row.children.map((cell, cellIndex) => renderTableCell(cell, cell, `${key}-eq-cell-${index}-${rowIndex}-${cellIndex}`))}
          </tr>
        ))
      );
      continue;
    }

    if (part.removed && index + 1 < bodyParts.length && bodyParts[index + 1].added) {
      const removed = part.value;
      const added = bodyParts[index + 1].value;
      const shared = Math.min(removed.length, added.length);
      for (let offset = 0; offset < shared; offset += 1) {
        const oldRow = removed[offset];
        const newRow = added[offset];
        bodyRows.push(
          <tr key={`${key}-pair-${index}-${offset}`}>
            {Array.from({ length: Math.max(oldRow.children.length, newRow.children.length) }).map((_, cellIndex) =>
              renderTableCell(oldRow.children[cellIndex] || null, newRow.children[cellIndex] || null, `${key}-pair-cell-${index}-${offset}-${cellIndex}`)
            )}
          </tr>
        );
      }
      for (const [rowIndex, row] of removed.slice(shared).entries()) {
        bodyRows.push(
          <tr key={`${key}-rm-${index}-${rowIndex}`} className="bg-rose-500/10">
            {row.children.map((cell, cellIndex) => renderTableCell(cell, null, `${key}-rm-cell-${index}-${rowIndex}-${cellIndex}`))}
          </tr>
        );
      }
      for (const [rowIndex, row] of added.slice(shared).entries()) {
        bodyRows.push(
          <tr key={`${key}-ad-${index}-${rowIndex}`} className="bg-emerald-500/10">
            {row.children.map((cell, cellIndex) => renderTableCell(null, cell, `${key}-ad-cell-${index}-${rowIndex}-${cellIndex}`))}
          </tr>
        );
      }
      index += 1;
      continue;
    }

    if (part.removed) {
      bodyRows.push(
        ...part.value.map((row, rowIndex) => (
          <tr key={`${key}-del-${index}-${rowIndex}`} className="bg-rose-500/10">
            {row.children.map((cell, cellIndex) => renderTableCell(cell, null, `${key}-del-cell-${index}-${rowIndex}-${cellIndex}`))}
          </tr>
        ))
      );
      continue;
    }

    bodyRows.push(
      ...part.value.map((row, rowIndex) => (
        <tr key={`${key}-ins-${index}-${rowIndex}`} className="bg-emerald-500/10">
          {row.children.map((cell, cellIndex) => renderTableCell(null, cell, `${key}-ins-cell-${index}-${rowIndex}-${cellIndex}`))}
        </tr>
      ))
    );
  }

  return (
    <div key={key} className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {header ? (
          <thead>
            <tr>
              {header.children.map((cell, cellIndex) => (
                <th key={`${key}-head-${cellIndex}`} className="border border-theme-border/20 px-2 py-1 text-left font-semibold">
                  {renderInlineFromNodes((cell.children || []) as PhrasingContent[], (cell.children || []) as PhrasingContent[], `${key}-head-cell-${cellIndex}`)}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>{bodyRows}</tbody>
      </table>
    </div>
  );
}

function renderCodeBlock(oldNode: any, newNode: any, key: string, langLabel?: string) {
  const oldLines = String(oldNode?.value || '').split('\n');
  const newLines = String(newNode?.value || '').split('\n');
  const parts = diffArrays<string>(oldLines, newLines);
  const rows: ReactNode[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.added && !part.removed) {
      rows.push(...part.value.map((line, lineIndex) => <div key={`${key}-eq-${index}-${lineIndex}`} className="px-3 py-0.5">{line || ' '}</div>));
      continue;
    }
    if (part.removed && index + 1 < parts.length && parts[index + 1].added) {
      const removed = part.value;
      const added = parts[index + 1].value;
      const shared = Math.min(removed.length, added.length);
      for (let offset = 0; offset < shared; offset += 1) {
        rows.push(
          <div key={`${key}-pair-${index}-${offset}`} className="grid grid-cols-2 gap-px">
            <div className="bg-rose-500/10 px-3 py-0.5 line-through decoration-rose-700/80">{removed[offset] || ' '}</div>
            <div className="bg-emerald-500/10 px-3 py-0.5">{added[offset] || ' '}</div>
          </div>
        );
      }
      for (const [lineIndex, line] of removed.slice(shared).entries()) {
        rows.push(<div key={`${key}-rm-${index}-${lineIndex}`} className="bg-rose-500/10 px-3 py-0.5 line-through decoration-rose-700/80">{line || ' '}</div>);
      }
      for (const [lineIndex, line] of added.slice(shared).entries()) {
        rows.push(<div key={`${key}-ad-${index}-${lineIndex}`} className="bg-emerald-500/10 px-3 py-0.5">{line || ' '}</div>);
      }
      index += 1;
      continue;
    }
    if (part.removed) {
      rows.push(...part.value.map((line, lineIndex) => <div key={`${key}-del-${index}-${lineIndex}`} className="bg-rose-500/10 px-3 py-0.5 line-through decoration-rose-700/80">{line || ' '}</div>));
      continue;
    }
    rows.push(...part.value.map((line, lineIndex) => <div key={`${key}-ins-${index}-${lineIndex}`} className="bg-emerald-500/10 px-3 py-0.5">{line || ' '}</div>));
  }

  return (
    <div key={key} className={`${markdownCodeBlockClassName} bg-theme-bg/80`}>
      {langLabel ? <div className="border-b border-theme-border/10 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-theme-text/50">{langLabel}</div> : null}
      <pre className="m-0 overflow-x-auto bg-transparent py-2 text-xs text-theme-text"><code>{rows}</code></pre>
    </div>
  );
}

function renderMathBlock(oldNode: any, newNode: any, key: string) {
  if (oldNode?.value && newNode?.value && oldNode.value !== newNode.value) {
    return (
      <div key={key} className="flex flex-col gap-2">
        <div className={diffInlineDeleteClassName}>{renderMath(oldNode.value, true, `${key}-old`, 'overflow-x-auto')}</div>
        <div className={diffInlineInsertClassName}>{renderMath(newNode.value, true, `${key}-new`, 'overflow-x-auto')}</div>
      </div>
    );
  }

  return <div key={key}>{renderMath((newNode?.value || oldNode?.value || '') as string, true, `${key}-math`, 'overflow-x-auto')}</div>;
}

function renderHtmlBlock(oldNode: any, newNode: any, key: string) {
  const oldValue = oldNode?.value || '';
  const newValue = newNode?.value || '';
  if (oldValue && newValue && oldValue !== newValue) {
    return (
      <div key={key} className="flex flex-col gap-1.5">
        <div
          data-diff-op="delete"
          className="my-0 inline-block w-fit max-w-full rounded-md bg-rose-500/20 px-2.5 py-1 text-theme-text/70 line-through decoration-rose-700/80"
          dangerouslySetInnerHTML={{ __html: oldValue }}
        />
        <div
          data-diff-op="insert"
          className="my-0 inline-block w-fit max-w-full rounded-md bg-emerald-500/20 px-2.5 py-1 text-theme-text"
          dangerouslySetInnerHTML={{ __html: newValue }}
        />
      </div>
    );
  }
  return <div key={key} className="my-0" dangerouslySetInnerHTML={{ __html: newValue || oldValue }} />;
}

function parseFrontmatter(node: any): Array<[string, string]> {
  const content = String(node?.value || '');
  return content
    .split('\n')
    .map((line: string) => line.trim())
    .filter(Boolean)
    .map((line: string) => {
      const separator = line.indexOf(':');
      if (separator === -1) return [line, ''];
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    });
}

function renderFrontmatter(oldNode: any, newNode: any, key: string) {
  const oldEntries = new Map(parseFrontmatter(oldNode));
  const newEntries = new Map(parseFrontmatter(newNode));
  const keys = Array.from(new Set([...oldEntries.keys(), ...newEntries.keys()]));

  return (
    <div key={key} className="overflow-x-auto rounded-md border border-theme-border/20">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="border border-theme-border/20 px-2 py-1 text-left font-semibold">Key</th>
            <th className="border border-theme-border/20 px-2 py-1 text-left font-semibold">Value</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((entryKey) => {
            const oldValue = oldEntries.get(entryKey) || '';
            const newValue = newEntries.get(entryKey) || '';
            return (
              <tr key={`${key}-${entryKey}`}>
                <td className="border border-theme-border/20 px-2 py-1 font-mono text-xs">{entryKey}</td>
                <td className="border border-theme-border/20 px-2 py-1">{renderTextDiff(oldValue, newValue, `${key}-${entryKey}`)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function renderFootnote(oldNode: any, newNode: any, key: string) {
  return (
    <section key={key} className="rounded-md border border-theme-border/20 bg-theme-surface/40 px-3 py-2">
      <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-theme-text/50">
        Footnote {(newNode?.identifier || oldNode?.identifier || '').toString()}
      </div>
      <div className="flex flex-col gap-1">
        {renderChildrenBlocks((oldNode?.children || []) as Content[], (newNode?.children || []) as Content[], `${key}-footnote`)}
      </div>
    </section>
  );
}

function renderBlockNode(oldNode: Content | null, newNode: Content | null, key: string): ReactNode {
  const node = newNode || oldNode;
  if (!node) return null;

  if (oldNode && newNode && oldNode.type !== newNode.type) {
    return (
      <div key={key} className="flex flex-col gap-1.5">
        <div className={diffBlockDeleteClassName}>{renderBlockNode(oldNode, null, `${key}-old`)}</div>
        <div className={diffBlockInsertClassName}>{renderBlockNode(null, newNode, `${key}-new`)}</div>
      </div>
    );
  }

  switch (node.type) {
    case 'heading':
      return renderHeading(oldNode, newNode, key);
    case 'paragraph':
      return renderParagraphLike(oldNode, newNode, key);
    case 'blockquote': {
      const meta = (() => {
        const firstParagraph = ((newNode || oldNode) as Parent).children?.[0] as Content | undefined;
        const firstText = (firstParagraph as any)?.children?.[0]?.value;
        const match = typeof firstText === 'string' ? firstText.match(/^\[!(\w+)\]\s*(.*)$/) : null;
        return match ? { kind: match[1].toLowerCase(), title: match[2]?.trim() || null } : null;
      })();
      return renderBlockquote(oldNode, newNode, key, meta);
    }
    case 'list':
      return renderList(oldNode, newNode, key);
    case 'code':
      return renderCodeBlock(oldNode, newNode, key, (newNode as any)?.lang || (oldNode as any)?.lang || undefined);
    case 'math':
      return renderMathBlock(oldNode, newNode, key);
    case 'table':
      return renderTable(oldNode as Table | null, newNode as Table | null, key);
    case 'html':
      return renderHtmlBlock(oldNode, newNode, key);
    case 'yaml':
    case 'toml' as any:
      return renderFrontmatter(oldNode, newNode, key);
    case 'footnoteDefinition':
      return renderFootnote(oldNode, newNode, key);
    case 'thematicBreak':
      return <hr key={key} className="border-theme-border/20" />;
    default:
      return (
        <pre key={key} className={`${markdownCodeBlockClassName} my-0 text-xs`}>
          {escapeHtml(toString(node) || '')}
        </pre>
      );
  }
}

function renderBlockContent(block: DiffBlock) {
  const oldNode = primaryNode(block.oldRoot);
  const newNode = primaryNode(block.newRoot);
  return renderBlockNode(oldNode, newNode, block.id);
}

function unitFirstLineNumber(unit: ReviewUnit) {
  return unit.changedRows[0]?.newLineNumber ?? unit.changedRows[0]?.oldLineNumber ?? unit.changedRows[0]?.reviewLineNumber ?? null;
}

function unitIsSelected(unit: ReviewUnit, selectedLineId: string | null) {
  return Boolean(selectedLineId && unit.lineIds.includes(selectedLineId));
}

function reviewControlVisibilityClass(unit: ReviewUnit, selectedLineId: string | null) {
  return unitIsSelected(unit, selectedLineId)
    ? 'opacity-100'
    : 'pointer-events-none opacity-0 group-hover/review:opacity-100 group-focus-within/review:opacity-100';
}

function DecisionButtons({
  unit,
  onApplyLineDecision,
}: {
  unit: ReviewUnit;
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>;
}) {
  if (!onApplyLineDecision) return null;

  const target = unit.lineIds.length === 1 ? unit.lineIds[0] : unit.lineIds;
  const lineNumber = unitFirstLineNumber(unit);
  const subject =
    unit.kind === 'line' || unit.kind === 'code_line'
      ? `line ${lineNumber ?? ''}`.trim()
      : unit.label || unit.kind.replace('_', ' ');

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => void onApplyLineDecision(target, 'accepted')}
        className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-800 transition-colors hover:bg-emerald-500/20"
        aria-label={`Accept ${subject}`}
      >
        <Check size={11} />
      </button>
      <button
        type="button"
        onClick={() => void onApplyLineDecision(target, 'rejected')}
        className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-500/10 text-rose-800 transition-colors hover:bg-rose-500/20"
        aria-label={`Reject ${subject}`}
      >
        <X size={11} />
      </button>
    </div>
  );
}

function ReviewControlsOverlay({
  unit,
  selectedLineId,
  onApplyLineDecision,
  className = '',
}: {
  unit: ReviewUnit;
  selectedLineId: string | null;
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>;
  className?: string;
}) {
  if (!onApplyLineDecision) return null;

  return (
    <div
      className={`absolute z-20 ${className} ${reviewControlVisibilityClass(unit, selectedLineId)}`}
    >
      <div className="pointer-events-auto rounded-full border border-theme-border/20 bg-theme-bg/90 p-0.5 shadow-sm backdrop-blur-sm">
        <DecisionButtons unit={unit} onApplyLineDecision={onApplyLineDecision} />
      </div>
    </div>
  );
}

function ReviewAnchor({
  unit,
  selectedLineId,
  onSelectLine,
  onApplyLineDecision,
  controlsClassName = 'right-0 top-0',
  className = '',
  testId = true,
  children,
}: {
  unit: ReviewUnit;
  selectedLineId: string | null;
  onSelectLine?: (lineId: string) => void;
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>;
  controlsClassName?: string;
  className?: string;
  testId?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId ? 'diff-review-unit' : undefined}
      data-review-unit={unit.kind}
      className={`group/review relative min-w-0 ${className}`}
      onMouseEnter={() => {
        const firstLineId = unit.lineIds[0];
        if (firstLineId) onSelectLine?.(firstLineId);
      }}
    >
      {children}
      <ReviewControlsOverlay
        unit={unit}
        selectedLineId={selectedLineId}
        onApplyLineDecision={onApplyLineDecision}
        className={controlsClassName}
      />
    </div>
  );
}

function renderUnitMarkdown(unit: ReviewUnit) {
  return unit.rows
    .map((row) =>
      row.status === 'equal'
        ? row.newText ?? row.oldText ?? ''
        : buildMergedLineMarkdown(row.oldText, row.newText)
    )
    .join('\n');
}

function renderLineUnit(unit: ReviewUnit, block: DiffBlock) {
  if (block.kind === 'heading' || block.kind === 'paragraph' || block.kind === 'blockquote') {
    const oldRoot = parseMarkdownRoot(contentFromRows(unit.rows, 'old'));
    const newRoot = parseMarkdownRoot(contentFromRows(unit.rows, 'new'));
    const oldNode = primaryNode(oldRoot);
    const newNode = primaryNode(newRoot);
    if (oldNode || newNode) {
      return renderBlockNode(oldNode, newNode, unit.id);
    }
  }

  return (
    <MarkdownContent
      content={renderUnitMarkdown(unit)}
      variant="diff"
      className="prose-xs leading-6 [&_.katex-display]:my-0.5 [&_blockquote]:my-0 [&_code]:whitespace-break-spaces [&_h1]:my-0 [&_h2]:my-0 [&_h3]:my-0 [&_li]:my-0.5 [&_ol]:my-0 [&_p]:my-0 [&_pre]:my-0 [&_ul]:my-0"
    />
  );
}

function renderLineUnitsBlock(
  block: DiffBlock,
  selectedLineId: string | null,
  onSelectLine?: (lineId: string) => void,
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>
) {
  return block.reviewUnits.map((unit) => (
    <ReviewAnchor
      key={unit.id}
      unit={unit}
      selectedLineId={selectedLineId}
      onSelectLine={onSelectLine}
      onApplyLineDecision={onApplyLineDecision}
      controlsClassName="right-0 top-0"
      className="min-w-0"
    >
      {renderLineUnit(unit, block)}
    </ReviewAnchor>
  ));
}

function renderListItemBody(oldItem: ListItem | null, newItem: ListItem | null, key: string) {
  const checked = typeof newItem?.checked === 'boolean' ? newItem.checked : oldItem?.checked;
  const oldChecked = typeof oldItem?.checked === 'boolean' ? oldItem.checked : null;
  const newChecked = typeof newItem?.checked === 'boolean' ? newItem.checked : null;
  const checkboxChanged = oldChecked !== null && newChecked !== null && oldChecked !== newChecked;
  const children = renderChildrenBlocks(
    (oldItem?.children || []) as Content[],
    (newItem?.children || []) as Content[],
    `${key}-children`
  );

  return (
    <>
      {(oldChecked !== null || newChecked !== null) ? (
        <span className={`mr-2 inline-flex h-4 w-4 items-center justify-center rounded border text-[10px] ${checkboxChanged ? diffStructuralClassName : 'border-theme-border/30 bg-theme-bg/70'}`}>
          {(checked ? 'x' : '')}
        </span>
      ) : null}
      <div className="inline-flex min-w-0 flex-col gap-1 align-top">{children}</div>
    </>
  );
}

function renderListReviewItem({
  oldItem,
  newItem,
  key,
  unit,
  selectedLineId,
  onSelectLine,
  onApplyLineDecision,
  toneClass = '',
}: {
  oldItem: ListItem | null;
  newItem: ListItem | null;
  key: string;
  unit: ReviewUnit | null;
  selectedLineId: string | null;
  onSelectLine?: (lineId: string) => void;
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>;
  toneClass?: string;
}) {
  const content = renderListItemBody(oldItem, newItem, key);
  if (!unit) {
    return <li key={key} className={`my-1 ${toneClass}`}>{content}</li>;
  }

  return (
    <li key={key} className={`my-1 ${toneClass}`}>
      <ReviewAnchor
        unit={unit}
        selectedLineId={selectedLineId}
        onSelectLine={onSelectLine}
        onApplyLineDecision={onApplyLineDecision}
        controlsClassName="right-0 top-0"
        className="min-w-0"
      >
        {content}
      </ReviewAnchor>
    </li>
  );
}

function renderListBlockUnits(
  block: DiffBlock,
  selectedLineId: string | null,
  onSelectLine?: (lineId: string) => void,
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>
) {
  const oldList = primaryNode(block.oldRoot) as List | null;
  const newList = primaryNode(block.newRoot) as List | null;
  if ((!oldList || oldList.type !== 'list') && (!newList || newList.type !== 'list')) {
    return renderLineUnitsBlock(block, selectedLineId, onSelectLine, onApplyLineDecision);
  }

  const ordered = Boolean(newList?.ordered ?? oldList?.ordered);
  const Tag = ordered ? 'ol' : 'ul';
  const oldItems = (oldList?.children || []) as ListItem[];
  const newItems = (newList?.children || []) as ListItem[];
  const parts = diffArrays<ListItem>(oldItems, newItems, {
    comparator: (left, right) => toString(left) === toString(right) && left.checked === right.checked,
  });
  const units = [...block.reviewUnits];
  let unitIndex = 0;
  const nextUnit = () => units[unitIndex++] || null;
  const items: ReactNode[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.added && !part.removed) {
      items.push(
        ...part.value.map((item, itemIndex) =>
          renderListReviewItem({
            oldItem: item,
            newItem: item,
            key: `${block.id}-eq-${index}-${itemIndex}`,
            unit: null,
            selectedLineId,
            onSelectLine,
            onApplyLineDecision,
          })
        )
      );
      continue;
    }

    if (part.removed && index + 1 < parts.length && parts[index + 1].added) {
      const removed = part.value;
      const added = parts[index + 1].value;
      const shared = Math.min(removed.length, added.length);
      for (let offset = 0; offset < shared; offset += 1) {
        items.push(
          renderListReviewItem({
            oldItem: removed[offset],
            newItem: added[offset],
            key: `${block.id}-pair-${index}-${offset}`,
            unit: nextUnit(),
            selectedLineId,
            onSelectLine,
            onApplyLineDecision,
          })
        );
      }
      for (const [itemIndex, item] of removed.slice(shared).entries()) {
        items.push(
          renderListReviewItem({
            oldItem: item,
            newItem: null,
            key: `${block.id}-rm-${index}-${itemIndex}`,
            unit: nextUnit(),
            selectedLineId,
            onSelectLine,
            onApplyLineDecision,
            toneClass: diffBlockDeleteClassName,
          })
        );
      }
      for (const [itemIndex, item] of added.slice(shared).entries()) {
        items.push(
          renderListReviewItem({
            oldItem: null,
            newItem: item,
            key: `${block.id}-ad-${index}-${itemIndex}`,
            unit: nextUnit(),
            selectedLineId,
            onSelectLine,
            onApplyLineDecision,
            toneClass: diffBlockInsertClassName,
          })
        );
      }
      index += 1;
      continue;
    }

    if (part.removed) {
      items.push(
        ...part.value.map((item, itemIndex) =>
          renderListReviewItem({
            oldItem: item,
            newItem: null,
            key: `${block.id}-del-${index}-${itemIndex}`,
            unit: nextUnit(),
            selectedLineId,
            onSelectLine,
            onApplyLineDecision,
            toneClass: diffBlockDeleteClassName,
          })
        )
      );
      continue;
    }

    items.push(
      ...part.value.map((item, itemIndex) =>
        renderListReviewItem({
          oldItem: null,
          newItem: item,
          key: `${block.id}-ins-${index}-${itemIndex}`,
          unit: nextUnit(),
          selectedLineId,
          onSelectLine,
          onApplyLineDecision,
          toneClass: diffBlockInsertClassName,
        })
      )
    );
  }

  return <Tag className={`my-0 ${ordered ? 'list-decimal pl-5' : 'list-disc pl-5'}`}>{items}</Tag>;
}

function resolveUnitForNode(block: DiffBlock, node: TableRow | null) {
  if (!node) return null;
  const lineIds = sliceRowsByPosition(block.rows, node)
    .map((row) => row.id)
    .filter((id): id is string => Boolean(id));
  return block.reviewUnits.find((unit) => unit.lineIds.some((lineId) => lineIds.includes(lineId))) || null;
}

function renderTableCellWithOverlay(
  oldCell: TableCell | null,
  newCell: TableCell | null,
  key: string,
  unit: ReviewUnit | null,
  selectedLineId: string | null,
  onSelectLine?: (lineId: string) => void,
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>
) {
  const content = renderInlineFromNodes(
    ((oldCell?.children || []) as PhrasingContent[]),
    ((newCell?.children || []) as PhrasingContent[]),
    `${key}-cell`
  );

  if (!unit) {
    return <td key={key} className="border border-theme-border/20 px-2 py-1 align-top">{content}</td>;
  }

  return (
    <td key={key} className="border border-theme-border/20 px-2 py-1 align-top">
      <ReviewAnchor
        unit={unit}
        selectedLineId={selectedLineId}
        onSelectLine={onSelectLine}
        onApplyLineDecision={onApplyLineDecision}
        controlsClassName="right-0 top-0"
        className="min-w-0"
        testId={false}
      >
        {content}
      </ReviewAnchor>
    </td>
  );
}

function renderCodeBlockUnits(
  block: DiffBlock,
  selectedLineId: string | null,
  onSelectLine?: (lineId: string) => void,
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>
) {
  const rawLines = block.rows.map((row) => row.newText ?? row.oldText ?? '');
  const fencePattern = /^\s*(`{3,}|~{3,})(.*)$/;
  const firstFence = rawLines[0]?.match(fencePattern);
  const lastFence = rawLines.length > 1 ? rawLines[rawLines.length - 1]?.match(fencePattern) : null;
  const startIndex = firstFence && block.rows[0]?.status === 'equal' ? 1 : 0;
  const endIndex =
    lastFence && block.rows[block.rows.length - 1]?.status === 'equal'
      ? block.rows.length - 1
      : block.rows.length;
  const codeRows = block.rows.slice(startIndex, endIndex);
  const unitByLineId = new Map(block.reviewUnits.flatMap((unit) => unit.lineIds.map((lineId) => [lineId, unit] as const)));
  const describeFence = (
    value: string | null,
    position: 'opening' | 'closing',
    fallbackWhenCounterpartIsFence: boolean
  ) => {
    if (!value) return null;
    const match = value.match(fencePattern);
    if (match) {
      const info = match[2].trim().split(/\s+/)[0] || '';
      return info ? `${position} fence · ${info}` : `${position} fence`;
    }
    return fallbackWhenCounterpartIsFence ? `${position} fence` : null;
  };

  return (
    <div data-testid="diff-review-unit" data-review-unit="code" className="min-w-0">
      <div className={markdownCodeBlockClassName}>
        <pre className="m-0 overflow-x-auto bg-transparent py-2 text-xs text-theme-text">
          <code>
            {codeRows.map((row, index) => {
              const unit = row.id ? unitByLineId.get(row.id) : null;
              const blockIndex = startIndex + index;
              const position = blockIndex === 0 ? 'opening' : 'closing';
              const oldFenceLabel = describeFence(
                row.oldText,
                position,
                Boolean(row.newText?.match(fencePattern))
              );
              const newFenceLabel = describeFence(
                row.newText,
                position,
                Boolean(row.oldText?.match(fencePattern))
              );
              const isFenceRow = Boolean(oldFenceLabel || newFenceLabel);
              return (
                <div
                  key={`${block.id}-code-row-${index}`}
                  data-testid={unit ? 'diff-review-unit' : undefined}
                  data-review-unit={unit?.kind}
                  className="group/review relative px-3 py-0.5"
                  onMouseEnter={() => {
                    const firstLineId = unit?.lineIds[0];
                    if (firstLineId) onSelectLine?.(firstLineId);
                  }}
                >
                  {unit ? (
                    <ReviewControlsOverlay
                      unit={unit}
                      selectedLineId={selectedLineId}
                      onApplyLineDecision={onApplyLineDecision}
                      className="right-1 top-1"
                    />
                  ) : null}
                  <div className="min-w-0">
                    {isFenceRow ? (
                      <div className="space-y-1 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-theme-text/50">
                        {row.status === 'modify' ? (
                          <>
                            {oldFenceLabel ? (
                              <div className="inline-flex rounded-sm bg-rose-500/10 px-1.5 py-0.5 text-rose-800 line-through decoration-rose-700/80">
                                {oldFenceLabel}
                              </div>
                            ) : null}
                            {newFenceLabel ? (
                              <div className="inline-flex rounded-sm bg-emerald-500/10 px-1.5 py-0.5 text-emerald-800">
                                {newFenceLabel}
                              </div>
                            ) : null}
                          </>
                        ) : row.status === 'remove' ? (
                          <div className="inline-flex rounded-sm bg-rose-500/10 px-1.5 py-0.5 text-rose-800 line-through decoration-rose-700/80">
                            {oldFenceLabel}
                          </div>
                        ) : row.status === 'add' ? (
                          <div className="inline-flex rounded-sm bg-emerald-500/10 px-1.5 py-0.5 text-emerald-800">
                            {newFenceLabel}
                          </div>
                        ) : null}
                      </div>
                    ) : row.status === 'modify' ? (
                      <div className="space-y-px">
                        <div className="bg-rose-500/10 px-2 py-0.5 line-through decoration-rose-700/80">{row.oldText || ' '}</div>
                        <div className="bg-emerald-500/10 px-2 py-0.5">{row.newText || ' '}</div>
                      </div>
                    ) : row.status === 'remove' ? (
                      <div className="bg-rose-500/10 px-2 py-0.5 line-through decoration-rose-700/80">{row.oldText || ' '}</div>
                    ) : row.status === 'add' ? (
                      <div className="bg-emerald-500/10 px-2 py-0.5">{row.newText || ' '}</div>
                    ) : (
                      <div className="px-2 py-0.5">{row.newText || row.oldText || ' '}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}

function renderTableBlockUnits(
  block: DiffBlock,
  selectedLineId: string | null,
  onSelectLine?: (lineId: string) => void,
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>
) {
  const oldTable = primaryNode(block.oldRoot) as Table | null;
  const newTable = primaryNode(block.newRoot) as Table | null;
  if ((!oldTable || oldTable.type !== 'table') && (!newTable || newTable.type !== 'table')) {
    return renderBlockContent(block);
  }

  const oldRows = (oldTable?.children || []) as TableRow[];
  const newRows = (newTable?.children || []) as TableRow[];
  const header = newRows[0] || oldRows[0] || null;
  const bodyParts = diffArrays<TableRow>(oldRows.slice(1), newRows.slice(1), {
    comparator: (left, right) => toString(left) === toString(right),
  });
  const bodyRows: ReactNode[] = [];

  for (let index = 0; index < bodyParts.length; index += 1) {
    const part = bodyParts[index];
    if (!part.added && !part.removed) {
      bodyRows.push(
        ...part.value.map((row, rowIndex) => (
          <tr key={`${block.id}-eq-${index}-${rowIndex}`}>
            {row.children.map((cell, cellIndex) => renderTableCellWithOverlay(cell, cell, `${block.id}-eq-cell-${index}-${rowIndex}-${cellIndex}`, null, selectedLineId, onSelectLine, onApplyLineDecision))}
          </tr>
        ))
      );
      continue;
    }

    if (part.removed && index + 1 < bodyParts.length && bodyParts[index + 1].added) {
      const removed = part.value;
      const added = bodyParts[index + 1].value;
      const shared = Math.min(removed.length, added.length);
      for (let offset = 0; offset < shared; offset += 1) {
        const oldRow = removed[offset];
        const newRow = added[offset];
        const unit = resolveUnitForNode(block, newRow) || resolveUnitForNode(block, oldRow);
        bodyRows.push(
          <tr key={`${block.id}-pair-${index}-${offset}`}>
            {Array.from({ length: Math.max(oldRow.children.length, newRow.children.length) }).map((_, cellIndex) =>
              renderTableCellWithOverlay(
                oldRow.children[cellIndex] || null,
                newRow.children[cellIndex] || null,
                `${block.id}-pair-cell-${index}-${offset}-${cellIndex}`,
                cellIndex === 0 ? unit : null,
                selectedLineId,
                onSelectLine,
                onApplyLineDecision
              )
            )}
          </tr>
        );
      }
      for (const [rowIndex, row] of removed.slice(shared).entries()) {
        const unit = resolveUnitForNode(block, row);
        bodyRows.push(
          <tr key={`${block.id}-rm-${index}-${rowIndex}`} className="bg-rose-500/10">
            {row.children.map((cell, cellIndex) =>
              renderTableCellWithOverlay(cell, null, `${block.id}-rm-cell-${index}-${rowIndex}-${cellIndex}`, cellIndex === 0 ? unit : null, selectedLineId, onSelectLine, onApplyLineDecision)
            )}
          </tr>
        );
      }
      for (const [rowIndex, row] of added.slice(shared).entries()) {
        const unit = resolveUnitForNode(block, row);
        bodyRows.push(
          <tr key={`${block.id}-ad-${index}-${rowIndex}`} className="bg-emerald-500/10">
            {row.children.map((cell, cellIndex) =>
              renderTableCellWithOverlay(null, cell, `${block.id}-ad-cell-${index}-${rowIndex}-${cellIndex}`, cellIndex === 0 ? unit : null, selectedLineId, onSelectLine, onApplyLineDecision)
            )}
          </tr>
        );
      }
      index += 1;
      continue;
    }

    if (part.removed) {
      bodyRows.push(
        ...part.value.map((row, rowIndex) => {
          const unit = resolveUnitForNode(block, row);
          return (
            <tr key={`${block.id}-del-${index}-${rowIndex}`} className="bg-rose-500/10">
              {row.children.map((cell, cellIndex) =>
                renderTableCellWithOverlay(cell, null, `${block.id}-del-cell-${index}-${rowIndex}-${cellIndex}`, cellIndex === 0 ? unit : null, selectedLineId, onSelectLine, onApplyLineDecision)
              )}
            </tr>
          );
        })
      );
      continue;
    }

    bodyRows.push(
      ...part.value.map((row, rowIndex) => {
        const unit = resolveUnitForNode(block, row);
        return (
          <tr key={`${block.id}-ins-${index}-${rowIndex}`} className="bg-emerald-500/10">
            {row.children.map((cell, cellIndex) =>
              renderTableCellWithOverlay(null, cell, `${block.id}-ins-cell-${index}-${rowIndex}-${cellIndex}`, cellIndex === 0 ? unit : null, selectedLineId, onSelectLine, onApplyLineDecision)
            )}
          </tr>
        );
      })
    );
  }

  return (
    <div data-testid="diff-review-unit" data-review-unit="table" className="min-w-0 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {header ? (
          <thead>
            <tr>
              {header.children.map((cell, cellIndex) => (
                <th key={`${block.id}-head-${cellIndex}`} className="border border-theme-border/20 px-2 py-1 text-left font-semibold">
                  {renderInlineFromNodes((cell.children || []) as PhrasingContent[], (cell.children || []) as PhrasingContent[], `${block.id}-head-cell-${cellIndex}`)}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>{bodyRows}</tbody>
      </table>
    </div>
  );
}

function renderBlockUnit(
  block: DiffBlock,
  selectedLineId: string | null,
  onSelectLine?: (lineId: string) => void,
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>
) {
  const unit = block.reviewUnits[0];
  if (!unit) return renderBlockContent(block);

  return (
    <ReviewAnchor
      unit={unit}
      selectedLineId={selectedLineId}
      onSelectLine={onSelectLine}
      onApplyLineDecision={onApplyLineDecision}
      controlsClassName="right-0 top-0"
      className="min-w-0"
    >
      {renderBlockContent(block)}
    </ReviewAnchor>
  );
}

function renderBlockCards(
  block: DiffBlock,
  selectedLineId: string | null,
  onSelectLine?: (lineId: string) => void,
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>
) {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'blockquote':
    case 'unknown':
    case 'blank':
      return renderLineUnitsBlock(block, selectedLineId, onSelectLine, onApplyLineDecision);
    case 'list':
    case 'task_list':
      return renderListBlockUnits(block, selectedLineId, onSelectLine, onApplyLineDecision);
    case 'code':
    case 'mermaid':
      return renderCodeBlockUnits(block, selectedLineId, onSelectLine, onApplyLineDecision);
    case 'table':
      return renderTableBlockUnits(block, selectedLineId, onSelectLine, onApplyLineDecision);
    default:
      return renderBlockUnit(block, selectedLineId, onSelectLine, onApplyLineDecision);
  }
}

export function DiffBlockCard({
  block,
  selectedLineId,
  onSelectLine,
  onApplyLineDecision,
}: {
  block: DiffBlock;
  selectedLineId: string | null;
  onSelectLine?: (lineId: string) => void;
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>;
}) {
  return <>{renderBlockCards(block, selectedLineId, onSelectLine, onApplyLineDecision)}</>;
}
