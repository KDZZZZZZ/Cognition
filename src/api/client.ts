/**
 * API Client for Knowledge IDE Backend
 */

import { getApiBaseUrl, getDefaultChatModel, getRuntimeRequestHeaders } from '../config/runtime';

const API_BASE = getApiBaseUrl();

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

export interface UploadProgressSnapshot {
  loaded: number;
  total: number;
  percent: number;
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
  role: 'user' | 'assistant' | 'system' | 'task_event';
  content: string;
  timestamp: string;
  tool_calls?: any[];
  tool_results?: any;
  citations?: any[];
}

export type TaskStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'cancelling';

export interface TaskPromptOption {
  id: string;
  label: string;
  description?: string | null;
  recommended?: boolean;
}

export interface TaskPromptPayload {
  prompt_id: string;
  question: string;
  options: TaskPromptOption[];
  recommended_option_id?: string;
  allow_other?: boolean;
  other_placeholder?: string;
}

export interface TaskEventPayload {
  event_id: string;
  session_id: string;
  task_id: string;
  event_type: string;
  stage: string;
  message: string;
  progress?: number | null;
  status: TaskStatus;
  timestamp: string;
  payload?: Record<string, any>;
}

export interface RouterStatePayload {
  primary_mode: string;
  mixed_modes: string[];
  workflow_ids: string[];
  template_ids: string[];
  tool_mode: string;
}

export interface TaskRegistryStepPayload {
  index: number;
  type: string;
  status: string;
  missing_inputs?: Array<Record<string, any>>;
  output_preview?: string;
  compact_anchor?: Record<string, any> | null;
}

export interface TaskRegistryTaskPayload {
  task_id: string;
  goal: string;
  status: string;
  task_order: number;
  current_step_index: number;
  total_steps: number;
  blocked_reason?: string | null;
  missing_inputs?: Array<Record<string, any>>;
  artifacts?: Record<string, any>;
  steps: TaskRegistryStepPayload[];
}

export interface TaskRegistryPayload {
  registry_id: string;
  session_id: string;
  status: string;
  active_task_id?: string | null;
  goal_summary?: string | null;
  catalog_version: number;
  tasks: TaskRegistryTaskPayload[];
}

export interface BudgetBucketPayload {
  cap: number;
  used: number;
}

export interface BudgetMetaPayload {
  triggered: boolean;
  reason?: string;
  input_target_ratio?: number;
  total_input_tokens?: number;
  tool_schema_tokens?: number;
  buckets?: Record<string, BudgetBucketPayload>;
}

export interface SessionSummary {
  id: string;
  name: string;
  permissions: Record<string, 'read' | 'write' | 'none'>;
  created_at: string;
  updated_at: string;
}

export interface ChatCompletionOptions {
  permissions?: Record<string, 'read' | 'write' | 'none'>;
  taskId?: string;
  signal?: AbortSignal;
  activeFileId?: string;
  activePage?: number;
  activeVisibleUnit?: 'page' | 'line' | 'paragraph' | 'pixel';
  activeVisibleStart?: number;
  activeVisibleEnd?: number;
  activeAnchorBlockId?: string;
  compactMode?: 'auto' | 'off' | 'force';
}

export interface FileVersion {
  id: string;
  file_id: string;
  author: 'human' | 'agent';
  change_type: 'edit' | 'refactor' | 'delete' | 'create';
  summary: string;
  diff_patch?: string;
  context_snapshot?: string;
  result_snapshot?: string;
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
  effective_content?: string;
  created_at: string;
  resolved_at?: string | null;
  lines: DiffLineDTO[];
}

