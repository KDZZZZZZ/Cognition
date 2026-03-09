import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApi, clearSessionMessages, clearSessionPermissions, closeTabInAllPanes } = vi.hoisted(() => ({
  mockApi: {
    listFiles: vi.fn(),
    listSessions: vi.fn(),
    createFile: vi.fn(),
    createSession: vi.fn(),
    createFolder: vi.fn(),
    deleteSession: vi.fn(),
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
  },
  clearSessionMessages: vi.fn(),
  clearSessionPermissions: vi.fn(),
  closeTabInAllPanes: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: mockApi,
}));

vi.mock('../chatStore', () => ({
  useChatStore: {
    getState: () => ({ clearSessionMessages }),
  },
}));

vi.mock('../sessionStore', () => ({
  useSessionStore: {
    getState: () => ({ clearSessionPermissions }),
  },
}));

vi.mock('../paneStore', () => ({
  usePaneStore: {
    getState: () => ({ closeTabInAllPanes }),
  },
}));

import { useFileTreeStore } from '../fileTreeStore';

describe('useFileTreeStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileTreeStore.setState({
      fileTree: [],
      localSessions: [],
      sessionLocations: {},
      loading: false,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads backend tree and merges local sessions', async () => {
    useFileTreeStore.setState({
      fileTree: [],
      localSessions: [{ id: 'local-s1', name: 'Local Session', type: 'session' }],
      sessionLocations: { 'local-s1': 'folder-a' },
      loading: false,
    });

    mockApi.listFiles.mockResolvedValueOnce({
      success: true,
      data: {
        files: [{ id: 'f1', name: 'a.md', type: 'md', children: [] }],
      },
    });
    mockApi.listSessions.mockResolvedValueOnce({
      success: true,
      data: {
        sessions: [{ id: 'remote-s1', name: 'Remote Session' }],
      },
    });

    await useFileTreeStore.getState().loadFilesFromBackend();
    const tree = useFileTreeStore.getState().fileTree;
    expect(tree.some((node) => node.id === 'f1')).toBe(true);
    expect(tree.some((node) => node.id === 'remote-s1')).toBe(true);
    expect(tree.some((node) => node.id === 'local-s1')).toBe(true);
  });

  it('places sessions inside folders and normalizes missing parents back to root', async () => {
    useFileTreeStore.setState({
      fileTree: [],
      localSessions: [{ id: 'local-s1', name: 'Local Session', type: 'session' }],
      sessionLocations: { 'local-s1': 'folder-1' },
      loading: false,
    });

    mockApi.listFiles.mockResolvedValueOnce({
      success: true,
      data: {
        files: [{ id: 'folder-1', name: 'Docs', type: 'folder', children: [] }],
      },
    });
    mockApi.listSessions.mockResolvedValueOnce({ success: true, data: { sessions: [] } });

    await useFileTreeStore.getState().loadFilesFromBackend();
    let folder = useFileTreeStore.getState().findFile('folder-1');
    expect(folder?.children?.some((child) => child.id === 'local-s1')).toBe(true);

    mockApi.listFiles.mockResolvedValueOnce({ success: true, data: { files: [] } });
    mockApi.listSessions.mockResolvedValueOnce({ success: true, data: { sessions: [] } });

    await useFileTreeStore.getState().loadFilesFromBackend();
    expect(useFileTreeStore.getState().fileTree.some((node) => node.id === 'local-s1')).toBe(true);
    expect(useFileTreeStore.getState().sessionLocations['local-s1']).toBeNull();
  });

  it('toggles folders and finds nodes', () => {
    useFileTreeStore.setState({
      fileTree: [{ id: 'folder-1', name: 'Folder', type: 'folder', isOpen: true, children: [] }],
      localSessions: [],
      loading: false,
    });
    useFileTreeStore.getState().toggleFolder('folder-1');
    expect(useFileTreeStore.getState().findFile('folder-1')?.isOpen).toBe(false);
  });

  it('creates markdown files and folders through backend', async () => {
    mockApi.createFile.mockResolvedValueOnce({ success: true, data: { file_id: 'f-new' } });
    mockApi.listFiles.mockResolvedValue({ success: true, data: { files: [] } });
    mockApi.listSessions.mockResolvedValue({ success: true, data: { sessions: [] } });
    expect(await useFileTreeStore.getState().createFile('x.md', 'md')).toBe('f-new');

    mockApi.createFolder.mockResolvedValueOnce({ success: true, data: { folder_id: 'd1' } });
    expect(await useFileTreeStore.getState().createFolder('docs')).toBe('d1');
  });

  it('creates session locally and syncs preferred backend id', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-1' });
    mockApi.createSession.mockResolvedValueOnce({
      success: true,
      data: { id: 'uuid-1', name: 'S' },
    });
    useFileTreeStore.setState({
      fileTree: [{ id: 'folder-1', name: 'Folder', type: 'folder', isOpen: true, children: [] }],
      localSessions: [],
      sessionLocations: {},
      loading: false,
    });
    const id = await useFileTreeStore.getState().createFile('S', 'session', 'folder-1');
    expect(id).toBe('uuid-1');
    expect(useFileTreeStore.getState().findFile('folder-1')?.children?.some((n) => n.id === 'uuid-1')).toBe(true);
    expect(useFileTreeStore.getState().sessionLocations['uuid-1']).toBe('folder-1');
  });

  it('renames, moves and deletes nodes', async () => {
    useFileTreeStore.setState({
      fileTree: [
        { id: 'session-folder', name: 'Folder', type: 'folder', isOpen: true, children: [{ id: 's1', name: 'Session 1', type: 'session' }] },
        { id: 'f2', name: 'File 2', type: 'md' },
      ],
      localSessions: [{ id: 's1', name: 'Session 1', type: 'session' }],
      sessionLocations: { s1: 'session-folder' },
      loading: false,
    });

    useFileTreeStore.getState().renameFile('s1', 'Renamed');
    expect(mockApi.createSession).toHaveBeenCalledWith('Renamed', { id: 's1' });
    expect(useFileTreeStore.getState().findFile('s1')?.name).toBe('Renamed');

    mockApi.moveFile.mockResolvedValueOnce({ success: true });
    mockApi.listFiles.mockResolvedValue({ success: true, data: { files: [] } });
    mockApi.listSessions.mockResolvedValue({ success: true, data: { sessions: [] } });
    await useFileTreeStore.getState().moveFile('f2', 'target-folder');
    expect(mockApi.moveFile).toHaveBeenCalledWith('f2', 'target-folder');

    mockApi.deleteSession.mockResolvedValueOnce({ success: true });
    await useFileTreeStore.getState().deleteFile('s1');
    expect(useFileTreeStore.getState().findFile('s1')).toBeNull();
    expect(clearSessionMessages).toHaveBeenCalledWith('s1');
    expect(clearSessionPermissions).toHaveBeenCalledWith('s1');
    expect(closeTabInAllPanes).toHaveBeenCalledWith('s1');

    mockApi.deleteFile.mockResolvedValueOnce({ success: true });
    await useFileTreeStore.getState().deleteFile('f2');
    expect(mockApi.deleteFile).toHaveBeenCalledWith('f2');
  });

  it('handles backend list fallbacks and missing children mapping', async () => {
    useFileTreeStore.setState({
      fileTree: [],
      localSessions: undefined as any,
      sessionLocations: {},
      loading: false,
    });
    mockApi.listFiles.mockResolvedValueOnce({
      success: true,
      data: {
        files: [{ id: 'f-no-children', name: 'plain.md', type: 'md' }],
      },
    });
    mockApi.listSessions.mockResolvedValueOnce({ success: false, error: 'down' });
    await useFileTreeStore.getState().loadFilesFromBackend();
    const node = useFileTreeStore.getState().findFile('f-no-children');
    expect(node?.children).toEqual([]);

    mockApi.listFiles.mockResolvedValueOnce({ success: false });
    mockApi.listSessions.mockResolvedValueOnce({ success: false });
    await useFileTreeStore.getState().loadFilesFromBackend();
    expect(useFileTreeStore.getState().fileTree).toEqual([]);
  });

  it('covers session creation fallback ids and local-session update branch', async () => {
    vi.stubGlobal('crypto', undefined as any);
    mockApi.createSession.mockRejectedValueOnce(new Error('session create down'));
    const generated = await useFileTreeStore.getState().createFile('Generated Session', 'session');
    expect(generated).toMatch(/^session_/);

    useFileTreeStore.setState({
      fileTree: [{ id: 'same-id', name: 'Old Name', type: 'session' }],
      localSessions: [{ id: 'same-id', name: 'Old Name', type: 'session' }],
      sessionLocations: { 'same-id': null },
      loading: false,
    });
    vi.stubGlobal('crypto', { randomUUID: () => 'same-id' });
    mockApi.createSession.mockResolvedValueOnce({
      success: true,
      data: { id: 'same-id', name: 'Updated Name' },
    });
    const same = await useFileTreeStore.getState().createFile('Updated Name', 'session');
    expect(same).toBe('same-id');
    expect(useFileTreeStore.getState().localSessions.find((s) => s.id === 'same-id')?.name).toBe('Updated Name');
  });

  it('covers createFolder null return, nested rename, and sibling-based move', async () => {
    mockApi.createFolder.mockResolvedValueOnce({ success: true, data: {} });
    expect(await useFileTreeStore.getState().createFolder('NoId')).toBeNull();

    useFileTreeStore.setState({
      fileTree: [
        {
          id: 'root-folder',
          name: 'Root',
          type: 'folder',
          isOpen: true,
          children: [{ id: 'nested', name: 'Deep.md', type: 'md', isOpen: false, children: [] }],
        },
      ],
      localSessions: [{ id: 'keep-session', name: 'Keep Session', type: 'session' }],
      sessionLocations: { 'keep-session': null },
      loading: false,
    });
    useFileTreeStore.getState().renameFile('nested', 'Renamed.md');
    expect(useFileTreeStore.getState().findFile('nested')?.name).toBe('Renamed.md');
    expect(useFileTreeStore.getState().localSessions[0].name).toBe('Keep Session');

    mockApi.moveFile.mockResolvedValueOnce({ success: true });
    mockApi.listFiles.mockResolvedValue({ success: true, data: { files: [] } });
    mockApi.listSessions.mockResolvedValue({ success: true, data: { sessions: [] } });
    await useFileTreeStore.getState().moveFile('nested', undefined, 'nested');
    expect(mockApi.moveFile).toHaveBeenCalledWith('nested', 'root-folder');

    mockApi.moveFile.mockResolvedValueOnce({ success: true });
    await useFileTreeStore.getState().moveFile('nested', undefined, 'missing-sibling');
    expect(mockApi.moveFile).toHaveBeenCalledWith('nested', null);
  });

  it('moves sessions between folders without backend file moves', async () => {
    useFileTreeStore.setState({
      fileTree: [
        { id: 'folder-a', name: 'Folder A', type: 'folder', isOpen: true, children: [] },
        { id: 'folder-b', name: 'Folder B', type: 'folder', isOpen: true, children: [{ id: 'session-1', name: 'Session 1', type: 'session' }] },
      ],
      localSessions: [{ id: 'session-1', name: 'Session 1', type: 'session' }],
      sessionLocations: { 'session-1': 'folder-b' },
      loading: false,
    });

    await useFileTreeStore.getState().moveFile('session-1', 'folder-a');

    expect(mockApi.moveFile).not.toHaveBeenCalled();
    expect(useFileTreeStore.getState().sessionLocations['session-1']).toBe('folder-a');
    expect(useFileTreeStore.getState().findFile('folder-a')?.children?.some((node) => node.id === 'session-1')).toBe(true);
  });
});
