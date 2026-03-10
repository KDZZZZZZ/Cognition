import katex from 'katex';
import hljs from 'highlight.js';

export const markdownProseClassName =
  'prose prose-sm max-w-none text-theme-text prose-headings:mb-2 prose-headings:mt-3 prose-headings:text-theme-text prose-p:my-2 prose-p:text-theme-text prose-strong:text-theme-text prose-li:my-1 prose-li:text-theme-text prose-a:text-theme-text prose-blockquote:text-theme-text/70 prose-pre:bg-transparent prose-pre:text-theme-text prose-pre:p-0 prose-code:text-theme-text prose-code:before:content-none prose-code:after:content-none [&_.katex-display]:my-1 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display>.katex]:inline-block [&>*:first-child]:mt-0 [&>*:last-child]:mb-0';

export const markdownCodeBlockClassName =
  'overflow-x-auto rounded-md border border-theme-border/20 p-2 paper-divider';

export const diffInlineInsertClassName =
  'rounded-sm bg-emerald-500/25 px-[1px] py-0.5 text-theme-text';

export const diffInlineDeleteClassName =
  'rounded-sm bg-rose-500/20 px-[1px] py-0.5 text-theme-text/70 decoration-rose-700/80';

export const diffStructuralClassName =
  'rounded-md border border-amber-500/30 bg-amber-500/10';

export const diffBlockInsertClassName =
  'rounded-sm bg-emerald-500/10';

export const diffBlockDeleteClassName =
  'rounded-sm bg-rose-500/10';

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderKatexToHtml(latex: string, displayMode = false) {
  try {
    return katex.renderToString(latex, {
      throwOnError: false,
      displayMode,
    });
  } catch {
    return null;
  }
}

export function highlightCodeToHtml(code: string, language?: string | null) {
  const normalizedLanguage = language?.trim().toLowerCase();
  try {
    if (normalizedLanguage && hljs.getLanguage(normalizedLanguage)) {
      return hljs.highlight(code, { language: normalizedLanguage }).value;
    }
    return escapeHtml(code);
  } catch {
    return escapeHtml(code);
  }
}
