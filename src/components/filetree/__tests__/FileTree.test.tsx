import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTree } from '../FileTree';

const m = vi.hoisted(() => ({
  toggleFolder: vi.fn(),
  createFile: vi.fn(),
  createFolder: vi.fn(),
  deleteFile: vi.fn(),
  renameFile: vi.fn(),
  moveFile: vi.fn(),
  loadFilesFromBackend: vi.fn(),
  openTab: vi.fn(),
  createPane: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  fileTreeState: {} as any,
  paneState: {} as any,
}));

vi.mock('../../../stores/fileTreeStore', () => ({
  useFileTreeStore: () => m.fileTreeState,
}));

vi.mock('../../../stores/paneStore', () => ({
  usePaneStore: Object.assign(
    () => ({
      panes: m.paneState.panes,
      activePaneId: m.paneState.activePaneId,
      openTab: m.openTab,
      createPane: m.createPane,
    }),
    {
      getState: () => ({
        panes: m.paneState.panes,
        activePaneId: m.paneState.activePaneId,
      }),
    }
  ),
}));

vi.mock('../../../stores/apiStore', () => ({
  useFileStore: () => ({ uploadFile: m.uploadFile, downloadFile: m.downloadFile }),
}));

vi.mock('../../ui/FileIcon', () => ({
  FileIcon: ({ type }: { type: string }) => <span>icon-{type}</span>,
}));

vi.mock('../../ui/NewItemDialog', () => ({
  NewItemDialog: ({ isOpen, onClose, onCreate }: { isOpen: boolean; onClose: () => void; onCreate: (name: string) => void }) =>
    isOpen ? (
      <div>
        <button onClick={() => onCreate('folderA/fileA.md')}>dialog-create</button>
        <button onClick={onClose}>dialog-close</button>
      </div>
    ) : null,
}));

vi.mock('../ContextMenu', () => ({
  ContextMenu: ({ onClose, onNewFile, onNewFolder, onNewSession, onRename, onDelete, onDownload, onCopy, onPaste, onOpenInNewPane, file }: any) => (
    <div>
      <button onClick={() => onNewFile(file?.id)}>ctx-new-file</button>
      <button onClick={() => onNewSession(file?.id)}>ctx-new-session</button>
      <button onClick={() => onNewFolder(file?.id)}>ctx-new-folder</button>
      <button onClick={() => onRename(file)}>ctx-rename</button>
      <button onClick={() => onDelete(file?.id || 'root')}>ctx-delete</button>
      <button onClick={() => onDownload(file?.id || 'root')}>ctx-download</button>
      <button onClick={() => onCopy(file)}>ctx-copy</button>
      <button onClick={() => onPaste(file?.id)}>ctx-paste</button>
      <button onClick={() => onOpenInNewPane(file)}>ctx-new-pane</button>
      <button onClick={onClose}>ctx-close</button>
    </div>
  ),
}));

function createDataTransfer(seed: Record<string, string> = {}) {
  const data = { ...seed };
  return {
    setData: vi.fn((type: string, value: string) => {
      data[type] = value;
    }),
    getData: vi.fn((type: string) => data[type] || ''),
    effectAllowed: 'move',
    dropEffect: 'move',
  };
}

function mockRect(el: Element, height: number, top = 0) {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        top,
        left: 0,
        right: 100,
        bottom: top + height,
        width: 100,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect,
  });
}

