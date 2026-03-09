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

type SessionLocationMap = Record<string, string | null | undefined>;

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

function stripSessionNodes(nodes: FileNode[]): FileNode[] {
  return nodes
    .filter((node) => node.type !== 'session')
    .map((node) => ({
      ...node,
      children: node.children ? stripSessionNodes(node.children) : [],
    }));
}

function collectFolderIds(nodes: FileNode[], folderIds = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.type === 'folder') {
      folderIds.add(node.id);
      if (node.children?.length) {
        collectFolderIds(node.children, folderIds);
      }
    }
  }
  return folderIds;
}

function normalizeSessionLocations(
  locations: SessionLocationMap | undefined,
  baseTree: FileNode[],
  sessions: FileNode[]
): SessionLocationMap {
  const validFolders = collectFolderIds(baseTree);
  const normalized: SessionLocationMap = {};

  for (const session of sessions) {
    const parentId = locations?.[session.id];
    normalized[session.id] = parentId && validFolders.has(parentId) ? parentId : null;
  }

  return normalized;
}

function insertNodeIntoTree(nodes: FileNode[], item: FileNode, parentId?: string | null): FileNode[] {
  if (!parentId) {
    return [...nodes, item];
  }

  let inserted = false;
  const nextNodes = nodes.map((node) => {
    if (node.id === parentId && node.type === 'folder') {
      inserted = true;
      return {
        ...node,
        children: [...(node.children || []), item],
      };
    }

    if (node.children?.length) {
      const nextChildren = insertNodeIntoTree(node.children, item, parentId);
      if (nextChildren !== node.children) {
        inserted = true;
        return {
          ...node,
          children: nextChildren,
        };
      }
    }

    return node;
  });

  return inserted ? nextNodes : [...nodes, item];
}

function buildFileTree(
  baseTree: FileNode[],
  sessions: FileNode[],
  locations: SessionLocationMap | undefined
): { fileTree: FileNode[]; sessionLocations: SessionLocationMap } {
  const treeWithoutSessions = stripSessionNodes(baseTree);
  const sessionLocations = normalizeSessionLocations(locations, treeWithoutSessions, sessions);

  let fileTree = treeWithoutSessions;
  for (const session of sessions) {
    fileTree = insertNodeIntoTree(fileTree, { ...session, children: [] }, sessionLocations[session.id]);
  }

  return { fileTree, sessionLocations };
}

function findParentId(nodes: FileNode[], searchId: string, parentId?: string): string | undefined {
  for (const node of nodes) {
    if (node.id === searchId) return parentId;
    if (node.children?.length) {
      const found = findParentId(node.children, searchId, node.id);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

interface FileTreeState {
  fileTree: FileNode[];
  localSessions: FileNode[];
  sessionLocations: SessionLocationMap;
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
      sessionLocations: {},
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
          const mergedSessionMap = new Map<string, FileNode>();

          for (const session of persistedSessions) {
            mergedSessionMap.set(session.id, {
              id: session.id,
              name: session.name,
              type: 'session',
            });
          }

          for (const session of backendSessions) {
            mergedSessionMap.set(session.id, {
              id: session.id,
              name: session.name,
              type: 'session',
            });
          }

          const mergedSessions: FileNode[] = Array.from(mergedSessionMap.values());
          const merged = buildFileTree(backendTree, mergedSessions, get().sessionLocations);

          set({
            fileTree: merged.fileTree,
            localSessions: mergedSessions,
            sessionLocations: merged.sessionLocations,
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
          const sessionLocations = {
            ...state.sessionLocations,
            [newSession.id]: parentId ?? null,
          };
          const merged = buildFileTree(state.fileTree, localSessions, sessionLocations);
          return {
            localSessions,
            sessionLocations: merged.sessionLocations,
            fileTree: merged.fileTree,
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
            ...(() => {
              const localSessions = state.localSessions.filter((s) => s.id !== id);
              const sessionLocations = Object.fromEntries(
                Object.entries(state.sessionLocations).filter(([sessionId]) => sessionId !== id)
              );
              const merged = buildFileTree(state.fileTree, localSessions, sessionLocations);
              return {
                localSessions,
                sessionLocations: merged.sessionLocations,
                fileTree: merged.fileTree,
              };
            })(),
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
          let targetParentId = targetFolderId ?? null;
          if (siblingId && !targetFolderId) {
            targetParentId = findParentId(get().fileTree, siblingId) ?? null;
          }

          set((state) => {
            const sessionLocations = {
              ...state.sessionLocations,
              [fileId]: targetParentId,
            };
            const merged = buildFileTree(state.fileTree, state.localSessions, sessionLocations);
            return {
              sessionLocations: merged.sessionLocations,
              fileTree: merged.fileTree,
            };
          });
          return;
        }

        let targetParentId = targetFolderId;
        if (siblingId && !targetFolderId) {
          targetParentId = findParentId(get().fileTree, siblingId);
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
        sessionLocations: state.sessionLocations,
      }),
    }
  )
);
