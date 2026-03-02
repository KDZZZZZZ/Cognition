import path from 'node:path';

import { expect, test } from '@playwright/test';

import { loadFeatureCatalog, loadTestPaths } from '../support/catalog-loader';

test('catalog integrity: every feature has at least one test path and source coverage is non-empty', async () => {
  const repoRoot = process.cwd();
  const featuresFile = await loadFeatureCatalog(repoRoot);
  const testPathFile = await loadTestPaths(repoRoot);

  expect(featuresFile.total_features).toBeGreaterThan(0);
  expect(testPathFile.total_paths).toBeGreaterThan(0);

  const featureIdSet = new Set(featuresFile.features.map((feature) => feature.feature_id));
  const pathByFeature = new Map<string, number>();

  for (const testPath of testPathFile.paths) {
    expect(featureIdSet.has(testPath.feature_id)).toBeTruthy();
    pathByFeature.set(testPath.feature_id, (pathByFeature.get(testPath.feature_id) || 0) + 1);
  }

  for (const feature of featuresFile.features) {
    expect(pathByFeature.get(feature.feature_id) || 0).toBeGreaterThan(0);
  }

  const allRoutes = new Set<string>();
  const allTools = new Set<string>();
  const allUiNodes = new Set<string>();

  for (const feature of featuresFile.features) {
    for (const route of feature.source_routes) allRoutes.add(route);
    for (const tool of feature.source_tools) allTools.add(tool);
    for (const ui of feature.source_ui_nodes) allUiNodes.add(ui);
  }

  expect(allRoutes.size).toBeGreaterThan(0);
  expect(allTools.size).toBeGreaterThan(0);
  expect(allUiNodes.size).toBeGreaterThan(0);

  // Keep this assertion to ensure report artifacts are resolved relative to repo root in runner scripts.
  expect(path.isAbsolute(path.join(repoRoot, 'reports/e2e/catalog/features.json'))).toBeTruthy();
});
