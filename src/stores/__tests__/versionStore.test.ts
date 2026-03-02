import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVersionStore } from '../versionStore';

describe('useVersionStore', () => {
  beforeEach(() => {
    useVersionStore.setState({ history: {}, pendingDiffs: {} });
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds versions and queries history', () => {
    const state = useVersionStore.getState();
    const id = state.addVersion('file-1', 'human', 'edit', 'first', 'a', 'a\\nb');
    expect(id).toContain('v_');

    const history = useVersionStore.getState().getFileHistory('file-1');
    expect(history).toHaveLength(1);
    expect(useVersionStore.getState().getLatestVersion('file-1')?.summary).toBe('first');
    expect(useVersionStore.getState().revertToVersion('file-1', id)).toBe('a\\nb');
  });

  it('computes line-level diffs', () => {
    const diff = useVersionStore.getState().computeDiff('a\\nb', 'a\\nc');
    expect(diff.some((line) => line.type === 'remove')).toBe(true);
    expect(diff.some((line) => line.type === 'add')).toBe(true);
  });

  it('handles pending diff lifecycle', () => {
    const state = useVersionStore.getState();
    state.setPendingDiff('file-2', 'old', 'new', 'agent', 'proposal');
    expect(state.hasPendingDiff('file-2')).toBe(true);
    expect(state.getPendingDiff('file-2')?.summary).toBe('proposal');

    const accepted = state.acceptPendingDiff('file-2');
    expect(accepted).toBe('new');
    expect(state.hasPendingDiff('file-2')).toBe(false);
    expect(state.getFileHistory('file-2')).toHaveLength(1);

    state.setPendingDiff('file-2', 'older', 'newer', 'agent', 'proposal-2');
    const rejected = state.rejectPendingDiff('file-2');
    expect(rejected).toBe('older');
    expect(state.getPendingDiff('file-2')).toBeNull();
  });

  it('clears history and pending diff', () => {
    const state = useVersionStore.getState();
    state.addVersion('file-3', 'human', 'edit', 'change', 'x', 'y');
    state.setPendingDiff('file-3', 'x', 'y', 'agent', 'diff');

    state.clearFileHistory('file-3');
    state.clearPendingDiff('file-3');
    expect(state.getFileHistory('file-3')).toEqual([]);
    expect(state.getPendingDiff('file-3')).toBeNull();
  });

  it('returns null for missing versions and latest on empty history', () => {
    const state = useVersionStore.getState();
    expect(state.getVersion('unknown', 'v-none')).toBeNull();
    expect(state.getLatestVersion('unknown')).toBeNull();
  });

  it('returns null for missing pending diffs and revert without snapshot', () => {
    const state = useVersionStore.getState();
    expect(state.acceptPendingDiff('none')).toBeNull();
    expect(state.rejectPendingDiff('none')).toBeNull();

    useVersionStore.setState({
      history: {
        'file-x': [
          {
            id: 'v-x',
            fileId: 'file-x',
            timestamp: 1,
            author: 'human',
            changeType: 'edit',
            summary: 'x',
            diffPatch: '[]',
          } as any,
        ],
      },
      pendingDiffs: {},
    });
    expect(useVersionStore.getState().revertToVersion('file-x', 'v-x')).toBeNull();
  });
});
