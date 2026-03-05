import fs from 'node:fs/promises';
import path from 'node:path';

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectPdfFiles(root: string, maxDepth: number): Promise<string[]> {
  const out: string[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
        out.push(absolute);
      }
    }
  }

  await walk(root, 0);
  return out;
}

function preferUploadedPaper(paths: string[]): string | null {
  if (!paths.length) return null;
  const sorted = [...paths].sort();

  const exactArxiv = sorted.find((item) => path.basename(item).toLowerCase() === '2502.09992v3.pdf');
  if (exactArxiv) return exactArxiv;

  const uploadedPaper = sorted.find((item) => /paper-uploaded-\d+\.pdf$/i.test(path.basename(item)));
  if (uploadedPaper) return uploadedPaper;

  const paperNamed = sorted.find((item) => /paper|arxiv|survey|literature/i.test(path.basename(item)));
  if (paperNamed) return paperNamed;

  return sorted[sorted.length - 1] || null;
}

export async function resolvePaperFixturePath(): Promise<string> {
  const envPath = String(process.env.E2E_PAPER_FIXTURE_PATH || '').trim();
  if (envPath) {
    const absolute = path.resolve(envPath);
    if (!(await pathExists(absolute))) {
      throw new Error(`E2E_PAPER_FIXTURE_PATH does not exist: ${absolute}`);
    }
    return absolute;
  }

  const repoRoot = process.cwd();
  const uploadRoot = path.resolve(repoRoot, 'backend/uploads');
  const uploaded = preferUploadedPaper(await collectPdfFiles(uploadRoot, 4));
  if (uploaded && (await pathExists(uploaded))) {
    return uploaded;
  }

  const fallback = path.resolve(repoRoot, 'test_sample.pdf');
  if (await pathExists(fallback)) {
    return fallback;
  }

  throw new Error(
    `No paper PDF fixture found. Set E2E_PAPER_FIXTURE_PATH or place a PDF under ${uploadRoot}.`
  );
}
