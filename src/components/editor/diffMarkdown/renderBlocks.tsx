import { Fragment, type ReactNode } from 'react';
import { diffArrays, diffChars } from 'diff';
import { Check, X } from 'lucide-react';
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
import { renderKatexToHtml, markdownCodeBlockClassName, diffInlineDeleteClassName, diffInlineInsertClassName, diffStructuralClassName } from '../../ui/markdownShared';
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

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMath(value: string, displayMode: boolean, key: string, className = '') {
  const html = renderKatexToHtml(value, displayMode);
  if (!html) {
    return <span key={key} className="text-red-600">{value}</span>;
  }
  const Tag = displayMode ? 'div' : 'span';
  return <Tag key={key} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
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
    return (
      <span key={key} data-diff-op={op === 'equal' ? undefined : op} className={stateClass}>
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
    return (
      <figure key={key} data-diff-op={op === 'equal' ? undefined : op} className={`my-2 inline-flex flex-col gap-1 rounded-md border border-theme-border/20 p-2 align-middle ${stateClass}`}>
        <img src={token.url} alt={token.alt || ''} className="max-h-40 max-w-full rounded object-contain" />
        {token.alt ? <figcaption className="text-[11px] text-theme-text/55">{token.alt}</figcaption> : null}
      </figure>
    );
  }

  if (token.kind === 'html') {
    return (
      <code key={key} data-diff-op={op === 'equal' ? undefined : op} className={`rounded-sm px-1 py-0.5 text-[0.92em] ${stateClass || 'bg-theme-text/8 text-theme-text'}`}>
        {token.value}
      </code>
    );
  }

  if (token.kind === 'break') {
    return <br key={key} />;
  }

  return null;
}

function tokenizeInline(nodes: PhrasingContent[] = []): InlineToken[] {
  return nodes.flatMap((node): InlineToken[] => {
    switch (node.type) {
      case 'text':
        return node.value ? [{ kind: 'text', value: node.value }] : [];
      case 'strong':
        return [{ kind: 'strong', children: tokenizeInline(node.children as PhrasingContent[]) }];
      case 'emphasis':
        return [{ kind: 'emphasis', children: tokenizeInline(node.children as PhrasingContent[]) }];
      case 'delete':
        return [{ kind: 'delete', children: tokenizeInline(node.children as PhrasingContent[]) }];
      case 'link':
        return [
          {
            kind: 'link',
            url: node.url,
            title: node.title || undefined,
            children: tokenizeInline(node.children as PhrasingContent[]),
          },
        ];
      case 'image':
        return [{ kind: 'image', url: node.url, title: node.title || undefined, alt: node.alt || undefined }];
      case 'inlineCode':
        return [{ kind: 'inlineCode', value: node.value }];
      case 'inlineMath':
        return [{ kind: 'inlineMath', value: node.value }];
      case 'footnoteReference':
        return [{ kind: 'footnoteReference', identifier: node.identifier }];
      case 'html':
        return [{ kind: 'html', value: node.value }];
      case 'break':
        return [{ kind: 'break' }];
      default:
        return [{ kind: 'text', value: toString(node as any) }];
    }
  });
}

function tokenPlainText(token: InlineToken): string {
  if (token.kind === 'text') return token.value || '';
  if (token.kind === 'image') return token.alt || '';
  if (token.kind === 'inlineCode' || token.kind === 'inlineMath' || token.kind === 'html') return token.value || '';
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
  return diffChars(oldValue, newValue).map((part, index) => {
    if (!part.value) return null;
    if (part.added) {
      return (
        <span key={`${keyPrefix}-a-${index}`} data-diff-op="insert" className={diffInlineInsertClassName}>
          {part.value}
        </span>
      );
    }
    if (part.removed) {
      return (
        <del key={`${keyPrefix}-r-${index}`} data-diff-op="delete" className={diffInlineDeleteClassName}>
          {part.value}
        </del>
      );
    }
    return <Fragment key={`${keyPrefix}-e-${index}`}>{part.value}</Fragment>;
  });
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
    const linkClass =
      op === 'insert'
        ? diffInlineInsertClassName
        : op === 'delete'
          ? diffInlineDeleteClassName
          : op === 'structural'
            ? diffStructuralClassName
            : '';
    return (
      <a key={key} data-diff-op={op === 'equal' ? undefined : op} href={token.url} title={token.title || undefined} className={`underline underline-offset-2 ${linkClass}`}>
        {(token.children || []).map((child, index) => renderInlineToken(child, `${key}-${index}`, op))}
      </a>
    );
  }

  return renderInlineAtom(token, key, op);
}

