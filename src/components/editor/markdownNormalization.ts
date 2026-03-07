export function normalizeCopiedSelectionMarkdown(markdown: string): string {
  let normalized = markdown;

  normalized = normalized.replace(
    /<span\b([^>]*\bdata-type=(["'])inlineMath\2[^>]*)>([\s\S]*?)<\/span>/gi,
    (_match, attrs: string, _quote: string, inner: string) => {
      const formula = readMathFormula(attrs, inner);
      const display = readDisplayMode(attrs, false);
      return renderMathMarkdown(formula, display);
    }
  );

  normalized = normalized.replace(
    /<span\b([^>]*\bdata-type=(["'])inlineMath\2[^>]*)\/>/gi,
    (_match, attrs: string) => {
      const formula = readMathFormula(attrs, '');
      const display = readDisplayMode(attrs, false);
      return renderMathMarkdown(formula, display);
    }
  );

  normalized = normalized.replace(
    /<math-inline\b([^>]*)>([\s\S]*?)<\/math-inline>/gi,
    (_match, attrs: string, inner: string) => renderMathMarkdown(readMathFormula(attrs, inner), false)
  );
  normalized = normalized.replace(
    /<math-block\b([^>]*)>([\s\S]*?)<\/math-block>/gi,
    (_match, attrs: string, inner: string) => renderMathMarkdown(readMathFormula(attrs, inner), true)
  );

  return normalizeMathMarkdownDelimiters(normalized);
}

export function normalizeMathMarkdownDelimiters(markdown: string): string {
  let normalized = markdown.replace(
    /\$\$([\s\S]*?)\$\$/g,
    (_match, formula: string) => renderMathMarkdown(normalizeMathFormula(formula), true)
  );

  normalized = normalized.replace(
    /(?<!\$)\$([^$\n]+?)\$/g,
    (_match, formula: string) => renderMathMarkdown(normalizeMathFormula(formula), false)
  );

  return normalized;
}

export function normalizeMathFormula(formula: string): string {
  return formula
    .trim()
    .replace(/\\\\([A-Za-z])/g, '\\$1')
    .replace(/\\\\([_{}])/g, '$1')
    .replace(/\\([_{}])/g, '$1');
}

export function renderMathMarkdown(formula: string, displayMode: boolean): string {
  const normalized = formula.trim();
  if (!normalized) return '';
  if (displayMode) {
    return normalized.includes('\n') ? `$$\n${normalized}\n$$` : `$$${normalized}$$`;
  }
  return `$${normalized}$`;
}

export function readMathFormula(attrs: string, inner: string): string {
  const attrFormula = readHtmlAttr(attrs, 'data-latex') || readHtmlAttr(attrs, 'formula');
  if (attrFormula) return attrFormula;
  return stripMathDelimiters(inner);
}

export function readDisplayMode(attrs: string, fallback: boolean): boolean {
  const value = (readHtmlAttr(attrs, 'data-display') || readHtmlAttr(attrs, 'display') || '').toLowerCase();
  if (!value) return fallback;
  return value === 'yes' || value === 'true' || value === '1';
}

export function readHtmlAttr(attrs: string, attrName: string): string | undefined {
  const escapedAttr = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escapedAttr}=(["'])([\\s\\S]*?)\\1`, 'i');
  const match = attrs.match(pattern);
  if (!match) return undefined;
  return decodeHtmlEntities(match[2]);
}

export function stripMathDelimiters(content: string): string {
  const raw = decodeHtmlEntities(content).trim();
  const withoutTags = raw.replace(/<[^>]+>/g, '').trim();
  const blockMatch = withoutTags.match(/^\$\$([\s\S]*?)\$\$$/);
  if (blockMatch) return blockMatch[1].trim();
  const inlineMatch = withoutTags.match(/^\$([\s\S]*?)\$$/);
  if (inlineMatch) return inlineMatch[1].trim();
  return withoutTags;
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
