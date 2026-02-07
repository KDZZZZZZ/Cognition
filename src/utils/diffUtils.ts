import DiffMatchPatch from 'diff-match-patch';
import type { JSONContent } from '@tiptap/core';

// Diff operation types from diff-match-patch
export const DIFF_DELETE = -1;
export const DIFF_INSERT = 1;
export const DIFF_EQUAL = 0;

export type DiffOperation = typeof DIFF_DELETE | typeof DIFF_INSERT | typeof DIFF_EQUAL;
export type DiffTuple = [DiffOperation, string];

export interface DiffResult {
  diffs: DiffTuple[];
  html: string;
  tiptapContent: JSONContent;
}

const dmp = new DiffMatchPatch();

/**
 * Compute character-level diff between two strings
 */
export function computeDiff(oldText: string, newText: string): DiffTuple[] {
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);
  return diffs as DiffTuple[];
}

/**
 * Convert diff results to HTML with styled spans
 */
export function diffToHtml(diffs: DiffTuple[]): string {
  const parts: string[] = [];

  for (const [op, text] of diffs) {
    const escapedText = escapeHtml(text);

    switch (op) {
      case DIFF_DELETE:
        parts.push(`<span class="diff-deletion" data-diff-type="deletion">${escapedText}</span>`);
        break;
      case DIFF_INSERT:
        parts.push(`<span class="diff-addition" data-diff-type="addition">${escapedText}</span>`);
        break;
      case DIFF_EQUAL:
      default:
        parts.push(escapedText);
        break;
    }
  }

  return parts.join('');
}

/**
 * Convert diff results to TipTap JSON content
 */
export function diffToTiptapContent(diffs: DiffTuple[]): JSONContent {
  const content: JSONContent[] = [];

  for (const [op, text] of diffs) {
    if (!text) continue;

    const marks: { type: string }[] = [];

    if (op === DIFF_DELETE) {
      marks.push({ type: 'deletion' });
    } else if (op === DIFF_INSERT) {
      marks.push({ type: 'addition' });
    }

    content.push({
      type: 'text',
      text,
      ...(marks.length > 0 ? { marks } : {}),
    });
  }

  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content,
      },
    ],
  };
}

/**
 * Parse a line to determine its Markdown block type and extract content
 * Returns the line type and the content without the Markdown syntax prefix
 */
interface ParsedLine {
  type: 'heading' | 'code' | 'blockquote' | 'listItem' | 'paragraph' | 'codeFence';
  level?: number; // For headings (1-6)
  prefix: string; // The Markdown syntax prefix (e.g., "### ", "> ", "- ")
  content: string; // Content without the Markdown syntax prefix
  isEmpty: boolean;
  language?: string; // For code fences
}

