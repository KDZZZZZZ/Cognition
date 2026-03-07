import type { Content, List, ListItem, Table } from 'mdast';
import type { DiffBlock, ReviewUnit } from './types';
import type { DiffRenderRow } from '../diffRows';

function sliceRowsByPosition(rows: DiffRenderRow[], node: Content | ListItem) {
  const startLine = node.position?.start.line;
  const endLine = node.position?.end.line;
  if (!startLine || !endLine) return [];
  return rows.slice(startLine - 1, endLine);
}

function createUnit(
  block: DiffBlock,
  kind: ReviewUnit['kind'],
  rows: DiffRenderRow[],
  label?: string | null
): ReviewUnit | null {
  const changedRows = rows.filter((row) => row.status !== 'equal');
  const lineIds = changedRows.map((row) => row.id).filter((id): id is string => Boolean(id));
  if (changedRows.length === 0 || lineIds.length === 0) return null;

  return {
    id: `${block.id}-${kind}-${lineIds.join('-')}`,
    kind,
    lineIds,
    rows,
    changedRows,
    label: label || null,
  };
}

function buildLineUnits(block: DiffBlock) {
  return block.changedRows
    .map((row) => createUnit(block, 'line', [row]))
    .filter((unit): unit is ReviewUnit => Boolean(unit));
}

function buildCodeLineUnits(block: DiffBlock) {
  return block.changedRows
    .map((row) => createUnit(block, 'code_line', [row], `Line ${row.newLineNumber ?? row.oldLineNumber ?? row.reviewLineNumber}`))
    .filter((unit): unit is ReviewUnit => Boolean(unit));
}

function buildItemUnits(block: DiffBlock) {
  const listNode = block.reviewNode as List | null;
  if (!listNode || listNode.type !== 'list') {
    return buildLineUnits(block);
  }

  const units: ReviewUnit[] = [];
  const coveredLineIds = new Set<string>();

  listNode.children.forEach((item, index) => {
    const itemRows = sliceRowsByPosition(block.rows, item);
    const unit = createUnit(block, 'item', itemRows, `Item ${index + 1}`);
    if (!unit) return;
    units.push(unit);
    unit.lineIds.forEach((lineId) => coveredLineIds.add(lineId));
  });

  for (const row of block.changedRows) {
    if (row.id && !coveredLineIds.has(row.id)) {
      const unit = createUnit(block, 'item', [row], `Item ${row.newLineNumber ?? row.oldLineNumber ?? row.reviewLineNumber}`);
      if (unit) units.push(unit);
    }
  }

  return units;
}

function buildTableUnits(block: DiffBlock) {
  const tableNode = block.reviewNode as Table | null;
  if (!tableNode || tableNode.type !== 'table') {
    return buildLineUnits(block);
  }

  const units: ReviewUnit[] = [];
  const coveredLineIds = new Set<string>();
  const bodyRows = tableNode.children.slice(1);

  bodyRows.forEach((row, index) => {
    const rowLines = sliceRowsByPosition(block.rows, row);
    const unit = createUnit(block, 'line', rowLines, `Row ${index + 1}`);
    if (!unit) return;
    units.push(unit);
    unit.lineIds.forEach((lineId) => coveredLineIds.add(lineId));
  });

  for (const row of block.changedRows) {
    if (row.id && !coveredLineIds.has(row.id)) {
      const unit = createUnit(block, 'line', [row], `Row ${row.newLineNumber ?? row.oldLineNumber ?? row.reviewLineNumber}`);
      if (unit) units.push(unit);
    }
  }

  return units;
}

function buildBlockUnit(block: DiffBlock, label?: string | null) {
  const unit = createUnit(block, 'block', block.rows, label);
  return unit ? [unit] : [];
}

export function buildReviewUnits(block: DiffBlock): ReviewUnit[] {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'blockquote':
    case 'unknown':
    case 'blank':
      return buildLineUnits(block);
    case 'list':
    case 'task_list':
      return buildItemUnits(block);
    case 'code':
    case 'mermaid':
      return buildCodeLineUnits(block);
    case 'table':
      return buildTableUnits(block);
    case 'math':
      return buildBlockUnit(block, 'Formula block');
    case 'callout':
    case 'frontmatter':
    case 'footnote':
    case 'html':
    case 'thematic_break':
      return buildBlockUnit(block);
    default:
      return buildBlockUnit(block);
  }
}
