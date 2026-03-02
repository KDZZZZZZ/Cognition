import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timeline } from '../Timeline';

const mocks = vi.hoisted(() => ({
  toggleTimeline: vi.fn(),
  setTabMode: vi.fn(),
  setActiveDiff: vi.fn(),
  findFile: vi.fn(() => ({ id: 'file-1', type: 'md' })),
  apiGetFileVersions: vi.fn(),
  apiGetFileContent: vi.fn(),
  uiState: { timelineExpanded: true },
  fileState: { lastUpdated: 0 },
  paneState: {
    panes: [
      {
        id: 'pane-1',
        activeTabId: 'file-1',
        tabs: [{ id: 'file-1', type: 'md', name: 'note.md', mode: 'editor' }],
      },
    ],
    activePaneId: 'pane-1',
  } as any,
}));

vi.mock('../../../stores/uiStore', () => ({
  useUIStore: () => ({
    timelineExpanded: mocks.uiState.timelineExpanded,
    toggleTimeline: mocks.toggleTimeline,
  }),
}));

vi.mock('../../../stores/paneStore', () => ({
  usePaneStore: () => ({
    panes: mocks.paneState.panes,
    activePaneId: mocks.paneState.activePaneId,
    setTabMode: mocks.setTabMode,
  }),
}));

vi.mock('../../../stores/fileTreeStore', () => ({
  useFileTreeStore: () => ({ findFile: mocks.findFile }),
}));

vi.mock('../../../stores/apiStore', () => ({
  useFileStore: () => ({ lastUpdated: mocks.fileState.lastUpdated }),
}));

vi.mock('../../../stores/diffStore', () => ({
  useDiffStore: () => ({ setActiveDiff: mocks.setActiveDiff }),
}));

vi.mock('../../../api/client', () => ({
  api: {
    getFileVersions: (...args: any[]) => mocks.apiGetFileVersions(...args),
    getFileContent: (...args: any[]) => mocks.apiGetFileContent(...args),
  },
}));

describe('Timeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.uiState.timelineExpanded = true;
    mocks.fileState.lastUpdated = Date.now();
    mocks.findFile.mockReturnValue({ id: 'file-1', type: 'md' });
    mocks.paneState = {
      panes: [
        {
          id: 'pane-1',
          activeTabId: 'file-1',
          tabs: [{ id: 'file-1', type: 'md', name: 'note.md', mode: 'editor' }],
        },
      ],
      activePaneId: 'pane-1',
    };

    mocks.apiGetFileVersions.mockResolvedValue({
      success: true,
      data: {
        versions: [
          {
            id: 'v1',
            timestamp: new Date().toISOString(),
            author: 'human',
            summary: 'Edit note',
            change_type: 'edit',
            context_snapshot: 'old-content',
          },
        ],
      },
    });
    mocks.apiGetFileContent.mockResolvedValue({
      success: true,
      data: { content: 'new-content' },
    });
  });

  it('loads timeline versions and opens diff on click', async () => {
    render(<Timeline />);

    await waitFor(() => {
      expect(screen.getByText('Edit note')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Edit note'));

    await waitFor(() => {
      expect(mocks.setActiveDiff).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 'file-1', versionId: 'v1' })
      );
      expect(mocks.setTabMode).toHaveBeenCalledWith('pane-1', 'file-1', 'diff');
    });
  });

  it('handles session tabs and refresh errors', async () => {
    mocks.paneState = {
      panes: [
        {
          id: 'pane-1',
          activeTabId: 'session-1',
          tabs: [{ id: 'session-1', type: 'session', name: 'chat', mode: 'editor' }],
        },
      ],
      activePaneId: 'pane-1',
    };
    mocks.findFile.mockReturnValueOnce({ id: 'session-1', type: 'session' });

    const { rerender } = render(<Timeline />);
    expect(screen.getByText('Version history is shown for notes and PDFs. Open one to inspect changes.')).toBeInTheDocument();

    mocks.paneState = {
      panes: [
        {
          id: 'pane-1',
          activeTabId: 'file-1',
          tabs: [{ id: 'file-1', type: 'md', name: 'note.md', mode: 'editor' }],
        },
      ],
      activePaneId: 'pane-1',
    };
    mocks.apiGetFileVersions.mockResolvedValue({ success: false, error: 'boom' });

    rerender(<Timeline />);

    const refreshBtn = screen.getByTitle('Refresh timeline');
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });

  it('renders no-active-file and collapsed branches', () => {
    mocks.paneState = {
      panes: [],
      activePaneId: 'missing-pane',
    };

    const { rerender } = render(<Timeline />);
    expect(screen.getByText('No file active')).toBeInTheDocument();

    mocks.uiState.timelineExpanded = false;
    rerender(<Timeline />);
    expect(screen.getByText('Timeline')).toBeInTheDocument();
    expect(screen.queryByText('No file active')).not.toBeInTheDocument();
  });

  it('covers multi change types, refresh success and click guard branches', async () => {
    mocks.apiGetFileVersions.mockResolvedValue({
      success: true,
      data: {
        versions: [
          { id: 've', timestamp: new Date().toISOString(), author: 'human', summary: 'edit item', change_type: 'edit', context_snapshot: 'a' },
          { id: 'vr', timestamp: new Date().toISOString(), author: 'agent', summary: 'refactor item', change_type: 'refactor', context_snapshot: 'b' },
          { id: 'vc', timestamp: new Date().toISOString(), author: 'agent', summary: 'create item', change_type: 'create', context_snapshot: 'c' },
          { id: 'vd', timestamp: new Date().toISOString(), author: 'agent', summary: 'delete item', change_type: 'delete', context_snapshot: 'd' },
          { id: 'vx', timestamp: new Date().toISOString(), author: 'agent', summary: 'other item', change_type: 'other', context_snapshot: 'e' },
        ],
      },
    });

    const { rerender } = render(<Timeline />);
    await waitFor(() => {
      expect(screen.getByText('refactor item')).toBeInTheDocument();
      expect(screen.getByText('create item')).toBeInTheDocument();
      expect(screen.getByText('delete item')).toBeInTheDocument();
      expect(screen.getByText('other item')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Refresh timeline'));
    await waitFor(() => {
      expect(mocks.apiGetFileVersions).toHaveBeenCalled();
    });

    mocks.apiGetFileContent.mockResolvedValueOnce({ success: false });
    fireEvent.click(screen.getByText('edit item'));
    await waitFor(() => {
      expect(mocks.setActiveDiff).not.toHaveBeenCalled();
    });

    mocks.apiGetFileContent.mockResolvedValueOnce({ success: true, data: { content: 'new-content' } });
    mocks.apiGetFileVersions.mockResolvedValueOnce({ success: false });
    fireEvent.click(screen.getByText('refactor item'));
    await waitFor(() => {
      expect(mocks.setActiveDiff).not.toHaveBeenCalled();
    });

    mocks.apiGetFileContent.mockResolvedValueOnce({ success: true, data: { content: 'new-content' } });
    mocks.apiGetFileVersions.mockResolvedValueOnce({ success: true, data: { versions: [] } });
    fireEvent.click(screen.getByText('create item'));
    await waitFor(() => {
      expect(mocks.setActiveDiff).not.toHaveBeenCalled();
    });

    rerender(<Timeline />);
    expect(screen.getByText('edit item')).toBeInTheDocument();
  });
});