describe('FileTree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    m.createFile.mockResolvedValue('new-file-id');
    m.createFolder.mockResolvedValue('new-folder-id');
    m.deleteFile.mockResolvedValue(undefined);
    m.moveFile.mockResolvedValue(undefined);
    m.loadFilesFromBackend.mockResolvedValue(undefined);
    m.uploadFile.mockResolvedValue('uploaded-id');
    m.downloadFile.mockResolvedValue(undefined);

    m.paneState = {
      panes: [
        { id: 'pane-1', activeTabId: null, tabs: [] },
        { id: 'pane-2', activeTabId: null, tabs: [] },
      ],
      activePaneId: 'pane-1',
    };

    m.fileTreeState = {
      fileTree: [
        {
          id: 'folder-1',
          name: 'Folder',
          type: 'folder',
          isOpen: true,
          children: [{ id: 'file-1', name: 'doc.md', type: 'md', isOpen: false, children: [] }],
        },
      ],
      toggleFolder: m.toggleFolder,
      createFile: m.createFile,
      createFolder: m.createFolder,
      deleteFile: m.deleteFile,
      renameFile: m.renameFile,
      moveFile: m.moveFile,
      loading: false,
      loadFilesFromBackend: m.loadFilesFromBackend,
    };
  });

  it('loads files and handles open/toggle/refresh', async () => {
    render(<FileTree />);

    await waitFor(() => {
      expect(m.loadFilesFromBackend).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText('Folder'));
    expect(m.toggleFolder).toHaveBeenCalledWith('folder-1');

    fireEvent.click(screen.getByText('doc.md'));
    expect(m.openTab).toHaveBeenCalledWith(
      'pane-1',
      expect.objectContaining({ id: 'file-1', type: 'md', mode: 'editor' })
    );

    fireEvent.click(screen.getByTitle('Refresh'));
    await waitFor(() => {
      expect(m.loadFilesFromBackend).toHaveBeenCalledTimes(2);
    });
  });

  it('opens quick action menu and creates/uploads items', async () => {
    render(<FileTree />);

    fireEvent.click(screen.getByTitle('Add at current path'));
    fireEvent.click(screen.getByText('New File'));
    fireEvent.click(screen.getByText('dialog-create'));

    await waitFor(() => {
      expect(m.createFolder).toHaveBeenCalled();
      expect(m.createFile).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByTitle('Add at current path'));
    fireEvent.click(screen.getByText('Upload File'));

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'hello.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(m.uploadFile).toHaveBeenCalled();
      expect(m.loadFilesFromBackend).toHaveBeenCalled();
    });
  });

  it('opens context menu and triggers actions', async () => {
    render(<FileTree />);

    fireEvent.contextMenu(screen.getByText('doc.md'));

    fireEvent.click(screen.getByText('ctx-rename'));
    fireEvent.click(screen.getByText('ctx-delete'));
    fireEvent.click(screen.getByText('ctx-download'));
    fireEvent.click(screen.getByText('ctx-copy'));
    fireEvent.click(screen.getByText('ctx-paste'));
    fireEvent.click(screen.getByText('ctx-new-pane'));

    await waitFor(() => {
      expect(m.deleteFile).toHaveBeenCalledWith('file-1');
      expect(m.downloadFile).toHaveBeenCalledWith('file-1');
      expect(m.createPane).toHaveBeenCalled();
      expect(m.openTab).toHaveBeenCalledWith('pane-2', expect.objectContaining({ id: 'file-1', type: 'md' }));
    });
  });

  it('renders loading and empty states', () => {
    m.fileTreeState = {
      ...m.fileTreeState,
      loading: true,
      fileTree: [],
    };
    const { rerender } = render(<FileTree />);
    expect(screen.getByText('Loading files...')).toBeInTheDocument();

    m.fileTreeState = {
      ...m.fileTreeState,
      loading: false,
      fileTree: [],
    };
    rerender(<FileTree />);
    expect(screen.getByText(/No files yet\./)).toBeInTheDocument();
  });

  it('supports drag-and-drop move: inside, before, after and same-target no-op', async () => {
    m.fileTreeState = {
      ...m.fileTreeState,
      fileTree: [
        {
          id: 'folder-1',
          name: 'Folder',
          type: 'folder',
          isOpen: true,
          children: [{ id: 'file-1', name: 'doc.md', type: 'md', isOpen: false, children: [] }],
        },
        { id: 'file-2', name: 'later.md', type: 'md', isOpen: false, children: [] },
      ],
      loading: false,
    };

    render(<FileTree />);

    const folderRow = screen.getByText('Folder').closest('[draggable="true"]') as HTMLElement;
    const docRow = screen.getByText('doc.md').closest('[draggable="true"]') as HTMLElement;
    const laterRow = screen.getByText('later.md').closest('[draggable="true"]') as HTMLElement;
    mockRect(folderRow, 100, 0);
    mockRect(laterRow, 100, 0);

    const dragInside = createDataTransfer();
    fireEvent.dragStart(docRow, { dataTransfer: dragInside });
    fireEvent.dragOver(folderRow, { dataTransfer: dragInside, clientY: 55 });
    fireEvent.drop(folderRow, { dataTransfer: dragInside, clientY: 55 });
    await waitFor(() => {
      expect(m.moveFile).toHaveBeenCalledWith('file-1', 'folder-1');
    });

    const dragBefore = createDataTransfer();
    fireEvent.dragStart(docRow, { dataTransfer: dragBefore });
    const overBefore = createEvent.dragOver(laterRow, { dataTransfer: dragBefore });
    Object.defineProperty(overBefore, 'clientY', { value: 10 });
    fireEvent(laterRow, overBefore);
    fireEvent.drop(laterRow, { dataTransfer: dragBefore, clientY: 10 });
    await waitFor(() => {
      expect(m.moveFile).toHaveBeenCalledWith('file-1', undefined, 'file-2', 'before');
    });

    const dragAfter = createDataTransfer();
    fireEvent.dragStart(docRow, { dataTransfer: dragAfter });
    const overAfter = createEvent.dragOver(laterRow, { dataTransfer: dragAfter });
    Object.defineProperty(overAfter, 'clientY', { value: 90 });
    fireEvent(laterRow, overAfter);
    fireEvent.drop(laterRow, { dataTransfer: dragAfter, clientY: 90 });
    await waitFor(() => {
      expect(m.moveFile).toHaveBeenCalledWith('file-1', undefined, 'file-2', 'after');
    });

    const sameTarget = createDataTransfer();
    fireEvent.dragStart(laterRow, { dataTransfer: sameTarget });
    fireEvent.drop(laterRow, { dataTransfer: sameTarget, clientY: 90 });
    expect(m.moveFile).toHaveBeenCalledTimes(3);
  });

  it('handles root context menu, delete confirm false, and upload with empty selection', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    const { container } = render(<FileTree />);

    const treeRoot = container.querySelector('.flex-1.overflow-y-auto.py-2.relative') as HTMLElement;
    fireEvent.contextMenu(treeRoot);
    fireEvent.click(screen.getByText('ctx-new-folder'));
    fireEvent.click(screen.getByText('dialog-create'));
    await waitFor(() => {
      expect(m.createFolder).toHaveBeenCalled();
    });

    fireEvent.contextMenu(screen.getByText('doc.md'));
    fireEvent.click(screen.getByText('ctx-delete'));
    expect(confirmSpy).toHaveBeenCalled();
    expect(m.deleteFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('Add at current path'));
    fireEvent.click(screen.getByText('Upload File'));
    const input = document.body.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [] } });
    expect(m.uploadFile).not.toHaveBeenCalled();
  });

  it('handles rename/session-path create and clipboard paste for folder/file', async () => {
    render(<FileTree />);

    fireEvent.contextMenu(screen.getByText('doc.md'));
    fireEvent.click(screen.getByText('ctx-rename'));
    fireEvent.click(screen.getByText('dialog-create'));
    await waitFor(() => {
      expect(m.renameFile).toHaveBeenCalledWith('file-1', 'folderA/fileA.md');
    });

    fireEvent.click(screen.getByTitle('Add at current path'));
    fireEvent.click(screen.getByText('New Session'));
    fireEvent.click(screen.getByText('dialog-create'));
    await waitFor(() => {
      expect(m.createFile).toHaveBeenCalledWith('fileA.md', 'session', 'new-folder-id');
    });

    fireEvent.contextMenu(screen.getByText('Folder'));
    fireEvent.click(screen.getByText('ctx-copy'));
    const treeRoot = document.querySelector('.flex-1.overflow-y-auto.py-2.relative') as HTMLElement;
    fireEvent.contextMenu(treeRoot);
    fireEvent.click(screen.getByText('ctx-paste'));
    await waitFor(() => {
      expect(m.createFolder).toHaveBeenCalledWith('Folder (copy)', undefined);
    });

    fireEvent.contextMenu(screen.getByText('doc.md'));
    fireEvent.click(screen.getByText('ctx-copy'));
    fireEvent.contextMenu(treeRoot);
    fireEvent.click(screen.getByText('ctx-paste'));
    await waitFor(() => {
      expect(m.createFile).toHaveBeenCalledWith('doc (copy).md', 'md', undefined);
    });
  });

  it('covers pane-id fallback open, closed-folder icon branch, active row class and session paste', async () => {
    m.paneState = {
      panes: [
        { id: 'pane-a', activeTabId: 'file-1', tabs: [] },
        { id: 'pane-b', activeTabId: null, tabs: [] },
      ],
      activePaneId: null,
    };
    m.fileTreeState = {
      ...m.fileTreeState,
      fileTree: [
        { id: 'folder-closed', name: 'Closed', type: 'folder', isOpen: false, children: [] },
        { id: 'file-1', name: 'active.md', type: 'md', isOpen: false, children: [] },
        { id: 'session-1', name: 'Chat Session', type: 'session', isOpen: false, children: [] },
      ],
      loading: false,
    };

    const { container, rerender } = render(<FileTree />);
    fireEvent.click(screen.getByText('active.md'));
    expect(m.openTab).toHaveBeenCalledWith(
      'pane-a',
      expect.objectContaining({ id: 'file-1', type: 'md' })
    );

    m.paneState = {
      ...m.paneState,
      activePaneId: 'pane-a',
    };
    rerender(<FileTree />);
    const activeRow = screen.getByText('active.md').closest('[draggable="true"]') as HTMLElement;
    expect(activeRow.className).toContain('bg-theme-text/20');

    fireEvent.contextMenu(screen.getByText('Chat Session'));
    fireEvent.click(screen.getByText('ctx-copy'));
    const treeRoot = container.querySelector('.flex-1.overflow-y-auto.py-2.relative') as HTMLElement;
    fireEvent.contextMenu(treeRoot);
    fireEvent.click(screen.getByText('ctx-paste'));
    await waitFor(() => {
      expect(m.createFile).toHaveBeenCalledWith('Chat Session (copy)', 'session', undefined);
    });
  });
});
