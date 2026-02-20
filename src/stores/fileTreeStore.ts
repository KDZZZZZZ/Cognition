import { create } from 'zustand';
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
  createFile: (name: string, type: 'md' | 'session', parentId?: string) => Promise<void>;
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

export const useFileTreeStore = create<FileTreeState>((set, get) => ({
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
      const response = await api.listFiles({ tree: true });
      if (response.success && response.data) {
        const backendTree = (response.data.files || []).map(mapBackendNode);
        const sessions = get().localSessions;
        set({
          fileTree: [...backendTree, ...sessions],
          loading: false,
        });
      } else {
        set({ loading: false });
      }
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
        await api.createFile(name, '', parentId || null);
        await get().loadFilesFromBackend();
      } catch (err) {
        console.error('Failed to create file on backend:', err);
      }
      return;
    }

    const newSession: FileNode = {
      id: generateId('session'),
      name,
      type: 'session',
    };
    set((state) => ({
      localSessions: [...state.localSessions, newSession],
      fileTree: [...state.fileTree, newSession],
    }));
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
    // Current backend does not expose rename endpoint; keep optimistic local rename.
    set((state) => {
      const renameInNodes = (nodes: FileNode[]): FileNode[] =>
        nodes.map((node) =>
          node.id === id
            ? { ...node, name: newName }
            : node.children
              ? { ...node, children: renameInNodes(node.children) }
              : node
        );
      return { fileTree: renameInNodes(state.fileTree) };
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
      // Session nodes are local-only in this implementation.
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
}));
