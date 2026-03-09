import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    listFiles: vi.fn(),
    uploadFile: vi.fn(),
    getFileContent: vi.fn(),
    updateFileContent: vi.fn(),
    deleteFile: vi.fn(),
    getFileChunks: vi.fn(),
    getFileVersions: vi.fn(),
    downloadFile: vi.fn(),
  },
}));

vi.mock('../../api/client', () => ({
  api: mockApi,
}));

import { useFileStore } from '../apiStore';

describe('useFileStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFileStore.setState({
      files: [],
      selectedFile: null,
      fileContents: {},
      fileChunks: {},
      fileVersions: {},
      loading: false,
      error: null,
      lastUpdated: 0,
    });
  });

  it('loads files successfully and handles failed payload', async () => {
    mockApi.listFiles.mockResolvedValueOnce({
      success: true,
      data: { files: [{ id: 'f1', name: 'a.md' }] },
    });
    await useFileStore.getState().loadFiles();
    expect(useFileStore.getState().files).toHaveLength(1);

    mockApi.listFiles.mockResolvedValueOnce({ success: false, error: 'boom' });
    await useFileStore.getState().loadFiles();
    expect(useFileStore.getState().error).toBe('boom');
  });

  it('uploads and refreshes list', async () => {
    mockApi.uploadFile.mockResolvedValueOnce({
      success: true,
      data: { file_id: 'f2', index_status: { parse_status: 'ready', embedding_status: 'ready' } },
    });
    mockApi.listFiles.mockResolvedValueOnce({ success: true, data: { files: [{ id: 'f2', name: 'n.md' }] } });
    const file = new File(['hello'], 'n.md', { type: 'text/markdown' });

    const id = await useFileStore.getState().uploadFile(file);
    expect(id).toBe('f2');
    expect(useFileStore.getState().files[0].id).toBe('f2');
  });

  it('returns null when upload fails', async () => {
    mockApi.uploadFile.mockResolvedValueOnce({ success: false, error: 'upload failed' });
    const file = new File(['hello'], 'n.md', { type: 'text/markdown' });
    const id = await useFileStore.getState().uploadFile(file);
    expect(id).toBeNull();
    expect(useFileStore.getState().error).toBe('upload failed');
  });

  it('treats incomplete OCR or embedding as upload failure', async () => {
    mockApi.uploadFile.mockResolvedValueOnce({
      success: true,
      data: {
        file_id: 'f-incomplete',
        index_status: {
          parse_status: 'ready',
          embedding_status: 'disabled',
          last_error: 'embedding provider unavailable',
        },
      },
    });

    const file = new File(['hello'], 'n.pdf', { type: 'application/pdf' });
    const id = await useFileStore.getState().uploadFile(file);

    expect(id).toBeNull();
    expect(useFileStore.getState().error).toContain('OCR/embedding did not complete');
    expect(mockApi.listFiles).not.toHaveBeenCalled();
  });

  it('caches content and updates file content', async () => {
    mockApi.getFileContent.mockResolvedValueOnce({ success: true, data: { content: 'abc' } });
    const content = await useFileStore.getState().getFileContent('f1');
    expect(content).toBe('abc');
    expect(await useFileStore.getState().getFileContent('f1')).toBe('abc');
    expect(mockApi.getFileContent).toHaveBeenCalledTimes(1);

    useFileStore.getState().setFileContent('f1', 'xyz');
    expect(useFileStore.getState().fileContents.f1).toBe('xyz');
  });

  it('updates file content and refreshes files/versions', async () => {
    mockApi.updateFileContent.mockResolvedValueOnce({ success: true });
    mockApi.listFiles.mockResolvedValueOnce({ success: true, data: { files: [] } });
    mockApi.getFileVersions.mockResolvedValueOnce({ success: true, data: { versions: [] } });
    const ok = await useFileStore.getState().updateFileContent('f1', 'next');
    expect(ok).toBe(true);

    mockApi.updateFileContent.mockResolvedValueOnce({ success: false });
    expect(await useFileStore.getState().updateFileContent('f1', 'next')).toBe(false);
  });

  it('loads chunks and versions and supports delete', async () => {
    useFileStore.setState({
      files: [{ id: 'f1', name: 'a', type: 'md', size: 1, created_at: '', updated_at: '' }],
      selectedFile: { id: 'f1', name: 'a', type: 'md', size: 1, created_at: '', updated_at: '' },
      fileContents: { f1: 'x' },
      fileChunks: { f1: [{ id: 'c1', file_id: 'f1', page: 1, chunk_index: 0, content: 'c' }] },
      fileVersions: { f1: [{ id: 'v1', file_id: 'f1', author: 'human', change_type: 'edit', summary: 's', timestamp: '' }] },
      loading: false,
      error: null,
      lastUpdated: 0,
    });

    expect((await useFileStore.getState().getFileChunks('f1')).length).toBe(1);
    mockApi.getFileChunks.mockResolvedValueOnce({
      success: true,
      data: { chunks: [{ id: 'c2', file_id: 'f2', page: 1, chunk_index: 0, content: 'd' }] },
    });
    expect((await useFileStore.getState().getFileChunks('f2')).length).toBe(1);

    mockApi.getFileVersions.mockResolvedValueOnce({
      success: true,
      data: { versions: [{ id: 'v2', file_id: 'f2', author: 'agent', change_type: 'edit', summary: 's', timestamp: '' }] },
    });
    expect((await useFileStore.getState().getFileVersions('f2')).length).toBe(1);

    mockApi.deleteFile.mockResolvedValueOnce({ success: true });
    await useFileStore.getState().deleteFile('f1');
    expect(useFileStore.getState().files).toHaveLength(0);
    expect(useFileStore.getState().selectedFile).toBeNull();
  });

  it('downloads file blob and triggers browser download', async () => {
    const blob = new Blob(['file']);
    mockApi.downloadFile.mockResolvedValueOnce(blob);
    useFileStore.setState({
      files: [{ id: 'f1', name: 'file.md', type: 'md', size: 1, created_at: '', updated_at: '' }],
      selectedFile: null,
      fileContents: {},
      fileChunks: {},
      fileVersions: {},
      loading: false,
      error: null,
      lastUpdated: 0,
    });

    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:abc');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.fn();
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue({
      click,
      set href(_v: string) {},
      set download(_v: string) {},
    } as unknown as HTMLAnchorElement);

    await useFileStore.getState().downloadFile('f1');

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:abc');
    createElement.mockRestore();
  });

  it('covers generic fallback errors and selected-file retention on delete', async () => {
    mockApi.listFiles.mockResolvedValueOnce({ success: false });
    await useFileStore.getState().loadFiles();
    expect(useFileStore.getState().error).toBe('Failed to load files');

    mockApi.uploadFile.mockResolvedValueOnce({ success: false });
    const file = new File(['a'], 'a.md', { type: 'text/markdown' });
    const uploaded = await useFileStore.getState().uploadFile(file);
    expect(uploaded).toBeNull();
    expect(useFileStore.getState().error).toBe('Failed to upload file');

    useFileStore.setState({
      files: [
        { id: 'f1', name: 'a', type: 'md', size: 1, created_at: '', updated_at: '' },
        { id: 'f2', name: 'b', type: 'md', size: 1, created_at: '', updated_at: '' },
      ],
      selectedFile: { id: 'f2', name: 'b', type: 'md', size: 1, created_at: '', updated_at: '' },
      fileContents: {},
      fileChunks: {},
      fileVersions: {},
      loading: false,
      error: null,
      lastUpdated: 0,
    });
    mockApi.deleteFile.mockResolvedValueOnce({ success: true });
    await useFileStore.getState().deleteFile('f1');
    expect(useFileStore.getState().selectedFile?.id).toBe('f2');
  });
});