function renderInlineDiff(oldTokens: InlineToken[], newTokens: InlineToken[], keyPrefix: string): ReactNode[] {
  const parts = diffArrays<InlineToken>(oldTokens, newTokens, {
    comparator: (left, right) => tokenSignature(left) === tokenSignature(right),
  });
  const nodes: ReactNode[] = [];

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
            nodes.push(renderInlineToken(oldToken, `${keyPrefix}-old-${index}-${offset}`, 'delete'));
            nodes.push(renderInlineToken(newToken, `${keyPrefix}-new-${index}-${offset}`, 'insert'));
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
  if (kind === 'warning' || kind === 'caution') return 'border-amber-500/35 bg-amber-500/8 text-amber-900';
  if (kind === 'danger' || kind === 'error') return 'border-rose-500/35 bg-rose-500/8 text-rose-900';
  if (kind === 'tip' || kind === 'success') return 'border-emerald-500/35 bg-emerald-500/8 text-emerald-900';
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
    <blockquote key={key} className="my-0 border-l-2 border-theme-border/30 pl-3 text-theme-text/78">
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
          <tr key={`${key}-rm-${index}-${rowIndex}`} className="bg-rose-500/12">
            {row.children.map((cell, cellIndex) => renderTableCell(cell, null, `${key}-rm-cell-${index}-${rowIndex}-${cellIndex}`))}
          </tr>
        );
      }
      for (const [rowIndex, row] of added.slice(shared).entries()) {
        bodyRows.push(
          <tr key={`${key}-ad-${index}-${rowIndex}`} className="bg-emerald-500/12">
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
          <tr key={`${key}-del-${index}-${rowIndex}`} className="bg-rose-500/12">
            {row.children.map((cell, cellIndex) => renderTableCell(cell, null, `${key}-del-cell-${index}-${rowIndex}-${cellIndex}`))}
          </tr>
        ))
      );
      continue;
    }

    bodyRows.push(
      ...part.value.map((row, rowIndex) => (
        <tr key={`${key}-ins-${index}-${rowIndex}`} className="bg-emerald-500/12">
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
            <div className="bg-rose-500/12 px-3 py-0.5 line-through decoration-rose-700/80">{removed[offset] || ' '}</div>
            <div className="bg-emerald-500/12 px-3 py-0.5">{added[offset] || ' '}</div>
          </div>
        );
      }
      for (const [lineIndex, line] of removed.slice(shared).entries()) {
        rows.push(<div key={`${key}-rm-${index}-${lineIndex}`} className="bg-rose-500/12 px-3 py-0.5 line-through decoration-rose-700/80">{line || ' '}</div>);
      }
      for (const [lineIndex, line] of added.slice(shared).entries()) {
        rows.push(<div key={`${key}-ad-${index}-${lineIndex}`} className="bg-emerald-500/12 px-3 py-0.5">{line || ' '}</div>);
      }
      index += 1;
      continue;
    }
    if (part.removed) {
      rows.push(...part.value.map((line, lineIndex) => <div key={`${key}-del-${index}-${lineIndex}`} className="bg-rose-500/12 px-3 py-0.5 line-through decoration-rose-700/80">{line || ' '}</div>));
      continue;
    }
    rows.push(...part.value.map((line, lineIndex) => <div key={`${key}-ins-${index}-${lineIndex}`} className="bg-emerald-500/12 px-3 py-0.5">{line || ' '}</div>));
  }

  return (
    <div key={key} className={`${markdownCodeBlockClassName} bg-theme-bg/78`}>
      {langLabel ? <div className="border-b border-theme-border/12 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-theme-text/45">{langLabel}</div> : null}
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
      <div key={key} className="flex flex-col gap-2">
        <pre data-diff-op="delete" className={`${markdownCodeBlockClassName} ${diffInlineDeleteClassName} my-0 text-xs`}>{oldValue}</pre>
        <pre data-diff-op="insert" className={`${markdownCodeBlockClassName} ${diffInlineInsertClassName} my-0 text-xs`}>{newValue}</pre>
      </div>
    );
  }
  return <pre key={key} className={`${markdownCodeBlockClassName} my-0 text-xs`}>{newValue || oldValue}</pre>;
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
    <section key={key} className="rounded-md border border-theme-border/18 bg-theme-surface/36 px-3 py-2">
      <div className="mb-2 text-[10px] uppercase tracking-[0.16em] text-theme-text/45">
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
      <div key={key} className={`flex flex-col gap-2 ${diffStructuralClassName}`}>
        <div className="rounded-md bg-rose-500/10 p-2">{renderBlockNode(oldNode, null, `${key}-old`)}</div>
        <div className="rounded-md bg-emerald-500/10 p-2">{renderBlockNode(null, newNode, `${key}-new`)}</div>
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
        className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-800 transition-colors hover:bg-emerald-500/16"
        aria-label={`Accept ${subject}`}
      >
        <Check size={11} />
      </button>
      <button
        type="button"
        onClick={() => void onApplyLineDecision(target, 'rejected')}
        className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-500/10 text-rose-800 transition-colors hover:bg-rose-500/16"
        aria-label={`Reject ${subject}`}
      >
        <X size={11} />
      </button>
    </div>
  );
}

