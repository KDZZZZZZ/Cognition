import { diffArrays, diffChars } from 'diff';

function longestRun(value: string, marker: string) {
  let longest = 0;
  let current = 0;

  for (const char of value) {
    if (char === marker) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }

  return longest;
}

function wrapInsertedSegment(text: string) {
  if (!text) return '';

  const fence = '`'.repeat(Math.max(1, longestRun(text, '`') + 1));
  const needsPadding = text.startsWith('`') || text.endsWith('`');
  const inner = needsPadding ? ` ${text} ` : text;
  return `${fence}${inner}${fence}`;
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function canUseMarkdownStrikethrough(text: string) {
  return text.length > 0 && !/[\n<>`$]/.test(text);
}

function wrapRemovedSegment(text: string) {
  if (!text) return '';
  if (canUseMarkdownStrikethrough(text)) {
    return `~~${text.replace(/~/g, '\\~')}~~`;
  }
  return `<del>${escapeHtml(text)}</del>`;
}

const MATH_TOKEN_PATTERN = /\$\$[\s\S]*?\$\$|(?<!\$)\$[^$\n]+?\$/g;

function tokenizeDiffMarkdown(text: string) {
  const tokens: string[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MATH_TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      tokens.push(text.slice(lastIndex, start));
    }
    tokens.push(match[0]);
    lastIndex = start + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }

  return tokens.filter((token) => token.length > 0);
}

function isMathToken(token: string) {
  return /^(\$\$[\s\S]*\$\$|(?<!\$)\$[^$\n]+?\$)$/.test(token);
}

function mergeTextTokenDiff(oldToken: string, newToken: string) {
  return diffChars(oldToken, newToken)
    .map((part) => {
      if (part.added) return wrapInsertedSegment(part.value);
      if (part.removed) return wrapRemovedSegment(part.value);
      return part.value;
    })
    .join('');
}

function normalizeFormattingPlainText(text: string) {
  return text.replace(/(\*\*|__|~~)/g, '').replace(/(^|[\s(])([*_])(?=\S)|(?<=\S)([*_])(?=[\s).,!?:;]|$)/g, '$1').trim();
}

function isFormattingOnlyChange(oldText: string | null, newText: string | null) {
  if (!oldText || !newText || oldText === newText) return false;
  return normalizeFormattingPlainText(oldText) === normalizeFormattingPlainText(newText);
}

export function buildMergedLineMarkdown(oldText: string | null, newText: string | null) {
  if (oldText === null && newText === null) return '';
  if (oldText === null) return wrapInsertedSegment(newText || '');
  if (newText === null) return wrapRemovedSegment(oldText);
  if (isFormattingOnlyChange(oldText, newText)) return newText;

  const oldTokens = tokenizeDiffMarkdown(oldText);
  const newTokens = tokenizeDiffMarkdown(newText);
  const tokenParts = diffArrays(oldTokens, newTokens);
  let merged = '';

  for (let index = 0; index < tokenParts.length; index += 1) {
    const part = tokenParts[index];

    if (!part.added && !part.removed) {
      merged += part.value.join('');
      continue;
    }

    if (part.removed && index + 1 < tokenParts.length && tokenParts[index + 1].added) {
      const removedTokens = part.value;
      const addedTokens = tokenParts[index + 1].value;
      const shared = Math.min(removedTokens.length, addedTokens.length);

      for (let offset = 0; offset < shared; offset += 1) {
        const removedToken = removedTokens[offset];
        const addedToken = addedTokens[offset];

        if (!isMathToken(removedToken) && !isMathToken(addedToken)) {
          merged += mergeTextTokenDiff(removedToken, addedToken);
        } else {
          merged += wrapRemovedSegment(removedToken);
          merged += wrapInsertedSegment(addedToken);
        }
      }

      for (const removedToken of removedTokens.slice(shared)) {
        merged += wrapRemovedSegment(removedToken);
      }
      for (const addedToken of addedTokens.slice(shared)) {
        merged += wrapInsertedSegment(addedToken);
      }

      index += 1;
      continue;
    }

    if (part.removed) {
      merged += part.value.map((token) => wrapRemovedSegment(token)).join('');
      continue;
    }

    if (part.added) {
      merged += part.value.map((token) => wrapInsertedSegment(token)).join('');
    }
  }

  return merged;
}