// Regex patterns for Markdown syntax
const PATTERNS = {
  codeFence: /^```(\w*)\s*$/, // ```language
  heading: /^(#{1,6})\s+(.+)$/, // # Header
  blockquote: /^>\s*(.*)$/, // > quote
  unorderedList: /^[-*+]\s+(.*)$/, // - item
  orderedList: /^\d+\.\s+(.*)$/, // 1. item
  empty: /^\s*$/,
} as const;

function parseMarkdownLine(line: string): ParsedLine {
  const trimmed = line; // Don't trim - preserve original line

  // Empty line
  if (PATTERNS.empty.test(line)) {
    return { type: 'paragraph', prefix: '', content: '', isEmpty: true };
  }

  // Code fence (``` or ```language)
  const codeFenceMatch = trimmed.match(PATTERNS.codeFence);
  if (codeFenceMatch) {
    return {
      type: 'codeFence',
      prefix: '```',
      content: codeFenceMatch[1], // language
      isEmpty: false,
      language: codeFenceMatch[1] || undefined,
    };
  }

  // Heading (# ### etc.)
  const headingMatch = trimmed.match(PATTERNS.heading);
  if (headingMatch) {
    const prefix = headingMatch[1] + ' ';
    return {
      type: 'heading',
      level: headingMatch[1].length,
      prefix,
      content: headingMatch[2],
      isEmpty: false,
    };
  }

  // Blockquote (> ...)
  const quoteMatch = trimmed.match(PATTERNS.blockquote);
  if (quoteMatch) {
    return {
      type: 'blockquote',
      prefix: '> ',
      content: quoteMatch[1],
      isEmpty: false,
    };
  }

  // Unordered list item (-, *, +)
  const listItemMatch = trimmed.match(PATTERNS.unorderedList);
  if (listItemMatch) {
    return {
      type: 'listItem',
      prefix: listItemMatch[0].slice(0, 2), // "- " or "* " or "+ "
      content: listItemMatch[1],
      isEmpty: false,
    };
  }

  // Ordered list item (1., 2., etc.)
  const orderedListItemMatch = trimmed.match(PATTERNS.orderedList);
  if (orderedListItemMatch) {
    return {
      type: 'listItem',
      prefix: orderedListItemMatch[0].match(/^\d+\.\s/)?.[0] || '',
      content: orderedListItemMatch[1],
      isEmpty: false,
    };
  }

  // Default: paragraph (no prefix)
  return { type: 'paragraph', prefix: '', content: trimmed, isEmpty: false };
}

/**
 * Create a TipTap node from a parsed line with diff marks
 */
function createNodeFromParsedLine(
  parsed: ParsedLine,
  textContent: JSONContent[]
): JSONContent {
  // Filter out empty text nodes - TipTap doesn't allow empty text nodes
  const nonEmptyContent = textContent.filter(c => c.type !== 'text' || c.text !== '');

  // If no content left and it's an empty line, we can skip it entirely
  // or represent it as a hard break if needed
  if ((nonEmptyContent.length === 0 && parsed.isEmpty) || nonEmptyContent.length === 0) {
    // For empty lines, return a paragraph with a zero-width space or just skip
    // We'll skip it to avoid empty nodes
    return {
      type: 'paragraph',
      content: [{ type: 'text', text: '\u200B' }], // Zero-width space
    };
  }

  switch (parsed.type) {
    case 'heading':
      return {
        type: 'heading',
        attrs: { level: parsed.level || 1 },
        content: nonEmptyContent,
      };

    case 'codeFence':
      // Code fences should show the prefix with content
      return {
        type: 'codeBlock',
        attrs: parsed.language ? { language: parsed.language } : undefined,
        content: nonEmptyContent,
      };

    case 'blockquote':
      return {
        type: 'blockquote',
        content: [
          {
            type: 'paragraph',
            content: nonEmptyContent,
          },
        ],
      };

    case 'listItem':
      return {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              {
                type: 'paragraph',
                content: nonEmptyContent,
              },
            ],
          },
        ],
      };

    case 'paragraph':
    default:
      return {
        type: 'paragraph',
        content: nonEmptyContent,
      };
  }
}

/**
 * Apply diff marks to text content based on character-level diff
 */
function applyCharDiffToText(
  oldText: string,
  newText: string
): JSONContent[] {
  const diffs = computeDiff(oldText, newText);
  const content: JSONContent[] = [];

  for (const [op, text] of diffs) {
    if (!text) continue;

    const marks: { type: string }[] = [];
    if (op === DIFF_DELETE) {
      marks.push({ type: 'deletion' });
    } else if (op === DIFF_INSERT) {
      marks.push({ type: 'addition' });
    }

    content.push({
      type: 'text',
      text,
      ...(marks.length > 0 ? { marks } : {}),
    });
  }

  // Return at least a zero-width space to avoid empty text nodes
  return content.length > 0 ? content : [{ type: 'text', text: '\u200B' }];
}

/**
 * Convert diff results to TipTap content preserving Markdown block types
 *
 * This function:
 * 1. Performs line-level diff to identify added/removed/modified lines
 * 2. Parses each line to detect Markdown block type (heading, list, code, etc.)
 * 3. For modified lines, performs character-level diff on the content only
 * 4. Creates appropriate TipTap nodes with diff marks (addition/deletion)
 */