function UnitCardShell({
  unit,
  selectedLineId,
  onSelectLine,
  controls,
  children,
}: {
  unit: ReviewUnit;
  selectedLineId: string | null;
  onSelectLine?: (lineId: string) => void;
  controls?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border px-2.5 py-2 transition-colors ${
        unitIsSelected(unit, selectedLineId)
          ? 'border-theme-border/26 bg-theme-text/[0.045]'
          : 'border-theme-border/10 bg-theme-surface/28'
      }`}
      data-testid="diff-block-card"
      data-review-unit={unit.kind}
      onMouseEnter={() => {
        const firstLineId = unit.lineIds[0];
        if (firstLineId) onSelectLine?.(firstLineId);
      }}
    >
      <div className="min-w-0 rounded-lg border border-theme-border/10 bg-theme-bg/78 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        {controls ? <div className="mb-2 flex items-center justify-between gap-3">{controls}</div> : null}
        <div className="min-w-0 text-sm leading-6 [&_.katex-display]:my-0.5 [&_blockquote]:my-0 [&_code]:whitespace-pre-wrap [&_ol]:my-0 [&_p]:my-0 [&_pre]:my-0 [&_ul]:my-0">
          {children}
        </div>
      </div>
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

function renderUnitSummary(unit: ReviewUnit) {
  const lineNumber = unitFirstLineNumber(unit);
  if (unit.kind === 'block') {
    return <span className="text-[11px] uppercase tracking-[0.14em] text-theme-text/45">{unit.label || 'Block review'}</span>;
  }
  return (
    <span className="text-[11px] uppercase tracking-[0.14em] text-theme-text/45">
      {unit.kind === 'item' ? unit.label || 'Item' : `Line ${lineNumber ?? ''}`.trim()}
    </span>
  );
}

function renderLineUnit(unit: ReviewUnit, block: DiffBlock) {
  if (block.kind === 'heading' || block.kind === 'paragraph') {
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

function renderItemUnit(unit: ReviewUnit) {
  const oldRoot = parseMarkdownRoot(contentFromRows(unit.rows, 'old'));
  const newRoot = parseMarkdownRoot(contentFromRows(unit.rows, 'new'));
  const oldList = primaryNode(oldRoot) as List | null;
  const newList = primaryNode(newRoot) as List | null;
  const oldItem = oldList?.type === 'list' ? (oldList.children[0] as ListItem | undefined) || null : null;
  const newItem = newList?.type === 'list' ? (newList.children[0] as ListItem | undefined) || null : null;
  const ordered = Boolean(newList?.ordered ?? oldList?.ordered);
  const Tag = ordered ? 'ol' : 'ul';

  return <Tag className={`${ordered ? 'list-decimal' : 'list-disc'} pl-5`}>{renderListItem(oldItem, newItem, unit.id)}</Tag>;
}

function renderLineUnitsBlock(
  block: DiffBlock,
  selectedLineId: string | null,
  onSelectLine?: (lineId: string) => void,
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>
) {
  return block.reviewUnits.map((unit) => (
    <UnitCardShell
      key={unit.id}
      unit={unit}
      selectedLineId={selectedLineId}
      onSelectLine={onSelectLine}
      controls={
        <>
          {renderUnitSummary(unit)}
          <DecisionButtons unit={unit} onApplyLineDecision={onApplyLineDecision} />
        </>
      }
    >
      {renderLineUnit(unit, block)}
    </UnitCardShell>
  ));
}

function renderItemUnitsBlock(
  block: DiffBlock,
  selectedLineId: string | null,
  onSelectLine?: (lineId: string) => void,
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>
) {
  return block.reviewUnits.map((unit) => (
    <UnitCardShell
      key={unit.id}
      unit={unit}
      selectedLineId={selectedLineId}
      onSelectLine={onSelectLine}
      controls={
        <>
          {renderUnitSummary(unit)}
          <DecisionButtons unit={unit} onApplyLineDecision={onApplyLineDecision} />
        </>
      }
    >
      {renderItemUnit(unit)}
    </UnitCardShell>
  ));
}

function renderStructuredBlockCard(
  block: DiffBlock,
  selectedLineId: string | null,
  onSelectLine: ((lineId: string) => void) | undefined,
  onApplyLineDecision: ((lineId: string | string[], decision: ReviewDecision) => void | Promise<void>) | undefined,
  content: ReactNode,
  extraControls?: ReactNode
) {
  const blockUnit = block.reviewUnits[0];

  return (
    <UnitCardShell
      unit={blockUnit}
      selectedLineId={selectedLineId}
      onSelectLine={onSelectLine}
      controls={
        <>
          <div className="flex items-center gap-3">
            {renderUnitSummary(blockUnit)}
            {extraControls}
          </div>
          <DecisionButtons unit={blockUnit} onApplyLineDecision={onApplyLineDecision} />
        </>
      }
    >
      {content}
    </UnitCardShell>
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
  const langLabel = firstFence?.[2]?.trim() || '';
  const startIndex = firstFence && block.rows[0]?.status === 'equal' ? 1 : 0;
  const endIndex =
    lastFence && block.rows[block.rows.length - 1]?.status === 'equal'
      ? block.rows.length - 1
      : block.rows.length;
  const codeRows = block.rows.slice(startIndex, endIndex);
  const unitByLineId = new Map(block.reviewUnits.flatMap((unit) => unit.lineIds.map((lineId) => [lineId, unit] as const)));

  return (
    <UnitCardShell
      unit={block.reviewUnits[0]}
      selectedLineId={selectedLineId}
      onSelectLine={onSelectLine}
      controls={
        <>
          <div className="flex items-center gap-3">
            <span className="text-[11px] uppercase tracking-[0.14em] text-theme-text/45">{langLabel || 'Code block'}</span>
            <span className="text-[11px] text-theme-text/35">{block.reviewUnits.length} changed line{block.reviewUnits.length === 1 ? '' : 's'}</span>
          </div>
          <span className="text-[11px] text-theme-text/35">Review each changed code line below</span>
        </>
      }
    >
      <div className={`${markdownCodeBlockClassName} bg-theme-bg/78`}>
        {langLabel ? <div className="border-b border-theme-border/12 px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-theme-text/45">{langLabel}</div> : null}
        <pre className="m-0 overflow-x-auto bg-transparent py-2 text-xs text-theme-text">
          <code>
            {codeRows.map((row, index) => {
              const unit = row.id ? unitByLineId.get(row.id) : null;
              const lineNumber = row.newLineNumber ?? row.oldLineNumber ?? row.reviewLineNumber;
              return (
                <div
                  key={`${block.id}-code-row-${index}`}
                  className={`grid grid-cols-[3rem_auto_minmax(0,1fr)] items-start gap-2 px-2 py-0.5 ${unit && unitIsSelected(unit, selectedLineId) ? 'bg-theme-text/6' : ''}`}
                  onMouseEnter={() => {
                    const firstLineId = unit?.lineIds[0];
                    if (firstLineId) onSelectLine?.(firstLineId);
                  }}
                >
                  <span className="select-none text-[10px] leading-5 text-theme-text/30">{lineNumber}</span>
                  <div className="pt-0.5">
                    {unit ? <DecisionButtons unit={unit} onApplyLineDecision={onApplyLineDecision} /> : <span className="block h-5 w-5" />}
                  </div>
                  <div className="min-w-0">
                    {row.status === 'modify' ? (
                      <div className="grid grid-cols-2 gap-px">
                        <div className="bg-rose-500/12 px-2 py-0.5 line-through decoration-rose-700/80">{row.oldText || ' '}</div>
                        <div className="bg-emerald-500/12 px-2 py-0.5">{row.newText || ' '}</div>
                      </div>
                    ) : row.status === 'remove' ? (
                      <div className="bg-rose-500/12 px-2 py-0.5 line-through decoration-rose-700/80">{row.oldText || ' '}</div>
                    ) : row.status === 'add' ? (
                      <div className="bg-emerald-500/12 px-2 py-0.5">{row.newText || ' '}</div>
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
    </UnitCardShell>
  );
}

function renderTableBlockUnits(
  block: DiffBlock,
  selectedLineId: string | null,
  onSelectLine?: (lineId: string) => void,
  onApplyLineDecision?: (lineId: string | string[], decision: ReviewDecision) => void | Promise<void>
) {
  return (
    <UnitCardShell
      unit={block.reviewUnits[0]}
      selectedLineId={selectedLineId}
      onSelectLine={onSelectLine}
      controls={
        <>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-theme-text/45">
            <span>Table</span>
            <span className="normal-case tracking-normal text-theme-text/35">{block.reviewUnits.length} changed row{block.reviewUnits.length === 1 ? '' : 's'}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {block.reviewUnits.map((unit) => (
              <div
                key={unit.id}
                className={`flex items-center gap-1 rounded-md border border-theme-border/14 px-1.5 py-0.5 ${unitIsSelected(unit, selectedLineId) ? 'bg-theme-text/6' : 'bg-theme-bg/55'}`}
                onMouseEnter={() => {
                  const firstLineId = unit.lineIds[0];
                  if (firstLineId) onSelectLine?.(firstLineId);
                }}
              >
                <span className="text-[10px] text-theme-text/35">{unit.label || `Row ${unitFirstLineNumber(unit) ?? ''}`}</span>
                <DecisionButtons unit={unit} onApplyLineDecision={onApplyLineDecision} />
              </div>
            ))}
          </div>
        </>
      }
    >
      {renderBlockContent(block)}
    </UnitCardShell>
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
    case 'unknown':
    case 'blank':
      return renderLineUnitsBlock(block, selectedLineId, onSelectLine, onApplyLineDecision);
    case 'list':
    case 'task_list':
      return renderItemUnitsBlock(block, selectedLineId, onSelectLine, onApplyLineDecision);
    case 'code':
    case 'mermaid':
      return renderCodeBlockUnits(block, selectedLineId, onSelectLine, onApplyLineDecision);
    case 'table':
      return renderTableBlockUnits(block, selectedLineId, onSelectLine, onApplyLineDecision);
    default:
      return renderStructuredBlockCard(block, selectedLineId, onSelectLine, onApplyLineDecision, renderBlockContent(block));
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
