import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SessionPermissions, Permission } from '../types';
import { api } from '../api/client';

interface SessionState {
  permissions: SessionPermissions;
  syncStatus: Record<string, boolean>; // Track sync status per session

  // Actions
  togglePermission: (sessionId: string, fileId: string) => Promise<void>;
  setPermission: (sessionId: string, fileId: string, permission: Permission) => void;
  getPermission: (sessionId: string, fileId: string) => Permission;
  getSessionPermissions: (sessionId: string) => Record<string, Permission>;
  clearSessionPermissions: (sessionId: string) => void;

  // Sync with backend
  syncPermissionsToBackend: (sessionId: string, fileId: string, permission: Permission) => Promise<boolean>;
  loadPermissionsFromBackend: (sessionId: string) => Promise<void>;
  syncAllPermissionsForSession: (sessionId: string, fileIds: string[]) => Promise<void>;
  isSynced: (sessionId: string) => boolean;
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set, get) => ({
      permissions: {},
      syncStatus: {}, // Track which sessions have been synced with backend

      togglePermission: async (sessionId: string, fileId: string) => {
        const sessionData = get().permissions[sessionId] || {};
        const current = sessionData[fileId] || 'read';
        const next: Permission =
          current === 'read' ? 'write' : current === 'write' ? 'none' : 'read';

        // Optimistic update: update local state first
        set((state) => ({
          permissions: {
            ...state.permissions,
            [sessionId]: {
              ...sessionData,
              [fileId]: next,
            },
          },
          syncStatus: {
            ...state.syncStatus,
            [sessionId]: false, // Mark as pending sync
          },
        }));

        // Sync to backend
        const success = await get().syncPermissionsToBackend(sessionId, fileId, next);

        if (!success) {
          // Rollback on failure
          set((state) => ({
            permissions: {
              ...state.permissions,
              [sessionId]: {
                ...state.permissions[sessionId],
                [fileId]: current,
              },
            },
          }));
        }
      },

      setPermission: (sessionId: string, fileId: string, permission: Permission) => {
        set((state) => {
          const sessionData = state.permissions[sessionId] || {};
          return {
            permissions: {
              ...state.permissions,
              [sessionId]: {
                ...sessionData,
                [fileId]: permission,
              },
            },
          };
        });
      },

      getPermission: (sessionId: string, fileId: string) => {
        return get().permissions[sessionId]?.[fileId] || 'read';
      },

      getSessionPermissions: (sessionId: string) => {
        return get().permissions[sessionId] || {};
      },

      clearSessionPermissions: (sessionId: string) => {
        set((state) => {
          const { [sessionId]: _, ...restPermissions } = state.permissions;
          const { [sessionId]: __, ...restSyncStatus } = state.syncStatus;
          return {
            permissions: restPermissions,
            syncStatus: restSyncStatus,
          };
        });
      },

      syncPermissionsToBackend: async (sessionId: string, fileId: string, permission: Permission): Promise<boolean> => {
        try {
          const response = await api.updatePermissions(sessionId, fileId, permission);
          if (response.success) {
            set((state) => ({
              syncStatus: {
                ...state.syncStatus,
                [sessionId]: true,
              },
            }));
            return true;
          }
          return false;
        } catch (error) {
          console.error('Failed to sync permissions to backend:', error);
          return false;
        }
      },

      loadPermissionsFromBackend: async (sessionId: string) => {
        try {
          const response = await api.getSession(sessionId);

          // Handle 404 - session doesn't exist yet on backend
          // This is normal for new sessions; they will be created on first message
          if (!response.success) {
            // Don't log error for 404 - it's expected for new sessions
            if (response.error?.includes('not found') || response.error?.includes('404')) {
              // Mark as synced since backend has no permissions either (empty state)
              set((state) => ({
                syncStatus: {
                  ...state.syncStatus,
                  [sessionId]: true,
                },
              }));
              return;
            }
          }

          if (response.success && response.data?.permissions) {
            const backendPermissions = response.data.permissions;
            set((state) => ({
              permissions: {
                ...state.permissions,
                [sessionId]: backendPermissions,
              },
              syncStatus: {
                ...state.syncStatus,
                [sessionId]: true,
              },
            }));
          }
        } catch (error) {
          // Silently handle network errors - permissions will sync on first message
          console.debug('Could not load permissions from backend (session may not exist yet):', sessionId);
        }
      },

      syncAllPermissionsForSession: async (sessionId: string, fileIds: string[]) => {
        const currentPerms = get().getSessionPermissions(sessionId);

        // Build permissions object for all files
        const permissionsToSync: Record<string, Permission> = {};
        for (const fileId of fileIds) {
          permissionsToSync[fileId] = currentPerms[fileId] || 'read';
        }

        // Use bulk API for better performance
        try {
          const response = await api.bulkUpdatePermissions(sessionId, permissionsToSync);
          if (response.success) {
            set((state) => ({
              syncStatus: {
                ...state.syncStatus,
                [sessionId]: true,
              },
            }));
          }
        } catch (error) {
          console.error('Failed to bulk sync permissions:', error);
          // Fallback to individual sync
          for (const fileId of fileIds) {
            const permission = currentPerms[fileId] || 'read';
            await get().syncPermissionsToBackend(sessionId, fileId, permission);
          }
        }
      },

      isSynced: (sessionId: string) => {
        return get().syncStatus[sessionId] ?? false;
      },
    }),
    {
      name: 'session-storage',
    }
  )
);