export function diffToTiptapContentPreservingBlocks(
  oldText: string,
  newText: string
): JSONContent {
  // Handle empty old content case
  if (!oldText || oldText.trim() === '') {
    // All content is new - mark everything as addition
    const newLines = newText.split('\n');
    const blocks: JSONContent[] = [];

    for (const line of newLines) {
      const parsed = parseMarkdownLine(line);

      if (parsed.type === 'codeFence') {
        // Skip fence markers themselves
        continue;
      }

      // Skip truly empty lines
      if (parsed.isEmpty) {
        continue;
      }

      const content = [{
        type: 'text',
        text: parsed.content || '\u200B', // Use zero-width space if empty
        marks: [{ type: 'addition' }],
      }];

      blocks.push(createNodeFromParsedLine(parsed, content));
    }

    return {
      type: 'doc',
      content: blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [{ type: 'text', text: 'No content' }] }],
    };
  }

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Use line-level diff first
  const lineDiffs = computeLineDiff(oldLines, newLines);

  const blocks: JSONContent[] = [];
  let inCodeBlock = false;
  let codeBlockLanguage = '';
  const codeBlockLines: string[] = [];

  const flushCodeBlock = () => {
    if (inCodeBlock && codeBlockLines.length > 0) {
      // Join code block lines with newlines and create a single text node
      const codeText = codeBlockLines.join('\n');
      blocks.push({
        type: 'codeBlock',
        attrs: codeBlockLanguage ? { language: codeBlockLanguage } : undefined,
        content: [{ type: 'text', text: codeText }],
      });
    }
    codeBlockLines.length = 0;
    inCodeBlock = false;
    codeBlockLanguage = '';
  };

  for (const lineDiff of lineDiffs) {
    const line = lineDiff.text || lineDiff.newText || '';

    // Handle code fences specially
    const parsed = parseMarkdownLine(line);

    if (parsed.type === 'codeFence') {
      if (!inCodeBlock) {
        // Starting a code block
        flushCodeBlock();
        inCodeBlock = true;
        codeBlockLanguage = parsed.language || '';
        continue;
      } else {
        // Ending a code block
        flushCodeBlock();
        continue;
      }
    }

    if (inCodeBlock) {
      // Inside a code block - just accumulate the lines
      // Don't apply diff marks inside code blocks
      const textToUse = lineDiff.type === 'modify' ? (lineDiff.newText || '') : line;
      codeBlockLines.push(textToUse);
      continue;
    }

    // Process regular lines outside code blocks
    let content: JSONContent[];

    if (lineDiff.type === 'equal') {
      // Unchanged line - create text node with the content
      content = [{ type: 'text', text: parsed.content }];
    } else if (lineDiff.type === 'delete') {
      // Deleted line - mark entire content as deletion
      content = [{
        type: 'text',
        text: parsed.content,
        marks: [{ type: 'deletion' }],
      }];
    } else if (lineDiff.type === 'insert') {
      // Inserted line - mark entire content as addition
      content = [{
        type: 'text',
        text: parsed.content,
        marks: [{ type: 'addition' }],
      }];
    } else if (lineDiff.type === 'modify') {
      // Modified line - compute character-level diff on content only
      const oldParsed = parseMarkdownLine(lineDiff.oldText || '');
      const newParsed = parseMarkdownLine(lineDiff.newText || '');

      // Use character-level diff on the content (without prefix)
      content = applyCharDiffToText(oldParsed.content, newParsed.content);
    } else {
      // Fallback - should never happen with proper LineDiffResult typing
      content = [{ type: 'text', text: '' }];
    }

    // Create the appropriate block node based on line type
    if (content.length > 0 || parsed.isEmpty) {
      blocks.push(createNodeFromParsedLine(parsed, content));
    }
  }

  // Flush any remaining code block
  flushCodeBlock();

  return {
    type: 'doc',
    content: blocks.length > 0 ? blocks : [{ type: 'paragraph' }],
  };
}

interface LineDiffResult {
  type: 'equal' | 'delete' | 'insert' | 'modify';
  text: string;
  oldText?: string;
  newText?: string;
}

/**
 * Compute line-level diff with support for modifications
 */
