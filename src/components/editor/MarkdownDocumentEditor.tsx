import { useEffect, useMemo, useRef, useState } from 'react';
import type { DiffEventDTO } from '../../types';
import { MarkdownContent } from '../ui/MarkdownContent';
import { RawMarkdownEditor } from './RawMarkdownEditor';
import { TiptapMarkdownEditor } from './TiptapMarkdownEditor';
import { buildRowsFromContents } from './diffRows';
import { buildDiffBlocks } from './diffMarkdown/buildBlocks';
import { DiffBlockCard } from './diffMarkdown/renderBlocks';
import {
  type MarkdownDiffUnit,
  buildMarkdownDiffUnits,
  parseMarkdownDocument,
  replaceMarkdownBlock,
  supportsStructuredBlockEditor,
} from './markdownDocument';
import { renderMathMarkdown, stripMathDelimiters } from './markdownNormalization';

function calloutTone(kind: string) {
  if (kind === 'warning' || kind === 'caution') return 'border-amber-500/30 bg-amber-500/10 text-amber-900';
  if (kind === 'danger' || kind === 'error') return 'border-rose-500/30 bg-rose-500/10 text-rose-900';
  if (kind === 'tip' || kind === 'success') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900';
  return 'border-sky-500/30 bg-sky-500/8 text-theme-text';
}

interface MarkdownDocumentEditorProps {
  fileId: string;
  fileName: string;
  content: string;
  baseContent: string;
  pendingDiffEvent?: DiffEventDTO | null;
  pendingDiffLoading?: boolean;
  onChange: (markdown: string) => void;
  onViewportChange?: (payload: {
    scrollTop: number;
    scrollHeight: number;
    visibleUnit: 'line';
    visibleStart: number;
    visibleEnd: number;
  }) => void;
  availableSessions?: { id: string; name: string }[];
  defaultSessionId?: string;
  sourceFile?: { id: string; name: string };
  onAddReferenceToSession?: (
    sessionId: string,
    reference: {
      sourceFileId: string;
      sourceFileName: string;
      markdown: string;
      plainText: string;
    }
  ) => void;
  onRunSelectionAction?: (params: {
    action: 'fix' | 'check';
    targetSessionId: string;
    markdown: string;
    plainText: string;
    sourceFileId: string;
    sourceFileName: string;
  }) => Promise<void> | void;
}

function normalizeTableRow(line: string) {
  const raw = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return raw.split('|').map((cell) => cell.trim());
}

function canParseTaskList(markdown: string) {
  const lines = markdown.split('\n').filter((line) => line.trim().length > 0);
  return lines.every((line) => /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line));
}

function parseTaskList(markdown: string) {
  return markdown
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
      if (!match) return null;
      return {
        indent: match[1] || '',
        checked: match[2].toLowerCase() === 'x',
        text: match[3],
      };
    });
}

function serializeTaskList(items: Array<{ indent: string; checked: boolean; text: string }>) {
  return items.map((item) => `${item.indent}- [${item.checked ? 'x' : ' '}] ${item.text}`).join('\n');
}

function parseFrontmatter(markdown: string) {
  const match = markdown.match(/^(---|\+\+\+)\s*\n([\s\S]*?)\n\1\s*$/);
  if (!match) return null;
  return {
    delimiter: match[1],
    entries: match[2]
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const separator = line.indexOf(':');
        return {
          key: line.slice(0, separator).trim(),
          value: line.slice(separator + 1).trim(),
        };
      }),
  };
}

function serializeFrontmatter(delimiter: string, entries: Array<{ key: string; value: string }>) {
  return `${delimiter}\n${entries.map((entry) => `${entry.key}: ${entry.value}`).join('\n')}\n${delimiter}`;
}

function parseCallout(markdown: string) {
  const lines = markdown.split('\n');
  const first = lines[0]?.match(/^\s*>\s*\[!(\w+)\](?:\s+(.*))?\s*$/);
  if (!first) return null;
  const body = lines
    .slice(1)
    .map((line) => {
      const match = line.match(/^\s*>\s?(.*)$/);
      return match ? match[1] : line;
    })
    .join('\n')
    .trim();
  return {
    kind: first[1].toLowerCase(),
    title: first[2]?.trim() || '',
    body,
  };
}

function serializeCallout(kind: string, title: string, body: string) {
  const header = `> [!${kind.toUpperCase()}]${title.trim() ? ` ${title.trim()}` : ''}`;
  const bodyLines = body
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
    .trim();
  return bodyLines ? `${header}\n${bodyLines}` : header;
}

function parseCodeFence(markdown: string) {
  const match = markdown.match(/^(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\1\s*$/);
  if (!match) return null;
  return {
    fence: match[1],
    language: match[2].trim(),
    code: match[3],
  };
}

function serializeCodeFence(fence: string, language: string, code: string) {
  return `${fence}${language.trim() ? language.trim() : ''}\n${code}\n${fence}`;
}

function canParseTable(markdown: string) {
  const lines = markdown.split('\n').filter((line) => line.trim().length > 0);
  return lines.length >= 2 && /\|/.test(lines[0]) && /^[:|\-\s]+$/.test(lines[1].replace(/[A-Za-z0-9]/g, ''));
}

function parseTable(markdown: string) {
  const lines = markdown.split('\n').filter((line) => line.trim().length > 0);
  if (!canParseTable(markdown) || lines.length < 2) return null;
  return {
    header: normalizeTableRow(lines[0]),
    rows: lines.slice(2).map(normalizeTableRow),
  };
}

function serializeTable(header: string[], rows: string[][]) {
  const headerRow = `| ${header.join(' | ')} |`;
  const separator = `| ${header.map(() => '---').join(' | ')} |`;
  const bodyRows = rows.map((row) => `| ${row.join(' | ')} |`);
  return [headerRow, separator, ...bodyRows].join('\n');
}

function normalizeIndentWidth(indent: string) {
  return indent.replace(/\t/g, '  ').length;
}

function indentSpaces(count: number) {
  return ' '.repeat(Math.max(0, count));
}

function isKeyboardEventComposing(event: React.KeyboardEvent<HTMLElement>) {
  const nativeEvent = event.nativeEvent as KeyboardEvent & { keyCode?: number };
  return Boolean(nativeEvent.isComposing || nativeEvent.keyCode === 229);
}

function canParseList(markdown: string) {
  const lines = markdown.split('\n').filter((line) => line.trim().length > 0);
  return lines.length > 0 && lines.every((line) => /^(\s*)([-*+]|\d+[.)])\s+/.test(line));
}

