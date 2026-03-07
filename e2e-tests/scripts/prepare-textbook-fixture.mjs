#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const backendEnvPath = path.join(repoRoot, 'backend', '.env');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || process.env[key]) continue;
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(backendEnvPath);

const defaultSource = '/Users/kaidongzhou/Downloads/概率论教程 (钟开莱,  吴让泉) (z-library.sk, 1lib.sk, z-lib.sk).pdf';
const sourcePdf = path.resolve(process.env.E2E_TEXTBOOK_SOURCE_PDF || defaultSource);
const localPdf = path.resolve(
  process.env.E2E_TEXTBOOK_FIXTURE_PATH ||
    path.join(repoRoot, 'e2e-tests', 'local-fixtures', 'textbooks', 'probability-tutorial.pdf')
);
const manifestPath = path.resolve(
  process.env.E2E_TEXTBOOK_MANIFEST_PATH ||
    path.join(repoRoot, 'e2e-tests', 'fixtures', 'textbooks', 'probability-tutorial.manifest.json')
);
const selectionMode = String(process.env.E2E_TEXTBOOK_SELECTION_MODE || 'backend_text').trim().toLowerCase();
const cacheDir = path.join(path.dirname(localPdf), '.ocr-cache');
const siliconflowApiKey = process.env.SILICONFLOW_API_KEY || '';
const siliconflowBaseUrl = process.env.E2E_TEXTBOOK_OCR_BASE_URL || 'https://api.siliconflow.cn/v1';
const siliconflowModel = process.env.E2E_TEXTBOOK_OCR_MODEL || 'deepseek-ai/DeepSeek-OCR';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'your', 'into', 'page', 'then', 'when', 'will', 'were',
  'been', 'they', 'them', 'their', 'there', 'than', 'such', 'only', 'also', 'more', 'less', 'some', 'most', 'over',
  'each', 'does', 'used', 'using', 'just', 'very', 'true', 'false', 'must', 'need', 'same', 'type', 'show', 'line',
  'proof', 'theorem', 'lemma', 'data', 'mode', 'step', 'task', 'file', 'text', 'note',
  'new', 'york', 'press', 'university', 'publishing', 'company', 'cambridge', 'springer',
  'berlin', 'paris', 'princeton', 'translated', 'edition', 'probability', 'theory', 'analysis',
  'variables', 'random', 'book', 'books', 'vol', 'volume', 'inc', 'addison', 'wiley', 'holden',
  'macmillan', 'villars', 'north', 'holland', 'course', 'mathematics', 'real', 'measure'
]);

const REFERENCE_PATTERNS = [
  /new york/gi,
  /cambridge/gi,
  /springer/gi,
  /publishing/gi,
  /university press/gi,
  /book company/gi,
  /addison-wesley/gi,
  /holden-?day/gi,
  /north-?holland/gi,
  /gaut[h]?ier-?villars/gi,
  /mcgraw-?hill/gi,
  /translated/gi,
  /\bvol\.?\b/gi,
  /\bed\.?\b/gi,
  /\bedition\b/gi,
  /measure theory/gi,
  /real analysis/gi,
  /course of pure mathematics/gi,
  /introduction to probability/gi,
  /random variables and probability distributions/gi,
];

