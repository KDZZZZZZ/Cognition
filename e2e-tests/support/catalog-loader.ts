import fs from 'node:fs/promises';
import path from 'node:path';

import type { FeatureCatalogFile, TestPathFile } from './types';

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

export async function loadFeatureCatalog(repoRoot: string): Promise<FeatureCatalogFile> {
  const filePath = path.join(repoRoot, 'reports/e2e/catalog/features.json');
  const text = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(text) as FeatureCatalogFile;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('features.json is not a valid object');
  }

  assertArray(parsed.features, 'features');
  return parsed;
}

export async function loadTestPaths(repoRoot: string): Promise<TestPathFile> {
  const filePath = path.join(repoRoot, 'reports/e2e/catalog/test-paths.json');
  const text = await fs.readFile(filePath, 'utf-8');
  const parsed = JSON.parse(text) as TestPathFile;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('test-paths.json is not a valid object');
  }

  assertArray(parsed.paths, 'paths');
  assertArray(parsed.execution_targets, 'execution_targets');
  return parsed;
}