function parseList(markdown: string) {
  return markdown
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const match = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (!match) return null;
      return {
        indent: normalizeIndentWidth(match[1] || ''),
        ordered: /^\d/.test(match[2]),
        text: match[3],
      };
    });
}

function serializeList(items: Array<{ indent: number; ordered: boolean; text: string }>) {
  const counters = new Map<number, number>();
  return items
    .map((item) => {
      if (item.ordered) {
        const nextCount = (counters.get(item.indent) || 0) + 1;
        counters.set(item.indent, nextCount);
        return `${indentSpaces(item.indent)}${nextCount}. ${item.text}`;
      }
      return `${indentSpaces(item.indent)}- ${item.text}`;
    })
    .join('\n');
}

function listMarkerLabel(items: Array<{ indent: number; ordered: boolean }>, targetIndex: number) {
  if (!items[targetIndex]?.ordered) return '•';
  let count = 0;
  for (let index = 0; index <= targetIndex; index += 1) {
    if (items[index]?.ordered && items[index]?.indent === items[targetIndex].indent) {
      count += 1;
    }
  }
  return `${count}.`;
}

function parseImage(markdown: string) {
  const trimmed = markdown.trim();
  const match = trimmed.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
  if (!match) return null;
  return {
    alt: match[1] || '',
    src: match[2] || '',
    title: match[3] || '',
  };
}

function serializeImage(image: { alt: string; src: string; title: string }) {
  const title = image.title.trim();
  return `![${image.alt}](${image.src}${title ? ` "${title}"` : ''})`;
}

