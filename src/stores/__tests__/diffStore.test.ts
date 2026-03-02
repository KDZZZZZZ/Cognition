import { beforeEach, describe, expect, it } from 'vitest';
import { useDiffStore } from '../diffStore';

describe('useDiffStore', () => {
  beforeEach(() => {
    useDiffStore.setState({ activeDiff: null });
  });

  it('sets and clears active diff', () => {
    const state = useDiffStore.getState();
    state.setActiveDiff({
      fileId: 'f1',
      versionId: 'v1',
      oldContent: 'old',
      newContent: 'new',
      versionLabel: 'v1 vs v0',
    });

    expect(useDiffStore.getState().activeDiff?.fileId).toBe('f1');

    useDiffStore.getState().clearDiff();
    expect(useDiffStore.getState().activeDiff).toBeNull();
  });
});