function fail(message) {
  console.error(`[tb-fixture] ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: options.stdio || 'pipe',
    cwd: options.cwd || repoRoot,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    const stdout = (result.stdout || '').trim();
    fail(`${command} ${args.join(' ')} failed (${result.status}). ${stderr || stdout}`);
  }
  return result.stdout || '';
}

function ensurePrerequisites() {
  const missing = [];
  const required = ['pdfinfo', 'pdftotext'];
  if (selectionMode === 'ocr') {
    required.push('pdftoppm', 'tesseract');
  }
  for (const cmd of required) {
    const check = spawnSync('bash', ['-lc', `command -v ${cmd} >/dev/null 2>&1`], { cwd: repoRoot });
    if (check.status !== 0) missing.push(cmd);
  }
  if (missing.length) fail(`Missing required commands: ${missing.join(', ')}`);
  if (!fs.existsSync(sourcePdf)) fail(`Source PDF not found: ${sourcePdf}`);
}

function ensureLocalPdf() {
  fs.mkdirSync(path.dirname(localPdf), { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  if (fs.existsSync(localPdf)) {
    try {
      const stat = fs.lstatSync(localPdf);
      if (stat.isSymbolicLink() || stat.isFile()) {
        const current = stat.isSymbolicLink() ? fs.readlinkSync(localPdf) : null;
        if (current === sourcePdf || path.resolve(localPdf) === sourcePdf) return;
        fs.rmSync(localPdf, { force: true });
      }
    } catch {
      fs.rmSync(localPdf, { force: true });
    }
  }
  try {
    fs.symlinkSync(sourcePdf, localPdf);
  } catch {
    fs.copyFileSync(sourcePdf, localPdf);
  }
}

function getPageCount() {
  const output = run('pdfinfo', [sourcePdf]);
  const match = output.match(/^Pages:\s+(\d+)/m);
  if (!match) fail('Could not read page count from pdfinfo output.');
  const pages = Number(match[1]);
  if (!Number.isFinite(pages) || pages < 100) fail(`Expected PDF with at least 100 pages, got ${pages}.`);
  return pages;
}

function normalizeText(raw) {
  return String(raw || '')
    .replace(/\f/g, ' ')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPageTextWithPdfToText(page) {
  const output = run('pdftotext', ['-f', String(page), '-l', String(page), sourcePdf, '-']);
  return normalizeText(output);
}

function renderPageImage(page) {
  const prefix = path.join(cacheDir, `page-${page}`);
  let imgName = fs.readdirSync(cacheDir, { withFileTypes: true })
    .map((entry) => entry.name)
    .find((name) => name.startsWith(`page-${page}-`) && name.endsWith('.png'));

  if (!imgName) {
    run('pdftoppm', ['-f', String(page), '-l', String(page), '-r', '150', '-gray', '-png', sourcePdf, prefix]);
    imgName = fs.readdirSync(cacheDir, { withFileTypes: true })
      .map((entry) => entry.name)
      .find((name) => name.startsWith(`page-${page}-`) && name.endsWith('.png'));
  }

  if (!imgName) fail(`No rendered PNG found for page ${page}`);
  return path.join(cacheDir, imgName);
}

async function ocrPageWithSiliconFlow(page, imagePath) {
  if (!siliconflowApiKey) return null;
  const cachePath = path.join(cacheDir, `page-${page}.siliconflow.txt`);
  if (fs.existsSync(cachePath)) {
    const cached = normalizeText(fs.readFileSync(cachePath, 'utf-8'));
    if (cached) return cached;
  }

  const base64 = fs.readFileSync(imagePath).toString('base64');
  const imageUrl = `data:image/png;base64,${base64}`;
  const prompt = 'Extract all visible text from this scanned textbook page. Return plain text only. Preserve mathematical symbols when possible. Do not add explanations.';

  const response = await fetch(`${siliconflowBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${siliconflowApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: siliconflowModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`SiliconFlow OCR HTTP ${response.status}: ${text.slice(0, 400)}`);
  }

  const json = await response.json();
  const content = normalizeText(
    json?.choices?.[0]?.message?.content
      || json?.output?.choices?.[0]?.message?.content?.[0]?.text
      || ''
  );
  fs.writeFileSync(cachePath, content, 'utf-8');
  return content || null;
}

function ocrPageWithTesseract(page, imagePath) {
  const cachePath = path.join(cacheDir, `page-${page}.tesseract.txt`);
  if (fs.existsSync(cachePath)) {
    const cached = normalizeText(fs.readFileSync(cachePath, 'utf-8'));
    if (cached) return cached;
  }
  const outBase = path.join(cacheDir, `page-${page}-ocr`);
  run('tesseract', [imagePath, outBase, '-l', 'eng', '--psm', '6']);
  const text = normalizeText(fs.readFileSync(`${outBase}.txt`, 'utf-8'));
  fs.writeFileSync(cachePath, text, 'utf-8');
  return text;
}

async function ocrPage(page) {
  if (selectionMode !== 'ocr') {
    return extractPageTextWithPdfToText(page);
  }

  const txtPath = path.join(cacheDir, `page-${page}.txt`);
  const modePath = path.join(cacheDir, `page-${page}.mode.txt`);
  const preferredMode = siliconflowApiKey ? 'deepseek_ocr' : 'tesseract_eng';
  if (fs.existsSync(txtPath)) {
    const cachedMode = fs.existsSync(modePath) ? normalizeText(fs.readFileSync(modePath, 'utf-8')) : '';
    const cached = normalizeText(fs.readFileSync(txtPath, 'utf-8'));
    if (cached && cachedMode === preferredMode) return cached;
  }

  const imagePath = renderPageImage(page);
  let text = '';
  let mode = 'tesseract_eng';
  if (siliconflowApiKey) {
    try {
      text = (await ocrPageWithSiliconFlow(page, imagePath)) || '';
      mode = 'deepseek_ocr';
    } catch (error) {
      console.warn(`[tb-fixture] SiliconFlow OCR failed on page ${page}, falling back to tesseract: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!text) {
    text = ocrPageWithTesseract(page, imagePath);
    mode = 'tesseract_eng';
  }

  text = normalizeText(text);
  fs.writeFileSync(txtPath, text, 'utf-8');
  fs.writeFileSync(path.join(cacheDir, `page-${page}.mode.txt`), mode, 'utf-8');
  return text;
}

function tokenize(text) {
  return (text.match(/[A-Za-z][A-Za-z0-9-]{2,}/g) || [])
    .map((token) => token.toLowerCase())
    .filter((token) => !STOP_WORDS.has(token));
}

function countMatches(text, patterns) {
  return patterns.reduce((total, pattern) => total + (text.match(pattern) || []).length, 0);
}

function referenceSignal(text) {
  const years = (text.match(/\b(18|19|20)\d{2}\b/g) || []).length;
  const numberedRefs = (text.match(/\(\d{1,2}\)/g) || []).length;
  const publisherHits = countMatches(text, REFERENCE_PATTERNS);
  return {
    years,
    numberedRefs,
    publisherHits,
    score: publisherHits * 6 + years * 2 + numberedRefs * 2,
  };
}

function mathSignal(text) {
  const formulaHits = (text.match(/[=<>]|P\{|P\(|E\{|E\(|Var|Cov|sum|lim|sup|inf|max|min|log|martingale|independent/gi) || []).length;
  const structureHits = (text.match(/9\.\d|8\.\d|7\.\d|6\.\d|5\.\d|4\.\d|3\.\d|2\.\d|1\.\d|[A-Z]_?\d|S[ntj]|X[ntj]|Y[ntj]|Z[ntj]/g) || []).length;
  return {
    formulaHits,
    structureHits,
    score: formulaHits * 10 + structureHits * 8,
  };
}

function isReferenceLike(text) {
  const ref = referenceSignal(text);
  return ref.publisherHits >= 3 || ref.numberedRefs >= 6 || ref.score >= 16;
}

function scorePage(text) {
  const len = text.length;
  const ref = referenceSignal(text);
  const math = mathSignal(text);
  const topicHits = (text.match(/chebyshev|markov|gaussian|normal|poisson|bernoulli|rajchman|independent|distribution|variance|expectation|martingale|conditional/gi) || []).length;
  const referencePenalty = ref.publisherHits * 220 + ref.numberedRefs * 45 + ref.years * 24;
  return len + math.score + topicHits * 60 - referencePenalty;
}

function topTokens(tokens, count = 4) {
  const seen = new Map();
  for (const token of tokens) seen.set(token, (seen.get(token) || 0) + 1);
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, count)
    .map(([token]) => token);
}

async function chooseCandidatePages(pageCount) {
  const expanded = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const text = await ocrPage(page);
    const tokens = tokenize(text);
    if (text.length > 20) expanded.push({ page, text, tokens, score: scorePage(text) });
  }

  if (expanded.length < 1) {
    fail('No backend-readable textbook pages found (pdftotext returned empty text for all pages).');
  }

  const filtered = expanded.filter((item) => !isReferenceLike(item.text));
  if (filtered.length >= 1) return filtered;
  return expanded;
}

function bestLongScope(pages) {
  let best = null;
  const pageMap = new Map(pages.map((item) => [item.page, item]));
  for (const item of pages) {
    const window = [];
    for (let page = item.page; page < item.page + 4; page += 1) {
      const next = pageMap.get(page);
      if (!next || next.text.length < 40 || isReferenceLike(next.text)) {
        window.length = 0;
        break;
      }
      window.push(next);
    }
    if (window.length !== 4) continue;
    const score = window.reduce((sum, entry) => sum + entry.score + mathSignal(entry.text).score, 0);
    if (!best || score > best.score) best = { window, score };
  }
  const selected = best ? best.window : [...pages].sort((a, b) => b.score - a.score).slice(0, 4).sort((a, b) => a.page - b.page);
  return {
    start_page: selected[0].page,
    end_page: selected[selected.length - 1].page,
    anchor_terms: topTokens(selected.flatMap((item) => item.tokens), 5),
  };
}

function bestViewportFocus(pages) {
  let best = null;
  const pageMap = new Map(pages.map((item) => [item.page, item]));
  for (const item of pages) {
    if (isReferenceLike(item.text)) continue;
    const prev = pageMap.get(item.page - 1);
    const next = pageMap.get(item.page + 1);
    const neighborTokens = new Set([...(prev?.tokens || []), ...(next?.tokens || [])]);
    const unique = item.tokens.filter((token) => !neighborTokens.has(token) && token.length >= 4);
    if (unique.length < 2) continue;
    const score = item.score + unique.length * 40 + mathSignal(item.text).score;
    if (!best || score > best.score) {
      best = {
        page: item.page,
        anchor_terms: topTokens(unique, 4),
        forbidden_neighbor_terms: topTokens(
          [...(prev?.tokens || []), ...(next?.tokens || [])].filter((token) => token.length >= 4),
          4
        ),
        score,
      };
    }
  }
  if (best) return best;
  const fallback = [...pages].sort((a, b) => b.score - a.score)[0];
  return { page: fallback.page, anchor_terms: topTokens(fallback.tokens, 4), forbidden_neighbor_terms: [] };
}

function bestQaPage(pages, viewportFocus) {
  const preferred = [...pages].sort((a, b) => {
    const aRef = isReferenceLike(a.text) ? 1 : 0;
    const bRef = isReferenceLike(b.text) ? 1 : 0;
    const aBoost = /chebyshev|markov|independent|variance|distribution|expectation/i.test(a.text) ? 1 : 0;
    const bBoost = /chebyshev|markov|independent|variance|distribution|expectation/i.test(b.text) ? 1 : 0;
    return aRef - bRef || bBoost - aBoost || b.score - a.score;
  })[0];
  const page = preferred?.page || viewportFocus.page;
  const anchorTerms = preferred?.tokens?.length ? topTokens(preferred.tokens, 4) : viewportFocus.anchor_terms;
  const lower = String(preferred?.text || '').toLowerCase();
  let userDerivationPrompt = '我想直接忽略这一页结论里的适用条件，把它推广到任意随机变量，而且不检查独立性，这样合法吗？';
  if (lower.includes('chebyshev')) {
    userDerivationPrompt = '我想不检查二阶矩是否有限，直接把这一页的 Chebyshev 型不等式用于任意随机变量，而且把分母中的平方去掉，这样合法吗？';
  } else if (lower.includes('markov')) {
    userDerivationPrompt = '我想不检查非负条件，直接把这一页的 Markov 型不等式用于任意随机变量，这样合法吗？';
  } else if (lower.includes('independent')) {
    userDerivationPrompt = '我想直接把这一页关于独立性的结论拿去用，但不验证独立条件，这样合法吗？';
  } else if (lower.includes('variance') || lower.includes('expectation')) {
    userDerivationPrompt = '我想跳过这一页里对方差或期望存在性的检查，直接继续推导，这样合法吗？';
  }
  return { page, anchor_terms: anchorTerms, user_derivation_prompt: userDerivationPrompt };
}

function writeManifest(manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

async function main() {
  ensurePrerequisites();
  ensureLocalPdf();
  const pageCount = getPageCount();
  const pages = await chooseCandidatePages(pageCount);
  const longScope = bestLongScope(pages);
  const viewportFocus = bestViewportFocus(pages);
  const qaValidate = bestQaPage(pages, viewportFocus);
  const permissionProbe = { page: viewportFocus.page, anchor_terms: viewportFocus.anchor_terms };

  const manifest = {
    id: 'probability-tutorial',
    display_name: '概率论教程',
    pdf_path: localPdf,
    page_count: pageCount,
    extraction_mode: selectionMode === 'ocr'
      ? (siliconflowApiKey ? 'deepseek_ocr_with_tesseract_fallback' : 'tesseract_eng')
      : 'backend_text_pdftotext',
    source_pdf: sourcePdf,
    page_sets: {
      long_scope: longScope,
      qa_validate: qaValidate,
      viewport_focus: {
        page: viewportFocus.page,
        anchor_terms: viewportFocus.anchor_terms,
        forbidden_neighbor_terms: viewportFocus.forbidden_neighbor_terms,
      },
      permission_probe: permissionProbe,
    },
  };

  writeManifest(manifest);
  console.log(`[tb-fixture] prepared: ${localPdf}`);
  console.log(`[tb-fixture] manifest: ${manifestPath}`);
  console.log(JSON.stringify(manifest, null, 2));
}

await main();