function parseHeading(markdown: string) {
  const match = markdown.match(/^(#{1,6})\s+(.*)$/);
  if (!match) return null;
  return {
    level: match[1].length,
    text: match[2],
  };
}

function serializeHeading(level: number, text: string) {
  const safeLevel = Math.max(1, Math.min(6, level));
  return `${'#'.repeat(safeLevel)} ${text}`;
}

function parseFootnote(markdown: string) {
  const lines = markdown.split('\n');
  const first = lines[0]?.match(/^\[\^([^\]]+)\]:\s*(.*)$/);
  if (!first) return null;
  const body = [first[2], ...lines.slice(1).map((line) => line.replace(/^\s{2,4}/, ''))].join('\n').trim();
  return {
    identifier: first[1],
    body,
  };
}

function serializeFootnote(identifier: string, body: string) {
  const [firstLine = '', ...rest] = body.split('\n');
  const nextLines = rest.map((line) => `  ${line}`).join('\n');
  return nextLines ? `[^${identifier}]: ${firstLine}\n${nextLines}` : `[^${identifier}]: ${firstLine}`;
}

function SourcePreviewBlockEditor({
  markdown,
  onChange,
  notice,
}: {
  markdown: string;
  onChange: (nextMarkdown: string) => void;
  notice: string;
}) {
  return (
    <div className="space-y-3">
      {notice ? <div className="text-[11px] text-theme-text/46">{notice}</div> : null}
      <div className="min-h-[200px] overflow-hidden rounded-lg border border-theme-border/16 bg-theme-bg/70">
        <RawMarkdownEditor content={markdown} onChange={onChange} className="px-4 py-4 text-[13px] leading-6" />
      </div>
      <div className="min-h-[160px] overflow-auto rounded-lg border border-theme-border/14 bg-theme-surface/10 px-4 py-3">
        <MarkdownContent content={markdown} className="[&_p]:my-2 [&_pre]:my-2" />
      </div>
    </div>
  );
}

function InlineRichBlockEditor(props: {
  markdown: string;
  onChange: (markdown: string) => void;
  onViewportChange?: MarkdownDocumentEditorProps['onViewportChange'];
  availableSessions?: MarkdownDocumentEditorProps['availableSessions'];
  defaultSessionId?: string;
  sourceFile?: { id: string; name: string };
  onAddReferenceToSession?: MarkdownDocumentEditorProps['onAddReferenceToSession'];
  onRunSelectionAction?: MarkdownDocumentEditorProps['onRunSelectionAction'];
}) {
  return (
    <div className="overflow-hidden bg-transparent">
      <TiptapMarkdownEditor
        content={props.markdown}
        onChange={props.onChange}
        onViewportChange={props.onViewportChange}
        availableSessions={props.availableSessions}
        defaultSessionId={props.defaultSessionId}
        sourceFile={props.sourceFile}
        onAddReferenceToSession={props.onAddReferenceToSession}
        onRunSelectionAction={props.onRunSelectionAction}
        chrome="inline"
        autofocus
      />
    </div>
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findReferencedFootnoteDefinitions(markdown: string, fullDocumentContent: string) {
  const labels = Array.from(markdown.matchAll(/\[\^([^\]]+)\]/g), (match) => match[1])
    .filter((label, index, values) => values.indexOf(label) === index)
    .filter((label) => !new RegExp(`^\\[\\^${escapeRegExp(label)}\\]:`, 'm').test(markdown));

  if (labels.length === 0) return [];

  const lines = fullDocumentContent.split('\n');

  return labels
    .map((label) => {
      const definitionPattern = new RegExp(`^\\[\\^${escapeRegExp(label)}\\]:\\s?.*$`);
      for (let index = 0; index < lines.length; index += 1) {
        if (!definitionPattern.test(lines[index])) continue;
        const collected = [lines[index]];
        let cursor = index + 1;
        while (cursor < lines.length) {
          const nextLine = lines[cursor];
          const nextIndented = /^(?: {2,}|\t)/.test(nextLine);
          const blankWithIndentedFollower =
            nextLine.trim().length === 0 && /^(?: {2,}|\t)/.test(lines[cursor + 1] || '');
          if (!nextIndented && !blankWithIndentedFollower) break;
          collected.push(nextLine);
          cursor += 1;
        }
        return collected.join('\n');
      }
      return null;
    })
    .filter((definition): definition is string => Boolean(definition));
}

function buildPreviewMarkdown(markdown: string, fullDocumentContent: string) {
  const definitions = findReferencedFootnoteDefinitions(markdown, fullDocumentContent);
  if (definitions.length === 0) return markdown;
  return `${markdown}\n\n${definitions.join('\n\n')}`;
}

function MarkdownDiffPreview({ unit, fullDocumentContent }: { unit: MarkdownDiffUnit; fullDocumentContent: string }) {
  const oldContent = unit.baseBlock?.markdown ?? '';
  const newContent = unit.draftBlock?.markdown ?? '';
  const diffBlocks = useMemo(() => buildDiffBlocks(buildRowsFromContents(oldContent, newContent)), [newContent, oldContent]);
  const fallbackContent = buildPreviewMarkdown(unit.draftBlock?.markdown ?? unit.baseBlock?.markdown ?? '', fullDocumentContent);

  if (diffBlocks.length === 0) {
    return (
      <MarkdownContent
        content={fallbackContent}
        className="[&_p]:my-2 [&_blockquote]:my-2 [&_pre]:my-2"
        hideFootnotesSection
      />
    );
  }

  return (
    <div className="space-y-1">
      {diffBlocks.map((block) => (
        <DiffBlockCard key={block.id} block={block} selectedLineId={null} />
      ))}
    </div>
  );
}

function MarkdownBlockSurface({
  unit,
  active,
  draftContent,
  baseContent,
  showInlineDiffDecorations,
  onSelect,
  onChangeContent,
  onViewportChange,
  availableSessions,
  defaultSessionId,
  sourceFile,
  onAddReferenceToSession,
  onRunSelectionAction,
}: {
  unit: MarkdownDiffUnit;
  active: boolean;
  draftContent: string;
  baseContent: string;
  showInlineDiffDecorations: boolean;
  onSelect: () => void;
  onChangeContent: (nextContent: string) => void;
} & Pick<
  MarkdownDocumentEditorProps,
  'onViewportChange' | 'availableSessions' | 'defaultSessionId' | 'sourceFile' | 'onAddReferenceToSession' | 'onRunSelectionAction'
>) {
  const block = unit.draftBlock;
  const previewBlock = unit.draftBlock || unit.baseBlock;
  if (!previewBlock) return null;
  const canActivate = Boolean(block);
  const previewContextContent = unit.draftBlock ? draftContent : baseContent;
  const previewMarkdown = buildPreviewMarkdown(previewBlock.markdown, previewContextContent);

  const lowChromeBlock = previewBlock.kind === 'paragraph' || previewBlock.kind === 'blockquote';
  const surfaceClassName = lowChromeBlock
    ? 'relative'
    : `relative -mx-3 rounded-xl px-3 py-2 transition-colors ${active ? 'bg-theme-text/[0.03]' : 'bg-transparent'}`;
  const previewClassName = lowChromeBlock
    ? `block w-full text-left outline-none ${canActivate ? 'cursor-text' : 'cursor-default'}`
    : `block w-full text-left outline-none ${canActivate ? 'cursor-text rounded-lg transition-colors hover:bg-theme-text/[0.03] focus:bg-theme-text/[0.03]' : 'cursor-default'}`;

  const renderEditor = () => {
    if (!block) return null;
    switch (block.kind) {
      case 'heading': {
        const parsed = parseHeading(block.markdown);
        if (!parsed) {
          return (
            <InlineRichBlockEditor
              markdown={block.markdown}
              onChange={(nextMarkdown) => {
                onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown));
              }}
              onViewportChange={onViewportChange}
              availableSessions={availableSessions}
              defaultSessionId={defaultSessionId}
              sourceFile={sourceFile}
              onAddReferenceToSession={onAddReferenceToSession}
              onRunSelectionAction={onRunSelectionAction}
            />
          );
        }
        return (
          <div className="flex items-center gap-3 py-1">
            <select
              aria-label="Heading level"
              value={parsed.level}
              onChange={(event) => {
                onChangeContent(replaceMarkdownBlock(draftContent, block, serializeHeading(Number(event.target.value), parsed.text)));
              }}
              className="rounded-md border border-theme-border/16 bg-theme-bg px-2 py-1 text-[11px] text-theme-text/62 outline-none"
            >
              {[1, 2, 3, 4, 5, 6].map((level) => (
                <option key={level} value={level}>
                  H{level}
                </option>
              ))}
            </select>
            <input
              autoFocus
              value={parsed.text}
              onChange={(event) => {
                onChangeContent(replaceMarkdownBlock(draftContent, block, serializeHeading(parsed.level, event.target.value)));
              }}
              className="min-w-0 flex-1 bg-transparent text-inherit outline-none"
            />
          </div>
        );
      }
      case 'frontmatter': {
        const parsed = parseFrontmatter(block.markdown);
        if (!parsed) {
          return (
            <SourcePreviewBlockEditor
              markdown={block.markdown}
              notice="Unknown metadata stays block-local source editable."
              onChange={(nextMarkdown) => onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown))}
            />
          );
        }
        return (
          <div className="space-y-3 py-1">
            {parsed.entries.map((entry, index) => (
              <div key={`${entry.key}-${index}`} className="grid gap-2 md:grid-cols-[minmax(0,180px),minmax(0,1fr),auto]">
                <input
                  autoFocus={index === 0}
                  value={entry.key}
                  onChange={(event) => {
                    const nextEntries = parsed.entries.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, key: event.target.value } : item
                    );
                    onChangeContent(replaceMarkdownBlock(draftContent, block, serializeFrontmatter(parsed.delimiter, nextEntries)));
                  }}
                  className="rounded-md border border-transparent bg-theme-surface/8 px-2 py-1.5 text-sm outline-none focus:border-theme-border/20 focus:bg-theme-bg"
                />
                <input
                  value={entry.value}
                  onChange={(event) => {
                    const nextEntries = parsed.entries.map((item, itemIndex) =>
                      itemIndex === index ? { ...item, value: event.target.value } : item
                    );
                    onChangeContent(replaceMarkdownBlock(draftContent, block, serializeFrontmatter(parsed.delimiter, nextEntries)));
                  }}
                  className="rounded-md border border-transparent bg-theme-surface/8 px-2 py-1.5 text-sm outline-none focus:border-theme-border/20 focus:bg-theme-bg"
                />
                <button
                  type="button"
                  onClick={() => {
                    const nextEntries = parsed.entries.filter((_, itemIndex) => itemIndex !== index);
                    onChangeContent(replaceMarkdownBlock(draftContent, block, serializeFrontmatter(parsed.delimiter, nextEntries)));
                  }}
                  className="rounded px-2 py-1 text-[11px] text-theme-text/48 hover:bg-theme-text/8"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                const nextEntries = [...parsed.entries, { key: 'key', value: 'value' }];
                onChangeContent(replaceMarkdownBlock(draftContent, block, serializeFrontmatter(parsed.delimiter, nextEntries)));
              }}
              className="rounded px-2 py-1 text-[11px] text-theme-text/48 hover:bg-theme-text/8"
            >
              + Field
            </button>
          </div>
        );
      }
      case 'list': {
        if (!canParseList(block.markdown)) {
          return (
            <InlineRichBlockEditor
              markdown={block.markdown}
              onChange={(nextMarkdown) => {
                onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown));
              }}
              onViewportChange={onViewportChange}
              availableSessions={availableSessions}
              defaultSessionId={defaultSessionId}
              sourceFile={sourceFile}
              onAddReferenceToSession={onAddReferenceToSession}
              onRunSelectionAction={onRunSelectionAction}
            />
          );
        }
        const parsed = parseList(block.markdown).filter(Boolean) as Array<{ indent: number; ordered: boolean; text: string }>;
        const commit = (nextItems: Array<{ indent: number; ordered: boolean; text: string }>) => {
          onChangeContent(replaceMarkdownBlock(draftContent, block, serializeList(nextItems)));
        };
        return (
          <div className="space-y-1 py-1">
            {parsed.map((item, index) => (
              <div key={`${index}-${item.text}`} className="group flex items-center gap-2">
                <button
                  type="button"
                  aria-label={item.ordered ? 'Switch to bullet list item' : 'Switch to numbered list item'}
                  onClick={() => {
                    const nextItems = parsed.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, ordered: !entry.ordered } : entry
                    );
                    commit(nextItems);
                  }}
                  className="min-w-[2rem] shrink-0 rounded px-1 text-sm text-theme-text/58 hover:bg-theme-text/8"
                  style={{ marginLeft: `${item.indent * 0.55}rem` }}
                >
                  {listMarkerLabel(parsed, index)}
                </button>
                <input
                  autoFocus={index === 0}
                  value={item.text}
                  onChange={(event) => {
                    const nextItems = parsed.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, text: event.target.value } : entry
                    );
                    commit(nextItems);
                  }}
                  onKeyDown={(event) => {
                    if (isKeyboardEventComposing(event)) return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      const nextItems = [...parsed];
                      nextItems.splice(index + 1, 0, { indent: item.indent, ordered: item.ordered, text: '' });
                      commit(nextItems);
                    }
                    if (event.key === 'Tab') {
                      event.preventDefault();
                      const nextItems = parsed.map((entry, entryIndex) =>
                        entryIndex === index
                          ? { ...entry, indent: Math.max(0, entry.indent + (event.shiftKey ? -2 : 2)) }
                          : entry
                      );
                      commit(nextItems);
                    }
                    if (event.key === 'Backspace' && item.text.length === 0) {
                      event.preventDefault();
                      const nextItems = parsed.filter((_, itemIndex) => itemIndex !== index);
                      commit(nextItems.length > 0 ? nextItems : [{ indent: 0, ordered: false, text: '' }]);
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent py-1 text-inherit outline-none"
                />
              </div>
            ))}
          </div>
        );
      }
      case 'task_list': {
        if (!canParseTaskList(block.markdown)) {
          return (
            <SourcePreviewBlockEditor
              markdown={block.markdown}
              notice="Complex task lists stay block-local source editable."
              onChange={(nextMarkdown) => onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown))}
            />
          );
        }
        const parsed = parseTaskList(block.markdown).filter(Boolean) as Array<{ indent: string; checked: boolean; text: string }>;
        const commit = (nextItems: Array<{ indent: string; checked: boolean; text: string }>) => {
          onChangeContent(replaceMarkdownBlock(draftContent, block, serializeTaskList(nextItems)));
        };
        return (
          <div className="space-y-1 py-1">
            {parsed.map((item, index) => (
              <div key={`${index}-${item.text}`} className="group flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={item.checked}
                  onChange={(event) => {
                    const nextItems = parsed.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, checked: event.target.checked } : entry
                    );
                    commit(nextItems);
                  }}
                  className="size-4 shrink-0"
                  style={{ marginLeft: `${normalizeIndentWidth(item.indent) * 0.55}rem` }}
                />
                <input
                  autoFocus={index === 0}
                  value={item.text}
                  onChange={(event) => {
                    const nextItems = parsed.map((entry, entryIndex) =>
                      entryIndex === index ? { ...entry, text: event.target.value } : entry
                    );
                    commit(nextItems);
                  }}
                  onKeyDown={(event) => {
                    if (isKeyboardEventComposing(event)) return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      const nextItems = [...parsed];
                      nextItems.splice(index + 1, 0, { indent: item.indent, checked: false, text: '' });
                      commit(nextItems);
                    }
                    if (event.key === 'Tab') {
                      event.preventDefault();
                      const nextItems = parsed.map((entry, entryIndex) =>
                        entryIndex === index
                          ? {
                              ...entry,
                              indent: indentSpaces(Math.max(0, normalizeIndentWidth(entry.indent) + (event.shiftKey ? -2 : 2))),
                            }
                          : entry
                      );
                      commit(nextItems);
                    }
                    if (event.key === 'Backspace' && item.text.length === 0) {
                      event.preventDefault();
                      const nextItems = parsed.filter((_, itemIndex) => itemIndex !== index);
                      commit(nextItems.length > 0 ? nextItems : [{ indent: '', checked: false, text: '' }]);
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent py-1 text-inherit outline-none"
                />
                <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    type="button"
                    aria-label="Insert task item below"
                    onClick={() => {
                      const nextItems = [...parsed];
                      nextItems.splice(index + 1, 0, { indent: item.indent, checked: false, text: '' });
                      commit(nextItems);
                    }}
                    className="rounded px-1 text-[11px] text-theme-text/45 hover:bg-theme-text/8"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    aria-label="Remove task item"
                    onClick={() => {
                      const nextItems = parsed.filter((_, itemIndex) => itemIndex !== index);
                      commit(nextItems.length > 0 ? nextItems : [{ indent: '', checked: false, text: '' }]);
                    }}
                    className="rounded px-1 text-[11px] text-theme-text/45 hover:bg-theme-text/8"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        );
      }
      case 'thematic_break':
        return (
          <div className="group flex items-center gap-3 py-2">
            <hr className="flex-1 border-0 border-t border-dashed border-theme-border/35" />
            <button
              type="button"
              aria-label="Remove divider"
              onClick={() => {
                onChangeContent(replaceMarkdownBlock(draftContent, block, ''));
              }}
              className="rounded px-1 text-[11px] text-theme-text/45 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-theme-text/8"
            >
              ×
            </button>
          </div>
        );
      case 'image': {
        const parsed = parseImage(block.markdown);
        if (!parsed) {
          return (
            <SourcePreviewBlockEditor
              markdown={block.markdown}
              notice="Complex image syntax stays block-local source editable."
              onChange={(nextMarkdown) => onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown))}
            />
          );
        }
        return (
          <div className="space-y-3 py-1">
            {parsed.src ? (
              <img
                src={parsed.src}
                alt={parsed.alt}
                className="mx-auto block max-h-[420px] max-w-full rounded-xl border border-theme-border/16 bg-theme-surface/8 object-contain"
              />
            ) : (
              <div className="rounded-xl border border-dashed border-theme-border/24 px-4 py-10 text-center text-sm text-theme-text/42">
                Missing image source
              </div>
            )}
            <div className="grid gap-2 md:grid-cols-3">
              <input
                autoFocus
                value={parsed.src}
                onChange={(event) => {
                  onChangeContent(replaceMarkdownBlock(draftContent, block, serializeImage({ ...parsed, src: event.target.value })));
                }}
                placeholder="Image URL"
                className="rounded-md border border-transparent bg-theme-surface/8 px-2 py-1.5 text-sm outline-none focus:border-theme-border/20 focus:bg-theme-bg"
              />
              <input
                value={parsed.alt}
                onChange={(event) => {
                  onChangeContent(replaceMarkdownBlock(draftContent, block, serializeImage({ ...parsed, alt: event.target.value })));
                }}
                placeholder="Alt text"
                className="rounded-md border border-transparent bg-theme-surface/8 px-2 py-1.5 text-sm outline-none focus:border-theme-border/20 focus:bg-theme-bg"
              />
              <input
                value={parsed.title}
                onChange={(event) => {
                  onChangeContent(replaceMarkdownBlock(draftContent, block, serializeImage({ ...parsed, title: event.target.value })));
                }}
                placeholder="Caption"
                className="rounded-md border border-transparent bg-theme-surface/8 px-2 py-1.5 text-sm outline-none focus:border-theme-border/20 focus:bg-theme-bg"
              />
            </div>
          </div>
        );
      }
      case 'table': {
        const parsed = parseTable(block.markdown);
        if (!parsed) {
          return (
            <SourcePreviewBlockEditor
              markdown={block.markdown}
              notice="Complex tables stay block-local source editable."
              onChange={(nextMarkdown) => onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown))}
            />
          );
        }
        return (
          <div className="space-y-3 py-1">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    {parsed.header.map((cell, cellIndex) => (
                      <th key={`head-${cellIndex}`} className="border border-theme-border/20 p-1 align-top">
                        <div className="flex items-start gap-1">
                          <input
                            value={cell}
                            onChange={(event) => {
                              const nextHeader = parsed.header.map((value, index) => (index === cellIndex ? event.target.value : value));
                              onChangeContent(replaceMarkdownBlock(draftContent, block, serializeTable(nextHeader, parsed.rows)));
                            }}
                            className="w-full rounded border border-transparent bg-transparent px-2 py-1 outline-none focus:border-theme-border/20 focus:bg-theme-bg"
                          />
                          <button
                            type="button"
                            aria-label={`Remove column ${cellIndex + 1}`}
                            disabled={parsed.header.length <= 1}
                            onClick={() => {
                              if (parsed.header.length <= 1) return;
                              const nextHeader = parsed.header.filter((_, index) => index !== cellIndex);
                              const nextRows = parsed.rows.map((row) => row.filter((_, index) => index !== cellIndex));
                              onChangeContent(replaceMarkdownBlock(draftContent, block, serializeTable(nextHeader, nextRows)));
                            }}
                            className="rounded px-1 text-[11px] text-theme-text/42 hover:bg-theme-text/8 disabled:cursor-not-allowed disabled:opacity-25"
                          >
                            ×
                          </button>
                        </div>
                      </th>
                    ))}
                    <th className="w-10 border border-theme-border/20 p-1 text-[10px] font-medium text-theme-text/35">
                      Row
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.map((row, rowIndex) => (
                    <tr key={`row-${rowIndex}`}>
                      {row.map((cell, cellIndex) => (
                        <td key={`cell-${rowIndex}-${cellIndex}`} className="border border-theme-border/20 p-1">
                          <input
                            value={cell}
                            onChange={(event) => {
                              const nextRows = parsed.rows.map((currentRow, currentRowIndex) =>
                                currentRowIndex === rowIndex
                                  ? currentRow.map((value, currentCellIndex) => (currentCellIndex === cellIndex ? event.target.value : value))
                                  : currentRow
                              );
                              onChangeContent(replaceMarkdownBlock(draftContent, block, serializeTable(parsed.header, nextRows)));
                            }}
                            className="w-full rounded border border-transparent bg-transparent px-2 py-1 outline-none focus:border-theme-border/20 focus:bg-theme-bg"
                          />
                        </td>
                      ))}
                      <td className="border border-theme-border/20 p-1 text-center">
                        <button
                          type="button"
                          aria-label={`Remove row ${rowIndex + 1}`}
                          onClick={() => {
                            const nextRows = parsed.rows.filter((_, index) => index !== rowIndex);
                            onChangeContent(replaceMarkdownBlock(draftContent, block, serializeTable(parsed.header, nextRows)));
                          }}
                          className="rounded px-1 text-[11px] text-theme-text/42 hover:bg-theme-text/8"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-theme-text/48">
              <button
                type="button"
                onClick={() => {
                  const width = Math.max(1, parsed.header.length);
                  const nextRows = [...parsed.rows, Array.from({ length: width }, () => '')];
                  onChangeContent(replaceMarkdownBlock(draftContent, block, serializeTable(parsed.header, nextRows)));
                }}
                className="rounded px-2 py-1 hover:bg-theme-text/8"
              >
                + Row
              </button>
              <button
                type="button"
                onClick={() => {
                  const nextHeader = [...parsed.header, ''];
                  const nextRows = parsed.rows.map((row) => [...row, '']);
                  onChangeContent(replaceMarkdownBlock(draftContent, block, serializeTable(nextHeader, nextRows)));
                }}
                className="rounded px-2 py-1 hover:bg-theme-text/8"
              >
                + Column
              </button>
              <button
                type="button"
                disabled={parsed.rows.length === 0}
                onClick={() => {
                  const nextRows = parsed.rows.slice(0, -1);
                  onChangeContent(replaceMarkdownBlock(draftContent, block, serializeTable(parsed.header, nextRows)));
                }}
                className="rounded px-2 py-1 hover:bg-theme-text/8 disabled:cursor-not-allowed disabled:opacity-25"
              >
                - Row
              </button>
              <button
                type="button"
                disabled={parsed.header.length <= 1}
                onClick={() => {
                  if (parsed.header.length <= 1) return;
                  const nextHeader = parsed.header.slice(0, -1);
                  const nextRows = parsed.rows.map((row) => row.slice(0, -1));
                  onChangeContent(replaceMarkdownBlock(draftContent, block, serializeTable(nextHeader, nextRows)));
                }}
                className="rounded px-2 py-1 hover:bg-theme-text/8 disabled:cursor-not-allowed disabled:opacity-25"
              >
                - Column
              </button>
            </div>
          </div>
        );
      }
      case 'callout': {
        const parsed = parseCallout(block.markdown);
        if (!parsed) {
          return (
            <SourcePreviewBlockEditor
              markdown={block.markdown}
              notice="Unknown callout syntax stays block-local source editable."
              onChange={(nextMarkdown) => onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown))}
            />
          );
        }
        return (
          <div className={`rounded-xl border px-3 py-3 ${calloutTone(parsed.kind)}`}>
            <div className="mb-3 grid gap-2 md:grid-cols-[130px,minmax(0,1fr)]">
              <select
                value={parsed.kind}
                onChange={(event) => {
                  onChangeContent(replaceMarkdownBlock(draftContent, block, serializeCallout(event.target.value, parsed.title, parsed.body)));
                }}
                className="rounded-md border border-transparent bg-white/40 px-2 py-1.5 text-sm outline-none focus:border-current/15"
              >
                {['note', 'tip', 'warning', 'danger', 'success'].map((kind) => (
                  <option key={kind} value={kind}>
                    {kind.toUpperCase()}
                  </option>
                ))}
              </select>
              <input
                autoFocus
                value={parsed.title}
                onChange={(event) => {
                  onChangeContent(replaceMarkdownBlock(draftContent, block, serializeCallout(parsed.kind, event.target.value, parsed.body)));
                }}
                placeholder="Callout title"
                className="rounded-md border border-transparent bg-white/40 px-2 py-1.5 text-sm outline-none focus:border-current/15"
              />
            </div>
            <InlineRichBlockEditor
              markdown={parsed.body}
              onChange={(nextBody) => {
                onChangeContent(replaceMarkdownBlock(draftContent, block, serializeCallout(parsed.kind, parsed.title, nextBody)));
              }}
              onViewportChange={onViewportChange}
              availableSessions={availableSessions}
              defaultSessionId={defaultSessionId}
              sourceFile={sourceFile}
              onAddReferenceToSession={onAddReferenceToSession}
              onRunSelectionAction={onRunSelectionAction}
            />
          </div>
        );
      }
      case 'code': {
        const parsed = parseCodeFence(block.markdown);
        if (!parsed) {
          return (
            <SourcePreviewBlockEditor
              markdown={block.markdown}
              notice="Unsupported fenced block syntax stays block-local source editable."
              onChange={(nextMarkdown) => onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown))}
            />
          );
        }
        if (parsed.language.trim().toLowerCase() === 'mermaid') {
          return (
            <SourcePreviewBlockEditor
              markdown={block.markdown}
              notice="Mermaid stays block-local source editable."
              onChange={(nextMarkdown) => onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown))}
            />
          );
        }
        return (
          <div className="space-y-2 py-1">
            <input
              autoFocus
              value={parsed.language}
              onChange={(event) => {
                onChangeContent(replaceMarkdownBlock(draftContent, block, serializeCodeFence(parsed.fence, event.target.value, parsed.code)));
              }}
              placeholder="Language"
              className="w-[180px] rounded-md border border-transparent bg-theme-surface/8 px-2 py-1.5 text-[12px] outline-none focus:border-theme-border/20 focus:bg-theme-bg"
            />
            <textarea
              value={parsed.code}
              onChange={(event) => {
                onChangeContent(replaceMarkdownBlock(draftContent, block, serializeCodeFence(parsed.fence, parsed.language, event.target.value)));
              }}
              spellCheck={false}
              className="min-h-[220px] w-full rounded-xl border border-theme-border/16 bg-theme-surface/10 px-3 py-3 font-mono text-[13px] leading-6 outline-none"
            />
          </div>
        );
      }
      case 'math': {
        const formula = stripMathDelimiters(block.markdown);
        return (
          <div className="space-y-3 py-1">
            <div className="rounded-xl border border-theme-border/16 bg-theme-bg px-4 py-4">
              <textarea
                data-testid="math-formula-input"
                autoFocus
                value={formula}
                onChange={(event) => {
                  onChangeContent(replaceMarkdownBlock(draftContent, block, renderMathMarkdown(event.target.value, true)));
                }}
                spellCheck={false}
                className="min-h-[180px] w-full rounded border border-theme-border/22 bg-theme-bg px-3 py-2 font-mono text-[13px] leading-6 outline-none"
              />
            </div>
            <div className="min-h-[120px] overflow-auto rounded-xl border border-theme-border/16 bg-theme-surface/10 px-4 py-4">
              <MarkdownContent content={block.markdown} />
            </div>
          </div>
        );
      }
      case 'footnote': {
        const parsed = parseFootnote(block.markdown);
        if (!parsed) {
          return (
            <SourcePreviewBlockEditor
              markdown={block.markdown}
              notice="Complex footnotes stay block-local source editable."
              onChange={(nextMarkdown) => onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown))}
            />
          );
        }
        return (
          <div className="space-y-3 py-1">
            <input
              autoFocus
              value={parsed.identifier}
              onChange={(event) => {
                const nextIdentifier = event.target.value;
                const updatedContent = draftContent.split(`[^${parsed.identifier}]`).join(`[^${nextIdentifier}]`);
                onChangeContent(replaceMarkdownBlock(updatedContent, parseMarkdownDocument(updatedContent).blocks.find((item) => item.id === block.id) || block, serializeFootnote(nextIdentifier, parsed.body)));
              }}
              className="w-full rounded-md border border-transparent bg-theme-surface/8 px-2 py-1.5 text-sm outline-none focus:border-theme-border/20 focus:bg-theme-bg"
            />
            <InlineRichBlockEditor
              markdown={parsed.body}
              onChange={(nextBody) => {
                onChangeContent(replaceMarkdownBlock(draftContent, block, serializeFootnote(parsed.identifier, nextBody)));
              }}
              onViewportChange={onViewportChange}
              availableSessions={availableSessions}
              defaultSessionId={defaultSessionId}
              sourceFile={sourceFile}
              onAddReferenceToSession={onAddReferenceToSession}
              onRunSelectionAction={onRunSelectionAction}
            />
          </div>
        );
      }
      case 'html':
      case 'unknown':
        return (
          <SourcePreviewBlockEditor
            markdown={block.markdown}
            notice="This block stays source editable in place."
            onChange={(nextMarkdown) => onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown))}
          />
        );
      default:
        return (
          <InlineRichBlockEditor
            markdown={block.markdown}
            onChange={(nextMarkdown) => {
              onChangeContent(replaceMarkdownBlock(draftContent, block, nextMarkdown));
            }}
            onViewportChange={onViewportChange}
            availableSessions={availableSessions}
            defaultSessionId={defaultSessionId}
            sourceFile={sourceFile}
            onAddReferenceToSession={onAddReferenceToSession}
            onRunSelectionAction={onRunSelectionAction}
          />
        );
    }
  };

  const handleActivate = () => {
    if (!canActivate) return;
    onSelect();
  };

  const handleActivateKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!canActivate) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect();
  };

  return (
    <div
      data-block-kind={previewBlock.kind}
      data-block-status={unit.status}
      className={surfaceClassName}
    >
      {active ? renderEditor() : (
        <div
          role={canActivate ? 'button' : undefined}
          tabIndex={canActivate ? 0 : undefined}
          onClick={canActivate ? handleActivate : undefined}
          onKeyDown={canActivate ? handleActivateKeyDown : undefined}
          className={previewClassName}
        >
          {showInlineDiffDecorations && unit.status !== 'equal' ? (
            <MarkdownDiffPreview unit={unit} fullDocumentContent={previewContextContent} />
          ) : (
            <MarkdownContent
              content={previewMarkdown}
              className="[&_p]:my-2 [&_blockquote]:my-2 [&_pre]:my-2"
              hideFootnotesSection
            />
          )}
        </div>
      )}
    </div>
  );
}

