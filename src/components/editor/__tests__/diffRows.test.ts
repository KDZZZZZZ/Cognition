import { describe, expect, it } from 'vitest';
import { buildRowsFromContents, buildRowsFromPendingLines } from '../diffRows';

describe('diffRows', () => {
  it('keeps inserted lines separate from replaced lines when building pending rows', () => {
    const rows = buildRowsFromPendingLines([
      { id: 'l1', line_no: 1, old_line: 'alpha', new_line: 'alpha', decision: 'accepted' },
      { id: 'l2', line_no: 2, old_line: 'beta', new_line: 'gamma', decision: 'pending' },
      { id: 'l3', line_no: 3, old_line: null, new_line: 'delta', decision: 'pending' },
    ]);

    expect(rows[1].status).toBe('modify');
    expect(rows[1].oldLineNumber).toBe(2);
    expect(rows[1].newLineNumber).toBe(2);
    expect(rows[2].status).toBe('add');
    expect(rows[2].oldLineNumber).toBeNull();
    expect(rows[2].newLineNumber).toBe(3);
  });

  it('pairs replace blocks before trailing inserts in computed rows', () => {
    const rows = buildRowsFromContents('line a\nline b', 'line a\nline c\nline d');

    expect(rows.map((row) => row.status)).toEqual(['equal', 'modify', 'add']);
    expect(rows[1].oldText).toBe('line b');
    expect(rows[1].newText).toBe('line c');
    expect(rows[2].oldText).toBeNull();
    expect(rows[2].newText).toBe('line d');
  });
});
