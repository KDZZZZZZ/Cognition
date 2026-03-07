import type { Root, Content } from 'mdast';
import type { DiffRenderRow } from '../diffRows';

export type DiffBlockKind =
  | 'heading'
  | 'paragraph'
  | 'blockquote'
  | 'callout'
  | 'list'
  | 'task_list'
  | 'code'
  | 'mermaid'
  | 'math'
  | 'table'
  | 'html'
  | 'frontmatter'
  | 'footnote'
  | 'thematic_break'
  | 'blank'
  | 'unknown';

export interface DiffCalloutMeta {
  kind: string;
  title: string | null;
}

export type ReviewUnitKind = 'line' | 'item' | 'block' | 'code_line';

export interface ReviewUnit {
  id: string;
  kind: ReviewUnitKind;
  lineIds: string[];
  rows: DiffRenderRow[];
  changedRows: DiffRenderRow[];
  label?: string | null;
}

export interface DiffBlock {
  id: string;
  kind: DiffBlockKind;
  rows: DiffRenderRow[];
  changedRows: DiffRenderRow[];
  reviewText: string;
  oldText: string;
  newText: string;
  compact: boolean;
  structural: boolean;
  reviewNode: Content | null;
  oldRoot: Root | null;
  newRoot: Root | null;
  callout: DiffCalloutMeta | null;
  reviewUnits: ReviewUnit[];
}
