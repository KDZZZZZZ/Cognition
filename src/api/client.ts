/**
 * API Client for Knowledge IDE Backend
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

export const BASE_URL = API_BASE;

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface FileMetadata {
  id: string;
  name: string;
  type: string;
  size: number;
  created_at: string;
  updated_at: string;
  page_count?: number;
  url?: string;
  parent_id?: string | null;
  children?: FileMetadata[];
}

export interface DocumentChunk {
  id: string;
  file_id: string;
  page: number;
  chunk_index: number;
  content: string;
  bbox?: [number, number, number, number];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  tool_calls?: any[];
  tool_results?: any[];
  citations?: any[];
}

export interface FileVersion {
  id: string;
  file_id: string;
  author: 'human' | 'agent';
  change_type: 'edit' | 'refactor' | 'delete' | 'create';
  summary: string;
  diff_patch?: string;
  context_snapshot?: string;
  timestamp: string;
}

export type LineDecision = 'pending' | 'accepted' | 'rejected';
export type DiffEventStatus = 'pending' | 'resolved';

export interface DiffLineDTO {
  id: string;
  line_no: number;
  old_line: string | null;
  new_line: string | null;
  decision: LineDecision;
}

export interface DiffEventDTO {
  id: string;
  file_id: string;
  author: 'human' | 'agent';
  summary?: string;
  status: DiffEventStatus;
  old_content: string;
  new_content: string;
  created_at: string;
  resolved_at?: string | null;
  lines: DiffLineDTO[];
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl;
  }

  async get(endpoint: string): Promise<ApiResponse> {
    const response = await fetch(`${this.baseUrl}${endpoint}`);
    return response.json();
  }

  async post(endpoint: string, body?: any): Promise<ApiResponse> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });
    return response.json();
  }

  async put(endpoint: string, body: any): Promise<ApiResponse> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  async patch(endpoint: string, body: any): Promise<ApiResponse> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  async delete(endpoint: string): Promise<ApiResponse> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, { method: 'DELETE' });
    return response.json();
  }

  // Health
  async health() {
    return this.get('/health');
  }

  // Files
  async listFiles(options?: { tree?: boolean; parentId?: string | null }): Promise<ApiResponse<{ files: FileMetadata[]; count: number }>> {
    const params = new URLSearchParams();
    if (options?.tree) params.set('tree', 'true');
    if (options?.parentId !== undefined) {
      params.set('parent_id', options.parentId === null ? 'root' : options.parentId);
    }
    const query = params.toString();
    return this.get(`/api/v1/files/${query ? `?${query}` : ''}`);
  }

  async uploadFile(file: File, parentId?: string | null): Promise<ApiResponse> {
    const formData = new FormData();
    formData.append('file', file);
    const query = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : '';
    return this.post(`/api/v1/files/upload${query}`, formData);
  }

  async createFolder(name: string, parentId?: string | null): Promise<ApiResponse> {
    return this.post('/api/v1/files/folders', {
      name,
      parent_id: parentId ?? null,
    });
  }

  async getFile(fileId: string): Promise<ApiResponse<FileMetadata>> {
    return this.get(`/api/v1/files/${fileId}`);
  }

  async getFileContent(fileId: string): Promise<ApiResponse<{ content: string }>> {
    return this.get(`/api/v1/files/${fileId}/content`);
  }

  async updateFileContent(
    fileId: string,
    content: string,
    author = 'human',
    summary = 'Content updated',
    changeType = 'edit'
  ): Promise<ApiResponse<{
    file_id: string;
    size: number;
    updated_at: string;
    version_id?: string;
    version_created?: boolean;
  }>> {
    return this.put(`/api/v1/files/${fileId}/content`, {
      content,
      author,
      summary,
      change_type: changeType,
    });
  }

  async createFile(filename: string, content = '', parentId?: string | null): Promise<ApiResponse<{ file_id: string }>> {
    const blob = new Blob([content], { type: 'text/markdown' });
    const file = new File([blob], filename, { type: 'text/markdown' });
    return this.uploadFile(file, parentId);
  }

  async downloadFile(fileId: string): Promise<Blob> {
    const response = await fetch(`${this.baseUrl}/api/v1/files/${fileId}/download`);
    return response.blob();
  }

  async getFileChunks(fileId: string, page?: number): Promise<ApiResponse<{ chunks: DocumentChunk[] }>> {
    const query = page !== undefined ? `?page=${page}` : '';
    return this.get(`/api/v1/files/${fileId}/chunks${query}`);
  }

  async getFileVersions(fileId: string): Promise<ApiResponse<{ versions: FileVersion[]; total: number }>> {
    return this.get(`/api/v1/files/${fileId}/versions`);
  }

  async deleteFile(fileId: string): Promise<ApiResponse> {
    return this.delete(`/api/v1/files/${fileId}`);
  }

  async moveFile(fileId: string, targetParentId?: string | null): Promise<ApiResponse> {
    return this.post(`/api/v1/files/${fileId}/move`, { new_parent_id: targetParentId ?? null });
  }

  // Diff events
  async createDiffEvent(fileId: string, newContent: string, summary = 'Agent proposed edit', author: 'human' | 'agent' = 'agent') {
    return this.post(`/api/v1/files/${fileId}/diff-events`, {
      new_content: newContent,
      summary,
      author,
    });
  }

  async getPendingDiffEvent(fileId: string): Promise<ApiResponse<{ event: DiffEventDTO | null }>> {
    return this.get(`/api/v1/files/${fileId}/diff-events/pending`);
  }

  async updateDiffLineDecision(fileId: string, eventId: string, lineId: string, decision: LineDecision) {
    return this.patch(`/api/v1/files/${fileId}/diff-events/${eventId}/lines/${lineId}`, { decision });
  }

  async finalizeDiffEvent(
    fileId: string,
    eventId: string,
    payload?: { finalContent?: string; summary?: string; author?: 'human' | 'agent' }
  ) {
    return this.post(`/api/v1/files/${fileId}/diff-events/${eventId}/finalize`, {
      final_content: payload?.finalContent,
      summary: payload?.summary,
      author: payload?.author || 'human',
    });
  }

  // Chat
  async chatCompletion(
    sessionId: string,
    message: string,
    contextFiles: string[] = [],
    model = 'qwen-plus',
    useTools = true,
    permissions?: Record<string, 'read' | 'write' | 'none'>
  ): Promise<ApiResponse> {
    return this.post('/api/v1/chat/completions', {
      session_id: sessionId,
      message,
      context_files: contextFiles,
      model,
      use_tools: useTools,
      permissions,
    });
  }

  async getSession(sessionId: string): Promise<ApiResponse> {
    return this.get(`/api/v1/chat/sessions/${sessionId}`);
  }

  async getSessionMessages(sessionId: string, limit = 50): Promise<ApiResponse<{ messages: ChatMessage[] }>> {
    return this.get(`/api/v1/chat/sessions/${sessionId}/messages?limit=${limit}`);
  }

  async updatePermissions(sessionId: string, fileId: string, permission: 'read' | 'write' | 'none'): Promise<ApiResponse> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/chat/sessions/${sessionId}/permissions?file_id=${fileId}&permission=${permission}`,
      { method: 'POST' }
    );
    return response.json();
  }

  async bulkUpdatePermissions(sessionId: string, permissions: Record<string, 'read' | 'write' | 'none'>): Promise<ApiResponse> {
    return this.put(`/api/v1/chat/sessions/${sessionId}/permissions`, permissions);
  }

  async deleteSession(sessionId: string): Promise<ApiResponse> {
    return this.delete(`/api/v1/chat/sessions/${sessionId}`);
  }

  // Viewport tracking
  async updateViewport(sessionId: string, fileId: string, page: number, scrollY: number, scrollHeight: number): Promise<ApiResponse> {
    return this.post('/api/v1/viewport/update', {
      session_id: sessionId,
      file_id: fileId,
      page,
      scroll_y: scrollY,
      visible_range_start: Math.max(0, Math.floor(scrollY)),
      visible_range_end: Math.max(0, Math.floor(scrollY + scrollHeight)),
    });
  }

  async getViewport(sessionId: string): Promise<ApiResponse> {
    return this.get(`/api/v1/viewport/${sessionId}`);
  }
}

export const api = new ApiClient();
