import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { VersionNode, Author, DiffLine } from '../types';

// Pending diff state for real-time display
export interface PendingDiff {
  fileId: string;
  oldContent: string;
  newContent: string;
  author: Author;
  summary: string;
  timestamp: number;
}

interface VersionState {
  history: Record<string, VersionNode[]>; // fileId → versions
  pendingDiffs: Record<string, PendingDiff>; // fileId → pending diff (for real-time display)

  // Actions
  addVersion: (
    fileId: string,
    author: Author,
    changeType: VersionNode['changeType'],
    summary: string,
    oldContent: string,
    newContent: string
  ) => string; // returns version ID

  getFileHistory: (fileId: string) => VersionNode[];
  getVersion: (fileId: string, versionId: string) => VersionNode | null;
  getLatestVersion: (fileId: string) => VersionNode | null;

  revertToVersion: (fileId: string, versionId: string) => string | null; // returns content
  computeDiff: (oldContent: string, newContent: string) => DiffLine[];

  clearFileHistory: (fileId: string) => void;

  // Real-time diff management
  setPendingDiff: (
    fileId: string,
    oldContent: string,
    newContent: string,
    author: Author,
    summary: string
  ) => void;
  getPendingDiff: (fileId: string) => PendingDiff | null;
  acceptPendingDiff: (fileId: string) => string | null; // returns new content
  rejectPendingDiff: (fileId: string) => string | null; // returns old content
  clearPendingDiff: (fileId: string) => void;
  hasPendingDiff: (fileId: string) => boolean;
}

// Simple diff algorithm - computes line-by-line differences
function computeLineDiff(oldContent: string, newContent: string): DiffLine[] {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const result: DiffLine[] = [];

  // Simple LCS-based diff
  const lcs = computeLCS(oldLines, newLines);

  let oldIdx = 0;
  let newIdx = 0;
  let lineNum = 1;

  for (const match of lcs) {
    // Add removed lines (in old but not in LCS yet)
    while (oldIdx < match.oldIdx) {
      result.push({
        line: lineNum++,
        content: oldLines[oldIdx],
        type: 'remove',
      });
      oldIdx++;
    }

    // Add new lines (in new but not in LCS yet)
    while (newIdx < match.newIdx) {
      result.push({
        line: lineNum++,
        content: newLines[newIdx],
        type: 'add',
      });
      newIdx++;
    }

    // Add matching line
    result.push({
      line: lineNum++,
      content: newLines[newIdx],
      type: 'normal',
    });
    oldIdx++;
    newIdx++;
  }

  // Add remaining removed lines
  while (oldIdx < oldLines.length) {
    result.push({
      line: lineNum++,
      content: oldLines[oldIdx],
      type: 'remove',
    });
    oldIdx++;
  }

  // Add remaining new lines
  while (newIdx < newLines.length) {
    result.push({
      line: lineNum++,
      content: newLines[newIdx],
      type: 'add',
    });
    newIdx++;
  }

  return result;
}

interface LCSMatch {
  oldIdx: number;
  newIdx: number;
}

function computeLCS(oldLines: string[], newLines: string[]): LCSMatch[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Build LCS table
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find matches
  const matches: LCSMatch[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      matches.unshift({ oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return matches;
}

// Create a simple patch format
function createPatch(oldContent: string, newContent: string): string {
  const diff = computeLineDiff(oldContent, newContent);
  return JSON.stringify(diff);
}

export const useVersionStore = create<VersionState>()(
  persist(
    (set, get) => ({
      history: {},
      pendingDiffs: {},

      addVersion: (fileId, author, changeType, summary, oldContent, newContent) => {
        const versionId = `v_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const diffPatch = createPatch(oldContent, newContent);

        const newVersion: VersionNode = {
          id: versionId,
          fileId,
          timestamp: Date.now(),
          author,
          changeType,
          summary,
          diffPatch,
          contextSnapshot: newContent, // Store full content for easy revert
        };

        set((state) => ({
          history: {
            ...state.history,
            [fileId]: [...(state.history[fileId] || []), newVersion],
          },
        }));

        return versionId;
      },

      getFileHistory: (fileId) => {
        const versions = get().history[fileId] || [];
        // Return in reverse chronological order (newest first)
        return [...versions].reverse();
      },

      getVersion: (fileId, versionId) => {
        const versions = get().history[fileId] || [];
        return versions.find((v) => v.id === versionId) || null;
      },

      getLatestVersion: (fileId) => {
        const versions = get().history[fileId] || [];
        return versions.length > 0 ? versions[versions.length - 1] : null;
      },

      revertToVersion: (fileId, versionId) => {
        const version = get().getVersion(fileId, versionId);
        if (version?.contextSnapshot) {
          return version.contextSnapshot;
        }
        return null;
      },

      computeDiff: (oldContent, newContent) => {
        return computeLineDiff(oldContent, newContent);
      },

      clearFileHistory: (fileId) => {
        set((state) => {
          const { [fileId]: _, ...rest } = state.history;
          return { history: rest };
        });
      },

      // Real-time diff management
      setPendingDiff: (fileId, oldContent, newContent, author, summary) => {
        set((state) => ({
          pendingDiffs: {
            ...state.pendingDiffs,
            [fileId]: {
              fileId,
              oldContent,
              newContent,
              author,
              summary,
              timestamp: Date.now(),
            },
          },
        }));
      },

      getPendingDiff: (fileId) => {
        return get().pendingDiffs[fileId] || null;
      },

      acceptPendingDiff: (fileId) => {
        const pending = get().pendingDiffs[fileId];
        if (!pending) return null;

        // Add to version history
        get().addVersion(
          fileId,
          pending.author,
          'edit',
          pending.summary,
          pending.oldContent,
          pending.newContent
        );

        // Clear pending diff
        set((state) => {
          const { [fileId]: _, ...rest } = state.pendingDiffs;
          return { pendingDiffs: rest };
        });

        return pending.newContent;
      },

      rejectPendingDiff: (fileId) => {
        const pending = get().pendingDiffs[fileId];
        if (!pending) return null;

        const oldContent = pending.oldContent;

        // Clear pending diff
        set((state) => {
          const { [fileId]: _, ...rest } = state.pendingDiffs;
          return { pendingDiffs: rest };
        });

        return oldContent;
      },

      clearPendingDiff: (fileId) => {
        set((state) => {
          const { [fileId]: _, ...rest } = state.pendingDiffs;
          return { pendingDiffs: rest };
        });
      },

      hasPendingDiff: (fileId) => {
        return !!get().pendingDiffs[fileId];
      },
    }),
    {
      name: 'version-storage',
      partialize: (state) => ({
        history: state.history,
      }),
    }
  )
);
