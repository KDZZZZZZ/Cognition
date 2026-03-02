import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../client';

function mockJson(value: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => value,
  });
}

describe('api client', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls file and session endpoints with expected payloads', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => mockJson({ success: true, data: {} }) as never);

    await api.health();
    await api.listFiles({ tree: true, parentId: null });
    await api.uploadFile(new File(['x'], 'x.md', { type: 'text/markdown' }), 'parent');
    await api.createFolder('Docs', null);
    await api.getFile('f1');
    await api.getFileContent('f1');
    await api.updateFileContent('f1', 'content', 'human', 'summary', 'edit');
    await api.createFile('new.md', '# title', null);
    await api.getFileChunks('f1', 2);
    await api.importWebUrl({ url: 'https://example.com', title: 'Example' });
    await api.getFileSegments('f1', { page: 1, section: 's', bbox: [1, 2, 3, 4], segmentType: 'text', source: 'pdf' });
    await api.reindexFile('f1', 'all');
    await api.getFileIndexStatus('f1');
    await api.getFileVersions('f1');
    await api.deleteFile('f1');
    await api.moveFile('f1', null);
    await api.createDiffEvent('f1', 'new');
    await api.getPendingDiffEvent('f1');
    await api.updateDiffLineDecision('f1', 'e1', 'l1', 'accepted');
    await api.finalizeDiffEvent('f1', 'e1', { finalContent: 'ok', summary: 'done', author: 'agent' });
    await api.getSession('s1');
    await api.listSessions(10);
    await api.createSession('Session', { id: 's1', permissions: { f1: 'read' } });
    await api.getSessionMessages('s1', 20);
    await api.bulkUpdatePermissions('s1', { f1: 'write' });
    await api.deleteSession('s1');
    await api.updateViewport('s1', 'f1', 3, 10, 25);
    await api.getViewport('s1');

    expect(fetchMock).toHaveBeenCalled();
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes('/api/v1/files/upload'))).toBe(true);
    expect(urls.some((url) => url.includes('/api/v1/chat/sessions/s1/messages'))).toBe(true);
  });

  it('supports chat completion, cancellation and prompt answer', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => mockJson({ success: true, data: {} }) as never);
    const controller = new AbortController();

    await api.chatCompletion(
      'session-1',
      'hello',
      ['f1'],
      'kimi-latest',
      true,
      {
        permissions: { f1: 'write' },
        taskId: 't1',
        signal: controller.signal,
        activeFileId: 'f1',
        activePage: 2,
        compactMode: 'auto',
      }
    );
    await api.cancelTask('session-1', 't1');
    await api.answerTaskPrompt('session-1', 't1', {
      promptId: 'p1',
      selectedOptionId: 'o1',
      otherText: 'other',
    });
    await api.updatePermissions('session-1', 'f1', 'read');

    const postCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/v1/chat/completions'));
    expect(postCall).toBeTruthy();
    const init = postCall?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('compact_mode');

    const permissionCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/api/v1/chat/sessions/session-1/permissions?file_id=f1&permission=read')
    );
    expect(permissionCall).toBeTruthy();
  });

  it('returns blob for file downloads', async () => {
    const blob = new Blob(['x']);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      blob: async () => blob,
    } as Response);

    const result = await api.downloadFile('f-download');
    expect(result).toBe(blob);
  });

  it('covers default and omitted optional payload branches', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => mockJson({ success: true }) as never);

    await api.listFiles();
    await api.listFiles({ parentId: 'parent-1' });
    await api.uploadFile(new File(['x'], 'x.md', { type: 'text/markdown' }));
    await api.getFileChunks('f-no-page');
    await api.getFileSegments('f1', { bbox: [1, 2, 3] as any });
    await api.chatCompletion('session-2', 'minimal');
    await api.finalizeDiffEvent('f1', 'e1');
    await api.createSession('No Options');

    const completionCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/v1/chat/completions'));
    expect(completionCall).toBeTruthy();
    const completionBody = String((completionCall?.[1] as RequestInit).body || '');
    expect(completionBody.includes('permissions')).toBe(false);
    expect(completionBody.includes('task_id')).toBe(false);
    expect(completionBody.includes('active_file_id')).toBe(false);

    const sessionCall = fetchMock.mock.calls.find((call) => String(call[0]).includes('/api/v1/chat/sessions'));
    expect(sessionCall).toBeTruthy();
    expect(String((sessionCall?.[1] as RequestInit).body || '')).toContain('"permissions":{}');
  });

  it('returns a usable API error when the server responds with plain text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => {
        throw new SyntaxError('Unexpected token I');
      },
      text: async () => 'Internal Server Error',
    } as unknown as Response);

    const response = await api.updateFileContent('f1', 'content');
    expect(response).toEqual({
      success: false,
      error: 'Internal Server Error',
    });
  });
});