export function MarkdownDocumentEditor({
  fileId,
  fileName,
  content,
  baseContent,
  pendingDiffEvent: _pendingDiffEvent = null,
  pendingDiffLoading: _pendingDiffLoading = false,
  onChange,
  onViewportChange,
  availableSessions = [],
  defaultSessionId,
  sourceFile,
  onAddReferenceToSession,
  onRunSelectionAction,
}: MarkdownDocumentEditorProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const hasPendingDiff = Boolean(_pendingDiffEvent);

  const parsedDraft = useMemo(() => parseMarkdownDocument(content), [content]);
  const diffUnits = useMemo(() => buildMarkdownDiffUnits(baseContent, content), [baseContent, content]);
  const useStructuredEditor = useMemo(
    () => hasPendingDiff || supportsStructuredBlockEditor(content || baseContent),
    [baseContent, content, hasPendingDiff]
  );
  const visibleUnitCount = useMemo(() => diffUnits.filter((unit) => unit.draftBlock).length, [diffUnits]);

  useEffect(() => {
    if (!activeBlockId) return;
    if (!parsedDraft.blocks.some((block) => block.id === activeBlockId)) {
      setActiveBlockId(null);
    }
  }, [activeBlockId, parsedDraft.blocks]);

  useEffect(() => {
    if (!activeBlockId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveBlockId(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeBlockId]);

  useEffect(() => {
    if (!wrapperRef.current || !onViewportChange) return;
    const wrapper = wrapperRef.current;
    const emitViewport = () => {
      const scrollTop = wrapper.scrollTop || 0;
      const scrollHeight = Math.max(wrapper.scrollHeight, wrapper.clientHeight, 1);
      const totalLines = Math.max(1, content.split('\n').length);
      const maxScrollable = Math.max(1, scrollHeight - wrapper.clientHeight);
      const startRatio = Math.max(0, Math.min(1, scrollTop / maxScrollable));
      const visibleRatio = Math.max(0.02, Math.min(1, wrapper.clientHeight / scrollHeight));
      const visibleStart = Math.max(1, Math.floor(startRatio * totalLines));
      const visibleEnd = Math.min(totalLines, visibleStart + Math.max(1, Math.ceil(visibleRatio * totalLines)));
      onViewportChange({
        scrollTop,
        scrollHeight,
        visibleUnit: 'line',
        visibleStart,
        visibleEnd,
      });
    };

    emitViewport();
    wrapper.addEventListener('scroll', emitViewport, { passive: true });
    window.addEventListener('resize', emitViewport);
    return () => {
      wrapper.removeEventListener('scroll', emitViewport);
      window.removeEventListener('resize', emitViewport);
    };
  }, [content, onViewportChange]);

  const sourceDescriptor = sourceFile || { id: fileId, name: fileName };

  return (
    <div className="flex h-full min-h-0 min-w-0 bg-theme-bg">
      <section className="min-w-0 flex-1 bg-theme-bg">
        <div
          ref={wrapperRef}
          className="h-full min-h-0 overflow-auto px-4 py-4"
          data-testid="markdown-document-scroll"
        >
          {useStructuredEditor ? (
            <div data-testid="markdown-block-editor" className="flex flex-col gap-0 pb-8">
              {diffUnits.map((unit) => (
                <MarkdownBlockSurface
                  key={unit.id}
                  unit={unit}
                  active={unit.draftBlock?.id === activeBlockId}
                  draftContent={content}
                  baseContent={baseContent}
                  showInlineDiffDecorations={hasPendingDiff}
                  onSelect={() => {
                    setActiveBlockId((current) => (current === unit.draftBlock?.id ? null : unit.draftBlock?.id || null));
                  }}
                  onChangeContent={onChange}
                  onViewportChange={onViewportChange}
                  availableSessions={availableSessions}
                  defaultSessionId={defaultSessionId}
                  sourceFile={sourceDescriptor}
                  onAddReferenceToSession={onAddReferenceToSession}
                  onRunSelectionAction={onRunSelectionAction}
                />
              ))}
              {visibleUnitCount === 0 ? (
                <div className="px-1 py-6 text-center text-theme-text/45">
                  Click anywhere to start editing.
                </div>
              ) : null}
            </div>
          ) : (
            <div className="h-full min-h-[320px] bg-theme-bg" data-testid="markdown-rich-editor">
              <TiptapMarkdownEditor
                content={content}
                onChange={onChange}
                onViewportChange={onViewportChange}
                availableSessions={availableSessions}
                defaultSessionId={defaultSessionId}
                sourceFile={sourceDescriptor}
                onAddReferenceToSession={onAddReferenceToSession}
                onRunSelectionAction={onRunSelectionAction}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