class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE) {
    this.baseUrl = baseUrl;
  }

  private getBaseUrl(): string {
    return getApiBaseUrl() || this.baseUrl;
  }

  private getHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    return {
      ...getRuntimeRequestHeaders(),
      ...(extraHeaders || {}),
    };
  }

  private normalizeApiResponse<T>(payload: unknown, ok: boolean, response: Pick<Response, 'status' | 'statusText'>): ApiResponse<T> {
    if (payload && typeof payload === 'object' && 'success' in payload) {
      return payload as ApiResponse<T>;
    }

    if (!ok) {
      const fallback = typeof payload === 'string' ? payload : response.statusText || `Request failed (${response.status})`;
      return { success: false, error: fallback };
    }

    return { success: true, data: payload as T };
  }

  private async parseResponse<T>(response: Response): Promise<ApiResponse<T>> {
    const ok = response.ok ?? true;

    if (typeof response.json === 'function') {
      try {
        const payload = await response.json();
        return this.normalizeApiResponse<T>(payload, ok, response);
      } catch {
        // Fall through to text parsing for plain-text errors and empty responses.
      }
    }

    const text = typeof response.text === 'function' ? await response.text() : '';
    if (!ok) {
      return {
        success: false,
        error: text || response.statusText || `Request failed (${response.status})`,
      };
    }
    return text
      ? { success: true, data: text as T }
      : { success: false, error: 'Empty response body' };
  }

  async get(endpoint: string): Promise<ApiResponse> {
    const response = await fetch(`${this.getBaseUrl()}${endpoint}`, {
      headers: this.getHeaders(),
    });
    return this.parseResponse(response);
  }

  async post(endpoint: string, body?: any, init?: RequestInit): Promise<ApiResponse> {
    const response = await fetch(`${this.getBaseUrl()}${endpoint}`, {
      method: 'POST',
      headers: body instanceof FormData ? this.getHeaders() : this.getHeaders({ 'Content-Type': 'application/json' }),
      body: body instanceof FormData ? body : JSON.stringify(body),
      signal: init?.signal,
    });
    return this.parseResponse(response);
  }

  async put(endpoint: string, body: any): Promise<ApiResponse> {
    const response = await fetch(`${this.getBaseUrl()}${endpoint}`, {
      method: 'PUT',
      headers: this.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return this.parseResponse(response);
  }

  async patch(endpoint: string, body: any): Promise<ApiResponse> {
    const response = await fetch(`${this.getBaseUrl()}${endpoint}`, {
      method: 'PATCH',
      headers: this.getHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    return this.parseResponse(response);
  }

  async delete(endpoint: string): Promise<ApiResponse> {
    const response = await fetch(`${this.getBaseUrl()}${endpoint}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    return this.parseResponse(response);
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

  async uploadFile(
    file: File,
    parentId?: string | null,
    options?: {
      onUploadProgress?: (snapshot: UploadProgressSnapshot) => void;
    }
  ): Promise<ApiResponse> {
    const formData = new FormData();
    formData.append('file', file);
    const query = parentId ? `?parent_id=${encodeURIComponent(parentId)}` : '';
    if (!options?.onUploadProgress) {
      return this.post(`/api/v1/files/upload${query}`, formData);
    }

    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.getBaseUrl()}/api/v1/files/upload${query}`);
      xhr.responseType = 'text';
      const headers = this.getHeaders();
      Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        options.onUploadProgress?.({
          loaded: event.loaded,
          total: event.total,
          percent: event.total > 0 ? Math.min(100, Math.round((event.loaded / event.total) * 100)) : 0,
        });
      };

      xhr.onerror = () => {
        resolve({ success: false, error: 'Network error while uploading file' });
      };

      xhr.onload = () => {
        const ok = xhr.status >= 200 && xhr.status < 300;
        const response = {
          status: xhr.status,
          statusText: xhr.statusText || '',
        };

        let payload: unknown = null;
        const raw = xhr.responseText || '';
        if (raw) {
          try {
            payload = JSON.parse(raw);
          } catch {
            payload = raw;
          }
        }

        resolve(this.normalizeApiResponse(payload, ok, response));
      };

      xhr.send(formData);
    });
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
    const response = await fetch(`${this.getBaseUrl()}/api/v1/files/${fileId}/download`, {
      headers: this.getHeaders(),
    });
    return response.blob();
  }

  async getFileChunks(fileId: string, page?: number): Promise<ApiResponse<{ chunks: DocumentChunk[] }>> {
    const query = page !== undefined ? `?page=${page}` : '';
    return this.get(`/api/v1/files/${fileId}/chunks${query}`);
  }

  async importWebUrl(payload: {
    url: string;
    title?: string;
    tags?: string[];
    fetch_options?: Record<string, any>;
    parent_id?: string | null;
  }): Promise<ApiResponse> {
    return this.post('/api/v1/files/import/web-url', payload);
  }

  async getFileSegments(
    fileId: string,
    options?: {
      page?: number;
      section?: string;
      bbox?: [number, number, number, number];
      segmentType?: string;
      source?: string;
    }
  ): Promise<ApiResponse<{ file_id: string; count: number; segments: any[] }>> {
    const params = new URLSearchParams();
    if (typeof options?.page === 'number') params.set('page', String(options.page));
    if (options?.section) params.set('section', options.section);
    if (options?.bbox && options.bbox.length === 4) params.set('bbox', options.bbox.join(','));
    if (options?.segmentType) params.set('segment_type', options.segmentType);
    if (options?.source) params.set('source', options.source);
    const query = params.toString();
    return this.get(`/api/v1/files/${fileId}/segments${query ? `?${query}` : ''}`);
  }

  async reindexFile(fileId: string, mode: 'parse_only' | 'embed_only' | 'all' = 'all'): Promise<ApiResponse> {
    return this.post(`/api/v1/files/${fileId}/reindex`, { mode });
  }

  async getFileIndexStatus(fileId: string): Promise<ApiResponse> {
    return this.get(`/api/v1/files/${fileId}/index-status`);
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

  async updateDiffEventContent(
    fileId: string,
    eventId: string,
    payload: { newContent: string; summary?: string; author?: 'human' | 'agent' }
  ): Promise<ApiResponse<{ event: DiffEventDTO }>> {
    return this.patch(`/api/v1/files/${fileId}/diff-events/${eventId}/content`, {
      new_content: payload.newContent,
      summary: payload.summary,
      author: payload.author || 'human',
    });
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
    model = getDefaultChatModel(),
    useTools = true,
    options?: ChatCompletionOptions
  ): Promise<ApiResponse> {
    const payload: Record<string, any> = {
      session_id: sessionId,
      message,
      context_files: contextFiles,
      model,
      use_tools: useTools,
    };
    if (options?.permissions) payload.permissions = options.permissions;
    if (options?.taskId) payload.task_id = options.taskId;
    if (options?.activeFileId) payload.active_file_id = options.activeFileId;
    if (typeof options?.activePage === 'number') payload.active_page = options.activePage;
    if (options?.activeVisibleUnit) payload.active_visible_unit = options.activeVisibleUnit;
    if (typeof options?.activeVisibleStart === 'number') payload.active_visible_start = options.activeVisibleStart;
    if (typeof options?.activeVisibleEnd === 'number') payload.active_visible_end = options.activeVisibleEnd;
    if (options?.activeAnchorBlockId) payload.active_anchor_block_id = options.activeAnchorBlockId;
    if (options?.compactMode) payload.compact_mode = options.compactMode;

    return this.post(
      '/api/v1/chat/completions',
      payload,
      { signal: options?.signal }
    );
  }

  async cancelTask(sessionId: string, taskId: string): Promise<ApiResponse> {
    const query = `?session_id=${encodeURIComponent(sessionId)}`;
    return this.post(`/api/v1/chat/tasks/${encodeURIComponent(taskId)}/cancel${query}`);
  }

  async answerTaskPrompt(
    sessionId: string,
    taskId: string,
    payload: {
      promptId: string;
      selectedOptionId?: string;
      otherText?: string;
    }
  ): Promise<ApiResponse> {
    return this.post(`/api/v1/chat/tasks/${encodeURIComponent(taskId)}/answer`, {
      session_id: sessionId,
      prompt_id: payload.promptId,
      selected_option_id: payload.selectedOptionId,
      other_text: payload.otherText,
    });
  }

  async getSession(sessionId: string): Promise<ApiResponse> {
    return this.get(`/api/v1/chat/sessions/${sessionId}`);
  }

  async listSessions(limit = 200): Promise<ApiResponse<{ sessions: SessionSummary[]; count: number }>> {
    return this.get(`/api/v1/chat/sessions?limit=${limit}`);
  }

  async createSession(
    name: string,
    options?: {
      id?: string;
      permissions?: Record<string, 'read' | 'write' | 'none'>;
    }
  ): Promise<ApiResponse<SessionSummary>> {
    return this.post('/api/v1/chat/sessions', {
      id: options?.id,
      name,
      permissions: options?.permissions || {},
    });
  }

  async getSessionMessages(sessionId: string, limit = 50): Promise<ApiResponse<{ messages: ChatMessage[] }>> {
    return this.get(`/api/v1/chat/sessions/${sessionId}/messages?limit=${limit}`);
  }

  async updatePermissions(sessionId: string, fileId: string, permission: 'read' | 'write' | 'none'): Promise<ApiResponse> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/chat/sessions/${sessionId}/permissions?file_id=${fileId}&permission=${permission}`,
      { method: 'POST', headers: this.getHeaders() }
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
  async updateViewport(
    sessionId: string,
    fileId: string,
    page: number,
    scrollY: number,
    scrollHeight: number,
    options?: {
      visibleUnit?: 'page' | 'line' | 'paragraph' | 'pixel';
      visibleStart?: number;
      visibleEnd?: number;
      anchorBlockId?: string;
      pendingDiffEventId?: string;
    }
  ): Promise<ApiResponse> {
    return this.post('/api/v1/viewport/update', {
      session_id: sessionId,
      file_id: fileId,
      page,
      scroll_y: scrollY,
      visible_range_start: Math.max(0, Math.floor(scrollY)),
      visible_range_end: Math.max(0, Math.floor(scrollY + scrollHeight)),
      visible_unit: options?.visibleUnit,
      visible_start: typeof options?.visibleStart === 'number' ? Math.max(0, Math.floor(options.visibleStart)) : undefined,
      visible_end: typeof options?.visibleEnd === 'number' ? Math.max(0, Math.floor(options.visibleEnd)) : undefined,
      anchor_block_id: options?.anchorBlockId,
      pending_diff_event_id: options?.pendingDiffEventId,
    });
  }

  async getViewport(sessionId: string): Promise<ApiResponse> {
    return this.get(`/api/v1/viewport/${sessionId}`);
  }
}

export const api = new ApiClient();
