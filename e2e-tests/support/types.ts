export type RiskLevel = 'P0' | 'P1' | 'P2';
export type GateLevel = 'blocking' | 'warning';

export interface FeatureCatalogItem {
  feature_id: string;
  name: string;
  source_routes: string[];
  source_tools: string[];
  source_ui_nodes: string[];
  risk: RiskLevel;
  owner: 'frontend' | 'backend' | 'cross';
}

export interface ExecutionTarget {
  id: string;
  name: string;
  description: string;
  spec: string;
  grep?: string;
  llm_mode: 'real';
  browser: 'chromium-desktop';
}

export type EvidenceType = 'screenshot' | 'trace' | 'video' | 'network' | 'console';

export interface TestPath {
  path_id: string;
  feature_id: string;
  preconditions: string[];
  steps: string[];
  expected: string[];
  selectors: string[];
  evidence: EvidenceType[];
  gate_level: GateLevel;
  execution_target: string;
}

export interface RunResult {
  run_id: string;
  started_at: string;
  ended_at: string;
  llm_mode: 'real';
  browser: 'chromium-desktop';
  pass: number;
  fail: number;
  flaky: number;
  coverage: {
    features_total: number;
    features_tested: number;
  };
}

export interface FeatureCatalogFile {
  generated_at: string;
  total_features: number;
  features: FeatureCatalogItem[];
}

export interface TestPathFile {
  generated_at: string;
  total_paths: number;
  execution_targets: ExecutionTarget[];
  paths: TestPath[];
}
