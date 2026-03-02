import type { FileType } from '../../types';

interface ToolCallRecord {
  id: string;
  name: string;
  arguments: unknown;
}

interface ToolResultRecord {
  id: string;
  tool: string;
  success: boolean;
  error?: string;
  data?: unknown;
  raw: unknown;
}

export interface FileIndexStatusSnapshot {
  parse_status: string;
  embedding_status: string;
  last_error?: string | null;
  updated_at?: string;
}

export interface StreamingAssistantState {
  taskId: string;
  round?: number;
  content: string;
  updatedAt: string;
}

export function inferActionKind(toolName: string): string {
  if (['locate_relevant_segments', 'read_document_segments', 'get_document_outline', 'read_webpage_blocks', 'explain_retrieval', 'get_index_status', 'inspect_document_visual'].includes(toolName)) {
    return 'read';
  }
  if (['insert_block', 'add_file_charts_to_note'].includes(toolName)) return 'create';
  if (['update_file', 'update_block'].includes(toolName)) return 'update';
  if (toolName === 'delete_block') return 'delete';
  if (['pause_for_user_choice'].includes(toolName)) return 'pause';
  if (['register_task', 'deliver_task'].includes(toolName)) return 'task';
  return 'other';
}

export function formatJsonPreview(value: unknown, maxLength = 360): string {
  if (value === undefined) return '';
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function extractToolCalls(value: unknown): ToolCallRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: any, index) => {
    const functionPart = item?.function;
    const rawArgs = functionPart?.arguments ?? item?.arguments;
    let parsedArgs: unknown = rawArgs;
    if (typeof rawArgs === 'string') {
      try {
        parsedArgs = JSON.parse(rawArgs);
      } catch {
        parsedArgs = rawArgs;
      }
    }
    return {
      id: String(item?.id || `${index}`),
      name: String(functionPart?.name || item?.name || 'unknown_tool'),
      arguments: parsedArgs,
    };
  });
}

export function extractToolResults(value: unknown): ToolResultRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: any, index) => {
    const result = item?.result ?? {};
    return {
      id: String(item?.id || `${index}`),
      tool: String(item?.tool || item?.name || 'unknown_tool'),
      success: Boolean(result?.success),
      error: result?.error ? String(result.error) : undefined,
      data: result?.data,
      raw: item,
    };
  });
}

export function supportsIndexWarmup(fileType: FileType): boolean {
  return ['pdf', 'md', 'txt', 'docx', 'web'].includes(fileType);
}

export function summarizeIndexStatus(status?: FileIndexStatusSnapshot | null): {
  label: string;
  tone: string;
  needsWarmup: boolean;
} {
  if (!status) {
    return {
      label: 'Index unknown',
      tone: 'text-theme-text/42 border-theme-border/18 bg-theme-bg/65',
      needsWarmup: false,
    };
  }

  const parseState = status.parse_status || 'pending';
  const embedState = status.embedding_status || 'pending';

  if (parseState === 'ready' && (embedState === 'ready' || embedState === 'ready_with_errors')) {
    return {
      label: embedState === 'ready_with_errors' ? 'Index ready with warnings' : 'Index ready',
      tone: 'text-green-800 border-green-600/20 bg-green-50/70',
      needsWarmup: false,
    };
  }

  if (parseState === 'failed' || embedState === 'failed') {
    return {
      label: 'Index failed',
      tone: 'text-red-700 border-red-600/20 bg-red-50/70',
      needsWarmup: true,
    };
  }

  if (embedState === 'disabled') {
    return {
      label: 'Embedding disabled',
      tone: 'text-amber-800 border-amber-600/20 bg-amber-50/70',
      needsWarmup: false,
    };
  }

  return {
    label: 'Preparing index',
    tone: 'text-blue-800 border-blue-600/20 bg-blue-50/70',
    needsWarmup: true,
  };
}

export function applyAssistantStreamEvent(
  current: StreamingAssistantState | null,
  event: {
    task_id?: string;
    event_type?: string;
    content?: string;
    delta?: string;
    round?: number;
    timestamp?: string;
  }
): StreamingAssistantState | null {
  const taskId = String(event.task_id || '').trim();
  const eventType = String(event.event_type || '').trim().toLowerCase();
  const updatedAt = String(event.timestamp || new Date().toISOString());

  if (!taskId || !eventType) {
    return current;
  }

  if (eventType === 'started') {
    return {
      taskId,
      round: typeof event.round === 'number' ? event.round : undefined,
      content: '',
      updatedAt,
    };
  }

  if (eventType === 'delta') {
    return {
      taskId,
      round: typeof event.round === 'number' ? event.round : current?.round,
      content: typeof event.content === 'string'
        ? event.content
        : `${current?.content || ''}${typeof event.delta === 'string' ? event.delta : ''}`,
      updatedAt,
    };
  }

  if (eventType === 'completed') {
    return {
      taskId,
      round: typeof event.round === 'number' ? event.round : current?.round,
      content: typeof event.content === 'string' ? event.content : current?.content || '',
      updatedAt,
    };
  }

  if (eventType === 'cleared') {
    return null;
  }

  return current;
}

export function shouldClearAssistantPreview(eventType: string): boolean {
  return [
    'tool_started',
    'task_completed',
    'task_failed',
    'task_cancelled',
    'user_input_requested',
  ].includes(String(eventType || '').toLowerCase());
}
