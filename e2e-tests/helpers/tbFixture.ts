import fs from 'node:fs/promises';
import path from 'node:path';

export interface TextbookManifest {
  id: string;
  display_name: string;
  pdf_path: string;
  page_count?: number;
  extraction_mode?: string;
  source_pdf?: string;
  page_sets: {
    long_scope: {
      start_page: number;
      end_page: number;
      anchor_terms: string[];
    };
    qa_validate: {
      page: number;
      anchor_terms: string[];
      user_derivation_prompt: string;
    };
    viewport_focus: {
      page: number;
      anchor_terms: string[];
      forbidden_neighbor_terms: string[];
    };
    permission_probe: {
      page: number;
      anchor_terms: string[];
    };
  };
}

export function resolveTextbookManifestPath(): string {
  return path.resolve(
    process.env.E2E_TEXTBOOK_MANIFEST_PATH ||
      path.join(process.cwd(), 'e2e-tests', 'fixtures', 'textbooks', 'probability-tutorial.manifest.json')
  );
}

export async function loadTextbookManifest(): Promise<TextbookManifest> {
  const manifestPath = resolveTextbookManifestPath();
  const raw = await fs.readFile(manifestPath, 'utf-8');
  const parsed = JSON.parse(raw) as TextbookManifest;
  if (!parsed?.page_sets?.long_scope || !parsed?.pdf_path) {
    throw new Error(`Invalid textbook manifest: ${manifestPath}`);
  }
  return parsed;
}
