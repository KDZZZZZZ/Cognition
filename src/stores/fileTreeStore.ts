import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { FileNode } from '../types';
import { api } from '../api/client';

let idCounter = 100;
const generateId = (prefix: string) => `${prefix}_${Date.now()}_${idCounter++}`;

function mapBackendNode(node: any): FileNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type as FileNode['type'],
    isOpen: true,
    children: Array.isArray(node.children) ? node.children.map(mapBackendNode) : [],
  };
}

function findFileInTree(nodes: FileNode[], id: string): FileNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children?.length) {
      const found = findFileInTree(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

interface FileTreeState {
  fileTree: FileNode[];
  localSessions: FileNode[];
  loading: boolean;
  toggleFolder: (id: string) => void;
  findFile: (id: string) => FileNode | null;
  loadFilesFromBackend: () => Promise<void>;
  createFile: (name: string, type: 'md' | 'session', parentId?: string) => Promise<string | null>;
  createFolder: (name: string, parentId?: string) => Promise<string | null>;
  deleteFile: (id: string) => Promise<void>;
  renameFile: (id: string, newName: string) => void;
  moveFile: (
    fileId: string,
    targetFolderId?: string,
    siblingId?: string,
    position?: 'before' | 'after'
  ) => Promise<void>;
  syncWithBackend: () => Promise<void>;
}

export const useFileTreeStore = create<FileTreeState>()(
  persist(
    (set, get) => ({
      fileTree: [],
      localSessions: [],
      loading: false,

      toggleFolder: (id: string) =>
        set((state) => {
          const toggle = (nodes: FileNode[]): FileNode[] =>
            nodes.map((node) =>
              node.id === id
                ? { ...node, isOpen: !node.isOpen }
                : node.children
                  ? { ...node, children: toggle(node.children) }
                  : node
            );
          return { fileTree: toggle(state.fileTree) };
        }),

      findFile: (id: string) => findFileInTree(get().fileTree, id),

      loadFilesFromBackend: async () => {
        set({ loading: true });
        try {
          const [filesResponse, sessionsResponse] = await Promise.all([
            api.listFiles({ tree: true }),
            api.listSessions(500),
          ]);

          const backendTree = filesResponse.success && filesResponse.data
            ? (filesResponse.data.files || []).map(mapBackendNode)
            : [];

          const backendSessions = sessionsResponse.success && sessionsResponse.data
            ? (sessionsResponse.data.sessions || []).map((session) => ({
                id: session.id,
                name: session.name,
                type: 'session' as const,
              }))
            : [];

          const persistedSessions = get().localSessions || [];
          const mergedSessions: FileNode[] = [...backendSessions];
          for (const session of persistedSessions) {
            if (!mergedSessions.some((item) => item.id === session.id)) {
              mergedSessions.push(session);
            }
          }

          set({
            fileTree: [...backendTree, ...mergedSessions],
            localSessions: mergedSessions,
            loading: false,
          });
        } catch (err) {
          console.error('Failed to load files from backend:', err);
          set({ loading: false });
        }
      },

      syncWithBackend: async () => {
        await get().loadFilesFromBackend();
      },

      createFile: async (name: string, type: 'md' | 'session', parentId?: string) => {
        if (type === 'md') {
          try {
            const response = await api.createFile(name, '', parentId || null);
            await get().loadFilesFromBackend();
            if (response.success && response.data?.file_id) {
              return response.data.file_id;
            }
          } catch (err) {
            console.error('Failed to create file on backend:', err);
          }
          return null;
        }

        const preferredId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : generateId('session').slice(0, 36);
        const fallbackId = preferredId || generateId('session').slice(0, 36);

        let newSession: FileNode = {
          id: fallbackId,
          name,
          type: 'session',
        };

        try {
          const response = await api.createSession(name, { id: preferredId });
          if (response.success && response.data) {
            newSession = {
              id: response.data.id,
              name: response.data.name,
              type: 'session',
            };
          }
        } catch (err) {
          console.error('Failed to initialize backend session record:', err);
        }

        set((state) => {
          const localSessions = state.localSessions.some((item) => item.id === newSession.id)
            ? state.localSessions.map((item) => (item.id === newSession.id ? newSession : item))
            : [...state.localSessions, newSession];
          return {
            localSessions,
            fileTree: [...state.fileTree.filter((item) => item.id !== newSession.id), newSession],
          };
        });
        return newSession.id;
      },

      createFolder: async (name: string, parentId?: string): Promise<string | null> => {
        try {
          const response = await api.createFolder(name, parentId || null);
          if (response.success && response.data) {
            await get().loadFilesFromBackend();
            return response.data.folder_id || null;
          }
        } catch (err) {
          console.error('Failed to create folder on backend:', err);
        }
        return null;
      },

      deleteFile: async (id: string) => {
        const file = get().findFile(id);
        const isSession = file?.type === 'session';

        if (isSession) {
          try {
            await api.deleteSession(id);
          } catch (err) {
            console.error('Failed to delete session from backend:', err);
          }
          set((state) => ({
            localSessions: state.localSessions.filter((s) => s.id !== id),
            fileTree: state.fileTree.filter((node) => node.id !== id),
          }));
          try {
            const { useChatStore } = await import('./chatStore');
            const { useSessionStore } = await import('./sessionStore');
            const { usePaneStore } = await import('./paneStore');
            useChatStore.getState().clearSessionMessages(id);
            useSessionStore.getState().clearSessionPermissions(id);
            usePaneStore.getState().closeTabInAllPanes(id);
          } catch (err) {
            console.error('Failed to clean session stores:', err);
          }
          return;
        }

        try {
          await api.deleteFile(id);
          await get().loadFilesFromBackend();
        } catch (err) {
          console.error('Failed to delete from backend:', err);
        }
      },

      renameFile: (id: string, newName: string) => {
        const current = get().findFile(id);
        if (current?.type === 'session') {
          void api.createSession(newName, { id });
        }

        // Current file backend has no generic rename endpoint; keep optimistic local rename.
        set((state) => {
          const renameInNodes = (nodes: FileNode[]): FileNode[] =>
            nodes.map((node) =>
              node.id === id
                ? { ...node, name: newName }
                : node.children
                  ? { ...node, children: renameInNodes(node.children) }
                  : node
            );

          const localSessions = state.localSessions.map((session) =>
            session.id === id ? { ...session, name: newName } : session
          );

          return {
            fileTree: renameInNodes(state.fileTree),
            localSessions,
          };
        });
      },

      moveFile: async (
        fileId: string,
        targetFolderId?: string,
        siblingId?: string,
        _position?: 'before' | 'after'
      ) => {
        const file = get().findFile(fileId);
        if (file?.type === 'session') {
          // Session nodes are root-level, not movable in file hierarchy.
          return;
        }

        let targetParentId = targetFolderId;
        if (siblingId && !targetFolderId) {
          const findParent = (nodes: FileNode[], searchId: string, parentId?: string): string | undefined => {
            for (const node of nodes) {
              if (node.id === searchId) return parentId;
              if (node.children?.length) {
                const found = findParent(node.children, searchId, node.id);
                if (found !== undefined) return found;
              }
            }
            return undefined;
          };
          targetParentId = findParent(get().fileTree, siblingId);
        }

        try {
          await api.moveFile(fileId, targetParentId || null);
          await get().loadFilesFromBackend();
        } catch (err) {
          console.error('Failed to move file:', err);
        }
      },
    }),
    {
      name: 'file-tree-storage',
      partialize: (state) => ({
        localSessions: state.localSessions,
      }),
    }
  )
);