function computeLineDiff(oldLines: string[], newLines: string[]): LineDiffResult[] {
  const results: LineDiffResult[] = [];

  // Use LCS algorithm
  const lcs = computeLCS(oldLines, newLines);

  let oldIdx = 0;
  let newIdx = 0;

  for (const match of lcs) {
    // Process deletions before this match
    while (oldIdx < match.oldIdx) {
      // Check if there's a corresponding insertion (modification)
      if (newIdx < match.newIdx) {
        results.push({
          type: 'modify',
          text: '',
          oldText: oldLines[oldIdx],
          newText: newLines[newIdx],
        });
        oldIdx++;
        newIdx++;
      } else {
        results.push({
          type: 'delete',
          text: oldLines[oldIdx],
        });
        oldIdx++;
      }
    }

    // Process insertions before this match
    while (newIdx < match.newIdx) {
      results.push({
        type: 'insert',
        text: newLines[newIdx],
      });
      newIdx++;
    }

    // Process matching line
    results.push({
      type: 'equal',
      text: oldLines[oldIdx],
    });
    oldIdx++;
    newIdx++;
  }

  // Process remaining deletions
  while (oldIdx < oldLines.length) {
    if (newIdx < newLines.length) {
      results.push({
        type: 'modify',
        text: '',
        oldText: oldLines[oldIdx],
        newText: newLines[newIdx],
      });
      oldIdx++;
      newIdx++;
    } else {
      results.push({
        type: 'delete',
        text: oldLines[oldIdx],
      });
      oldIdx++;
    }
  }

  // Process remaining insertions
  while (newIdx < newLines.length) {
    results.push({
      type: 'insert',
      text: newLines[newIdx],
    });
    newIdx++;
  }

  return results;
}

interface LCSMatch {
  oldIdx: number;
  newIdx: number;
}

function computeLCS(oldLines: string[], newLines: string[]): LCSMatch[] {
  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const matches: LCSMatch[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      matches.unshift({ oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return matches;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/\n/g, '<br/>');
}

/**
 * Compute full diff result with all formats
 */
export function computeFullDiff(oldText: string, newText: string): DiffResult {
  const diffs = computeDiff(oldText, newText);
  return {
    diffs,
    html: diffToHtml(diffs),
    tiptapContent: diffToTiptapContentPreservingBlocks(oldText, newText),
  };
}

/**
 * Apply accepted changes - removes marks and keeps/removes text accordingly
 */
export function applyAcceptedChanges(content: JSONContent): JSONContent {
  if (!content.content) return content;

  const processContent = (nodes: JSONContent[]): JSONContent[] => {
    return nodes
      .map((node) => {
        if (node.type === 'text') {
          const hasDeletion = node.marks?.some((m) => m.type === 'deletion');
          // If it's a deletion, remove the text entirely
          if (hasDeletion) {
            return null;
          }
          // Otherwise, remove all diff marks
          return {
            ...node,
            marks: node.marks?.filter((m) => m.type !== 'addition' && m.type !== 'deletion'),
          };
        }

        if (node.content) {
          return {
            ...node,
            content: processContent(node.content).filter(Boolean) as JSONContent[],
          };
        }

        return node;
      })
      .filter(Boolean) as JSONContent[];
  };

  return {
    ...content,
    content: processContent(content.content),
  };
}

/**
 * Apply rejected changes - removes marks and reverts to old content
 */
export function applyRejectedChanges(content: JSONContent): JSONContent {
  if (!content.content) return content;

  const processContent = (nodes: JSONContent[]): JSONContent[] => {
    return nodes
      .map((node) => {
        if (node.type === 'text') {
          const hasAddition = node.marks?.some((m) => m.type === 'addition');
          // If it's an addition, remove the text entirely
          if (hasAddition) {
            return null;
          }
          // Otherwise, remove all diff marks
          return {
            ...node,
            marks: node.marks?.filter((m) => m.type !== 'addition' && m.type !== 'deletion'),
          };
        }

        if (node.content) {
          return {
            ...node,
            content: processContent(node.content).filter(Boolean) as JSONContent[],
          };
        }

        return node;
      })
      .filter(Boolean) as JSONContent[];
  };

  return {
    ...content,
    content: processContent(content.content),
  };
}
