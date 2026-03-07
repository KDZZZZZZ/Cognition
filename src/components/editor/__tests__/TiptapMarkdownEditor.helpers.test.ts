import { describe, expect, it } from 'vitest';
import {
  contentFingerprint,
  decodeHtmlEntities,
  detectMarkdownFeatures,
  normalizeMathFormula,
  normalizeMathMarkdownDelimiters,
  normalizeCopiedSelectionMarkdown,
  readDisplayMode,
  readHtmlAttr,
  readMathFormula,
  renderMathMarkdown,
  stripMathDelimiters,
} from '../TiptapMarkdownEditor';

describe('TiptapMarkdownEditor helpers', () => {
  it('detects markdown feature patterns', () => {
    expect(detectMarkdownFeatures('# title\ntext')).toBe(true);
    expect(detectMarkdownFeatures('- item\n- item2')).toBe(true);
    expect(detectMarkdownFeatures('plain text only')).toBe(false);
  });

  it('normalizes inline/block math html nodes to markdown', () => {
    const raw = [
      '<span data-type="inlineMath" data-latex="a+b" />',
      '<span data-type="inlineMath" data-display="yes" data-latex="x^2" />',
      '<math-inline formula="c+d"></math-inline>',
      '<math-block>e+f</math-block>',
    ].join('\n');

    const normalized = normalizeCopiedSelectionMarkdown(raw);
    expect(normalized).toContain('$a+b$');
    expect(normalized).toContain('$$x^2$$');
    expect(normalized).toContain('$c+d$');
    expect(normalized).toContain('$$e+f$$');
  });

  it('renders and parses math helpers with delimiter handling', () => {
    expect(renderMathMarkdown('x+y', false)).toBe('$x+y$');
    expect(renderMathMarkdown('x+y', true)).toBe('$$x+y$$');
    expect(renderMathMarkdown('x\ny', true)).toBe('$$\nx\ny\n$$');

    expect(stripMathDelimiters('$$x+y$$')).toBe('x+y');
    expect(stripMathDelimiters('$x+y$')).toBe('x+y');
    expect(stripMathDelimiters('<b>x+y</b>')).toBe('x+y');

    expect(readMathFormula('data-latex="x&amp;y"', 'ignored')).toBe('x&y');
    expect(readMathFormula('', '$x$')).toBe('x');

    expect(readDisplayMode('data-display="yes"', false)).toBe(true);
    expect(readDisplayMode('display="0"', true)).toBe(false);
  });

  it('normalizes double-escaped markdown math formulas for rendering', () => {
    expect(normalizeMathFormula(String.raw`M\\_\\theta`)).toBe(String.raw`M_\theta`);
    expect(normalizeMathFormula(String.raw`\\tau(\\cdot)`)).toBe(String.raw`\tau(\cdot)`);
    expect(normalizeMathMarkdownDelimiters(String.raw`$M\\_\\theta$ and $\\tau(\\cdot)$`)).toBe(
      String.raw`$M_\theta$ and $\tau(\cdot)$`
    );
  });

  it('decodes html attrs and produces stable fingerprints', () => {
    expect(readHtmlAttr('data-latex="&quot;x&quot;"', 'data-latex')).toBe('"x"');
    expect(readHtmlAttr('data-latex="x"', 'missing')).toBeUndefined();

    expect(decodeHtmlEntities('&lt;a&amp;b&gt;')).toBe('<a&b>');

    const a = contentFingerprint('hello world');
    const b = contentFingerprint('hello world');
    const c = contentFingerprint('hello world!');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
