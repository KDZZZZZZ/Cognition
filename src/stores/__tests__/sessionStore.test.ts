import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    updatePermissions: vi.fn(),
    getSession: vi.fn(),
    bulkUpdatePermissions: vi.fn(),
  },
}));

vi.mock('../../api/client', () => ({
  api: mockApi,
}));

import { useSessionStore } from '../sessionStore';

describe('useSessionStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({ permissions: {}, syncStatus: {} });
  });

  it('sets and reads permissions', () => {
    const state = useSessionStore.getState();
    state.setPermission('s1', 'f1', 'write');
    expect(state.getPermission('s1', 'f1')).toBe('write');
    expect(state.getSessionPermissions('s1').f1).toBe('write');
  });

  it('toggles markdown permissions and syncs success', async () => {
    mockApi.updatePermissions.mockResolvedValueOnce({ success: true, data: { permission: 'write' } });
    await useSessionStore.getState().togglePermission('s1', 'f1', 'md');
    expect(useSessionStore.getState().permissions.s1.f1).toBe('write');
    expect(useSessionStore.getState().isSynced('s1')).toBe(true);
  });

  it('rolls back on sync failure', async () => {
    useSessionStore.getState().setPermission('s2', 'f2', 'read');
    mockApi.updatePermissions.mockResolvedValueOnce({ success: false });
    await useSessionStore.getState().togglePermission('s2', 'f2', 'md');
    expect(useSessionStore.getState().permissions.s2.f2).toBe('read');
  });

  it('loads permissions from backend and handles 404', async () => {
    mockApi.getSession.mockResolvedValueOnce({ success: true, data: { permissions: { f3: 'none' } } });
    await useSessionStore.getState().loadPermissionsFromBackend('s3');
    expect(useSessionStore.getState().permissions.s3.f3).toBe('none');

    mockApi.getSession.mockResolvedValueOnce({ success: false, error: '404 not found' });
    await useSessionStore.getState().loadPermissionsFromBackend('s4');
    expect(useSessionStore.getState().isSynced('s4')).toBe(true);
  });

  it('bulk syncs permissions with fallback', async () => {
    useSessionStore.getState().setPermission('s5', 'a', 'write');
    mockApi.bulkUpdatePermissions.mockResolvedValueOnce({
      success: true,
      data: { permissions: { a: 'write', b: 'read' } },
    });
    await useSessionStore.getState().syncAllPermissionsForSession('s5', ['a', 'b']);
    expect(useSessionStore.getState().permissions.s5.b).toBe('read');

    mockApi.bulkUpdatePermissions.mockRejectedValueOnce(new Error('network'));
    mockApi.updatePermissions.mockResolvedValue({ success: true, data: { permission: 'read' } });
    await useSessionStore.getState().syncAllPermissionsForSession('s5', ['c']);
    expect(mockApi.updatePermissions).toHaveBeenCalled();
  });

  it('clears session permissions', () => {
    useSessionStore.getState().setPermission('s6', 'x', 'read');
    useSessionStore.getState().clearSessionPermissions('s6');
    expect(useSessionStore.getState().permissions.s6).toBeUndefined();
  });

  it('handles non-markdown permission toggling and write coercion', async () => {
    useSessionStore.getState().setPermission('s7', 'pdf-1', 'write');
    mockApi.updatePermissions.mockResolvedValueOnce({ success: true, data: {} });
    await useSessionStore.getState().togglePermission('s7', 'pdf-1', 'pdf');
    expect(useSessionStore.getState().permissions.s7['pdf-1']).toBe('none');

    mockApi.updatePermissions.mockResolvedValueOnce({ success: true, data: {} });
    await useSessionStore.getState().togglePermission('s7', 'pdf-1', 'pdf');
    expect(useSessionStore.getState().permissions.s7['pdf-1']).toBe('read');
  });

  it('covers defaults and backend sync fallbacks', async () => {
    expect(useSessionStore.getState().getPermission('unknown', 'file')).toBe('read');
    expect(useSessionStore.getState().getSessionPermissions('unknown')).toEqual({});
    expect(useSessionStore.getState().isSynced('unknown')).toBe(false);

    mockApi.updatePermissions.mockResolvedValueOnce({ success: true, data: {} });
    const result = await useSessionStore.getState().syncPermissionsToBackend('s8', 'f8', 'write');
    expect(result.success).toBe(true);
    expect(result.effectivePermission).toBe('write');

    mockApi.getSession.mockResolvedValueOnce({ success: false, error: 'session 404' });
    await useSessionStore.getState().loadPermissionsFromBackend('s404');
    expect(useSessionStore.getState().isSynced('s404')).toBe(true);

    useSessionStore.getState().setPermission('s9', 'f9', 'write');
    mockApi.bulkUpdatePermissions.mockResolvedValueOnce({ success: true, data: {} });
    await useSessionStore.getState().syncAllPermissionsForSession('s9', ['f9', 'f10']);
    expect(useSessionStore.getState().permissions.s9.f10).toBe('read');
  });
});
