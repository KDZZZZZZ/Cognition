import { create } from 'zustand';

interface DiffComparison {
  fileId: string;
  versionId: string; // The version to compare against
  oldContent: string;
  newContent: string;
  versionLabel: string; // e.g., "v3 vs v2"
}

interface DiffState {
  activeDiff: DiffComparison | null;
  setActiveDiff: (diff: DiffComparison | null) => void;
  clearDiff: () => void;
}

export const useDiffStore = create<DiffState>((set) => ({
  activeDiff: null,

  setActiveDiff: (diff) => set({ activeDiff: diff }),

  clearDiff: () => set({ activeDiff: null }),
}));
