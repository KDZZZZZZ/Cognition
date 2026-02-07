import { create } from 'zustand';
import { api } from '../api/client';
import type { FileMetadata, DocumentChunk, FileVersion } from '../api/client';

interface FileState {
  files: FileMetadata[];
  selectedFile: FileMetadata | null;
  fileContents: Record<string, string>;
  fileChunks: Record<string, DocumentChunk[]>;
  fileVersions: Record<string, FileVersion[]>;
  loading: boolean;
  error: string | null;
  lastUpdated: number; // Timestamp to trigger refreshes

  // Actions
  loadFiles: () => Promise<void>;
  selectFile: (file: FileMetadata | null) => void;
  uploadFile: (file: File) => Promise<string | null>;
  getFileContent: (fileId: string) => Promise<string | null>;
  updateFileContent: (fileId: string, content: string) => Promise<boolean>;
  deleteFile: (fileId: string) => Promise<void>;
  getFileChunks: (fileId: string) => Promise<DocumentChunk[]>;
  getFileVersions: (fileId: string) => Promise<FileVersion[]>;
  downloadFile: (fileId: string) => Promise<void>;
}

export const useFileStore = create<FileState>((set, get) => ({
  files: [],
  selectedFile: null,
  fileContents: {},
  fileChunks: {},
  fileVersions: {},
  loading: false,
  error: null,
  lastUpdated: 0,

  loadFiles: async () => {
    set({ loading: true, error: null });
    try {
      const response = await api.listFiles();
      if (response.success && response.data) {
        set({ files: response.data.files, loading: false });
      } else {
        set({ error: response.error || 'Failed to load files', loading: false });
      }
    } catch (err) {
      set({ error: 'Failed to connect to server', loading: false });
    }
  },

  selectFile: (file) => set({ selectedFile: file }),

  uploadFile: async (file) => {
    set({ loading: true, error: null });
    try {
      const response = await api.uploadFile(file);
      if (response.success && response.data) {
        const fileId = response.data.file_id;
        // Reload files
        await get().loadFiles();
        set({ loading: false });
        return fileId;
      } else {
        set({ error: response.error || 'Failed to upload file', loading: false });
        return null;
      }
    } catch (err) {
      set({ error: 'Failed to upload file', loading: false });
      return null;
    }
  },

  getFileContent: async (fileId) => {
    const cached = get().fileContents[fileId];
    if (cached) return cached;

    try {
      const response = await api.getFileContent(fileId);
      if (response.success && response.data) {
        const content = response.data.content;
        set((state) => ({
          fileContents: { ...state.fileContents, [fileId]: content }
        }));
        return content;
      }
    } catch (err) {
      console.error('Failed to load file content:', err);
    }
    return null;
  },

  updateFileContent: async (fileId, content) => {
    try {
      const response = await api.updateFileContent(fileId, content);
      if (response.success) {
        set((state) => ({
          fileContents: { ...state.fileContents, [fileId]: content },
          lastUpdated: Date.now() // Trigger refresh for watchers
        }));
        await get().loadFiles(); // Refresh file list
        await get().getFileVersions(fileId); // Refresh versions for timeline
        return true;
      }
    } catch (err) {
      console.error('Failed to update file:', err);
    }
    return false;
  },

  deleteFile: async (fileId) => {
    try {
      await api.deleteFile(fileId);
      set((state) => {
        const newContents = { ...state.fileContents };
        const newChunks = { ...state.fileChunks };
        const newVersions = { ...state.fileVersions };
        delete newContents[fileId];
        delete newChunks[fileId];
        delete newVersions[fileId];

        return {
          files: state.files.filter(f => f.id !== fileId),
          fileContents: newContents,
          fileChunks: newChunks,
          fileVersions: newVersions,
          selectedFile: state.selectedFile?.id === fileId ? null : state.selectedFile
        };
      });
    } catch (err) {
      console.error('Failed to delete file:', err);
    }
  },

  getFileChunks: async (fileId) => {
    const cached = get().fileChunks[fileId];
    if (cached) return cached;

    try {
      const response = await api.getFileChunks(fileId);
      if (response.success && response.data) {
        const chunks = response.data.chunks;
        set((state) => ({
          fileChunks: { ...state.fileChunks, [fileId]: chunks }
        }));
        return chunks;
      }
    } catch (err) {
      console.error('Failed to load chunks:', err);
    }
    return [];
  },

  getFileVersions: async (fileId) => {
    try {
      const response = await api.getFileVersions(fileId);
      if (response.success && response.data) {
        const versions = response.data.versions;
        set((state) => ({
          fileVersions: { ...state.fileVersions, [fileId]: versions }
        }));
        return versions;
      }
    } catch (err) {
      console.error('Failed to load versions:', err);
    }
    return [];
  },

  downloadFile: async (fileId) => {
    try {
      const blob = await api.downloadFile(fileId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const file = get().files.find(f => f.id === fileId);
      if (file) {
        a.download = file.name;
      }
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download file:', err);
    }
  },
}));
