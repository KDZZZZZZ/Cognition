import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { FileNode } from '../types';
import { api } from '../api/client';

// Helper to generate unique IDs for local-only items
let idCounter = 100;
const generateId = (prefix: string) => `${prefix}_${Date.now()}_${idCounter++}`;

interface FileTreeState {
  fileTree: FileNode[];
  loading: boolean;
  toggleFolder: (id: string) => void;
  findFile: (id: string) => FileNode | null;
  loadFilesFromBackend: () => Promise<void>;
  createFile: (name: string, type: 'md' | 'session', parentId?: string) => Promise<void>;
  createFolder: (name: string, parentId?: string) => string;
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

      findFile: (id: string) => {
        const find = (nodes: FileNode[]): FileNode | null => {
          for (const node of nodes) {
            if (node.id === id) return node;
            if (node.children) {
              const found = find(node.children);
              if (found) return found;
            }
          }
          return null;
        };
        return find(get().fileTree);
      },

      loadFilesFromBackend: async () => {
        set({ loading: true });
        try {
          const response = await api.listFiles();
          if (response.success && response.data) {
            const backendFiles = response.data.files;
            // Convert backend files to FileNode format
            const fileNodes = backendFiles.map((file: any) => ({
              id: file.id,
              name: file.name,
              type: file.type as FileNode['type'],
              isOpen: false,
            }));

            // Preserve folder structure from existing state
            const existingFolders = get().fileTree.filter(n => n.type === 'folder');

            set({
              fileTree: [...existingFolders, ...fileNodes],
              loading: false
            });
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
        // For MD files, create on backend
        if (type === 'md') {
          try {
            const response = await api.createFile(name, '');
            if (response.success && response.data) {
              const fileId = response.data.file_id;
              const newFile: FileNode = {
                id: fileId,
                name,
                type,
              };

              if (parentId) {
                set((state) => {
                  const addToFolder = (nodes: FileNode[]): FileNode[] =>
                    nodes.map((node) =>
                      node.id === parentId && node.type === 'folder'
                        ? { ...node, children: [...(node.children || []), newFile] }
                        : node.children
                          ? { ...node, children: addToFolder(node.children) }
                          : node
                    );
                  return { fileTree: addToFolder(state.fileTree) };
                });
              } else {
                set((state) => ({ fileTree: [...state.fileTree, newFile] }));
              }

              // Refresh from backend to get complete data
              await get().loadFilesFromBackend();
            }
          } catch (err) {
            console.error('Failed to create file on backend:', err);
          }
        } else {
          // For sessions, create locally only
          const newFile: FileNode = {
            id: generateId('session'),
            name,
            type,
          };

          if (parentId) {
            set((state) => {
              const addToFolder = (nodes: FileNode[]): FileNode[] =>
                nodes.map((node) =>
                  node.id === parentId && node.type === 'folder'
                    ? { ...node, children: [...(node.children || []), newFile] }
                    : node.children
                      ? { ...node, children: addToFolder(node.children) }
                      : node
                );
              return { fileTree: addToFolder(state.fileTree) };
            });
          } else {
            set((state) => ({ fileTree: [...state.fileTree, newFile] }));
          }
        }
      },

      createFolder: (name: string, parentId?: string): string => {
        const folderId = generateId('folder');
        const newFolder: FileNode = {
          id: folderId,
          name,
          type: 'folder',
          isOpen: true,
          children: [],
        };

        if (parentId) {
          set((state) => {
            const addToFolder = (nodes: FileNode[]): FileNode[] =>
              nodes.map((node) =>
                node.id === parentId && node.type === 'folder'
                  ? { ...node, children: [...(node.children || []), newFolder] }
                  : node.children
                    ? { ...node, children: addToFolder(node.children) }
                    : node
              );
            return { fileTree: addToFolder(state.fileTree) };
          });
        } else {
          set((state) => ({ fileTree: [...state.fileTree, newFolder] }));
        }

        return folderId;
      },

      deleteFile: async (id: string) => {
        // Check if this is a session file before deleting
        const file = get().findFile(id);
        const isSession = file?.type === 'session';

        // Delete from backend if it's a backend file (no underscore in ID)
        const isBackendFile = !id.includes('_');
        if (isBackendFile) {
          try {
            await api.deleteFile(id);
          } catch (err) {
            console.error('Failed to delete from backend:', err);
          }
        }

        // If this is a session, also delete from backend
        if (isSession) {
          try {
            await api.deleteSession(id);
          } catch (err) {
            console.error('Failed to delete session from backend:', err);
          }
        }

        // Always remove from local tree
        set((state) => {
          const deleteFromNodes = (nodes: FileNode[]): FileNode[] =>
            nodes
              .filter((node) => node.id !== id)
              .map((node) =>
                node.children
                  ? { ...node, children: deleteFromNodes(node.children) }
                  : node
              );
          return { fileTree: deleteFromNodes(state.fileTree) };
        });

        // If this was a session, clean up related data from other stores
        if (isSession) {
          try {
            const { useChatStore } = await import('./chatStore');
            const { useSessionStore } = await import('./sessionStore');
            const { usePaneStore } = await import('./paneStore');
            useChatStore.getState().clearSessionMessages(id);
            useSessionStore.getState().clearSessionPermissions(id);
            // Close the tab in all panes
            usePaneStore.getState().closeTabInAllPanes(id);
          } catch (err) {
            console.error('Failed to clean up session data:', err);
          }
          // Don't refresh from backend for local sessions
          return;
        }

        // Refresh from backend only for backend files
        await get().loadFilesFromBackend();
      },

      renameFile: (id: string, newName: string) => {
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
        position?: 'before' | 'after'
      ) => {
        // Call API first for backend files (non-local files don't have underscore in ID)
        const isBackendFile = !fileId.includes('_');
        if (isBackendFile) {
          try {
            // For sibling moves, we need to determine the parent
            let targetParentId = targetFolderId;
            if (siblingId && !targetFolderId) {
              // Find sibling's parent
              const findParent = (nodes: FileNode[], searchId: string): FileNode | null => {
                for (const node of nodes) {
                  if (node.children?.some(child => child.id === searchId)) {
                    return node;
                  }
                  if (node.children) {
                    const found = findParent(node.children, searchId);
                    if (found) return found;
                  }
                }
                return null;
              };
              const parent = findParent(get().fileTree, siblingId);
              targetParentId = parent?.id;
            }
            await api.moveFile(fileId, targetParentId || null);
          } catch (err) {
            console.error('Failed to move file on backend:', err);
            return; // Don't update local state if backend fails
          }
        }

        set((state) => {
          // Find and remove the file from its current location
          let movedFile: FileNode | null = null;

          const removeFile = (nodes: FileNode[]): FileNode[] => {
            const result: FileNode[] = [];
            for (const node of nodes) {
              if (node.id === fileId) {
                movedFile = node;
                continue;
              }
              if (node.children) {
                result.push({ ...node, children: removeFile(node.children) });
              } else {
                result.push(node);
              }
            }
            return result;
          };

          let newTree = removeFile(state.fileTree);

          if (!movedFile) return state;

          // Insert into target folder
          if (targetFolderId) {
            const insertIntoFolder = (nodes: FileNode[]): FileNode[] =>
              nodes.map((node) =>
                node.id === targetFolderId && node.type === 'folder'
                  ? { ...node, children: [...(node.children || []), movedFile!], isOpen: true }
                  : node.children
                    ? { ...node, children: insertIntoFolder(node.children) }
                    : node
              );
            newTree = insertIntoFolder(newTree);
          }
          // Insert before/after sibling
          else if (siblingId && position) {
            const insertAtPosition = (nodes: FileNode[]): FileNode[] => {
              const result: FileNode[] = [];
              for (const node of nodes) {
                if (node.id === siblingId) {
                  if (position === 'before') {
                    result.push(movedFile!);
                    result.push(node);
                  } else {
                    result.push(node);
                    result.push(movedFile!);
                  }
                } else if (node.children) {
                  result.push({ ...node, children: insertAtPosition(node.children) });
                } else {
                  result.push(node);
                }
              }
              return result;
            };
            newTree = insertAtPosition(newTree);
          }
          // Insert at root level
          else {
            newTree.push(movedFile);
          }

          return { fileTree: newTree };
        });
      },
    }),
    {
      name: 'file-tree-storage',
      // Persist folders and sessions (local-only items)
      partialize: (state) => ({
        fileTree: state.fileTree.filter(n => n.type === 'folder' || n.type === 'session'),
      }),
    }
  )
);
