import { diffArrays, diffChars } from 'diff';
import type { DiffLineDTO, LineDecision } from '../../types';

export type DiffRowStatus = 'equal' | 'modify' | 'add' | 'remove';

export interface DiffCharSegment {
  text: string;
  added?: boolean;
  removed?: boolean;
}

export interface DiffRenderRow {
  id: string;
  reviewLineNumber: number;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  oldText: string | null;
  newText: string | null;
  status: DiffRowStatus;
  decision: LineDecision | null;
  oldSegments: DiffCharSegment[];
  newSegments: DiffCharSegment[];
}

function splitContentLines(content: string): string[] {
  return content.length === 0 ? [] : content.split('\n');
}

function buildSegments(oldText: string | null, newText: string | null): Pick<DiffRenderRow, 'oldSegments' | 'newSegments'> {
  if (oldText === null && newText === null) {
    return { oldSegments: [], newSegments: [] };
  }

  if (oldText === null) {
    return {
      oldSegments: [],
      newSegments: [{ text: newText || '', added: true }],
    };
  }

  if (newText === null) {
    return {
      oldSegments: [{ text: oldText, removed: true }],
      newSegments: [],
    };
  }

  const parts = diffChars(oldText, newText);
  const oldSegments: DiffCharSegment[] = [];
  const newSegments: DiffCharSegment[] = [];

  for (const part of parts) {
    if (!part.added) {
      oldSegments.push({
        text: part.value,
        removed: Boolean(part.removed),
      });
    }
    if (!part.removed) {
      newSegments.push({
        text: part.value,
        added: Boolean(part.added),
      });
    }
  }

  return { oldSegments, newSegments };
}

function buildRow(
  id: string,
  reviewLineNumber: number,
  oldLineNumber: number | null,
  newLineNumber: number | null,
  oldText: string | null,
  newText: string | null,
  decision: LineDecision | null
): DiffRenderRow {
  const status: DiffRowStatus =
    oldText === newText ? 'equal' : oldText === null ? 'add' : newText === null ? 'remove' : 'modify';

  return {
    id,
    reviewLineNumber,
    oldLineNumber,
    newLineNumber,
    oldText,
    newText,
    status,
    decision,
    ...buildSegments(oldText, newText),
  };
}

export function buildRowsFromPendingLines(lines: DiffLineDTO[]): DiffRenderRow[] {
  let oldLineNumber = 0;
  let newLineNumber = 0;

  return [...lines]
    .sort((a, b) => a.line_no - b.line_no)
    .map((line) => {
      const currentOldLineNumber = line.old_line !== null ? oldLineNumber + 1 : null;
      const currentNewLineNumber = line.new_line !== null ? newLineNumber + 1 : null;

      if (line.old_line !== null) oldLineNumber += 1;
      if (line.new_line !== null) newLineNumber += 1;

      return buildRow(
        line.id,
        line.line_no,
        currentOldLineNumber,
        currentNewLineNumber,
        line.old_line,
        line.new_line,
        line.decision
      );
    });
}

export function buildRowsFromContents(oldContent: string, newContent: string): DiffRenderRow[] {
  const oldLines = splitContentLines(oldContent);
  const newLines = splitContentLines(newContent);
  const parts = diffArrays(oldLines, newLines);
  const rows: DiffRenderRow[] = [];
  let reviewLineNumber = 1;
  let oldLineNumber = 0;
  let newLineNumber = 0;

  const pushRow = (oldText: string | null, newText: string | null) => {
    const currentOldLineNumber = oldText !== null ? oldLineNumber + 1 : null;
    const currentNewLineNumber = newText !== null ? newLineNumber + 1 : null;
    if (oldText !== null) oldLineNumber += 1;
    if (newText !== null) newLineNumber += 1;
    rows.push(
      buildRow(
        `computed-${reviewLineNumber}`,
        reviewLineNumber,
        currentOldLineNumber,
        currentNewLineNumber,
        oldText,
        newText,
        null
      )
    );
    reviewLineNumber += 1;
  };

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part.added && !part.removed) {
      for (const line of part.value) {
        pushRow(line, line);
      }
      continue;
    }

    if (part.removed && index + 1 < parts.length && parts[index + 1].added) {
      const removedLines = part.value;
      const addedLines = parts[index + 1].value;
      const shared = Math.min(removedLines.length, addedLines.length);

      for (let offset = 0; offset < shared; offset += 1) {
        pushRow(removedLines[offset], addedLines[offset]);
      }
      for (const removedLine of removedLines.slice(shared)) {
        pushRow(removedLine, null);
      }
      for (const addedLine of addedLines.slice(shared)) {
        pushRow(null, addedLine);
      }
      index += 1;
      continue;
    }

    if (part.removed) {
      for (const line of part.value) {
        pushRow(line, null);
      }
      continue;
    }

    if (part.added) {
      for (const line of part.value) {
        pushRow(null, line);
      }
    }
  }

  return rows;
}
