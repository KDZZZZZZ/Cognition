import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../api/client';
import type { ChatMessage, TaskEventPayload, TaskStatus, TaskPromptPayload } from '../api/client';
import { useSessionStore } from './sessionStore';

const DEFAULT_CHAT_MODEL = (import.meta.env.VITE_DEFAULT_MODEL as string | undefined) || 'kimi-latest';

interface ActiveTaskState {
  taskId: string;
  status: TaskStatus;
  stage: string;
  progress?: number | null;
  startedAt: string;
  updatedAt: string;
  lastMessage: string;
  contextFiles: string[];
}

interface TaskInputSnapshot {
  message: string;
  contextFiles: string[];
}

export interface PendingPromptState {
  taskId: string;
  prompt: TaskPromptPayload;
  requestedAt: string;
}

export interface SessionReferenceItem {
  id: string;
  sourceFileId: string;
  sourceFileName: string;
  markdown: string;
  plainText: string;
  createdAt: string;
}

export type TaskBoardStatus = 'waiting' | 'running' | 'completed';

export interface TaskBoardItem {
  id: string;
  name: string;
  status: TaskBoardStatus;
  description?: string;
  completionSummary?: string;
  createdAt: string;
  updatedAt: string;
}

interface SendMessageOptions {
  activeFileId?: string;
  activePage?: number;
  compactMode?: 'auto' | 'off' | 'force';
}

interface ChatState {
  messages: Record<string, ChatMessage[]>;
  sessionReferences: Record<string, SessionReferenceItem[]>;
  loading: boolean;
  loadingSessions: Record<string, boolean>;
  activeTasks: Record<string, ActiveTaskState | null>;
  pendingPrompts: Record<string, PendingPromptState | null>;
  taskBoards: Record<string, TaskBoardItem[]>;
  lastTaskInput: Record<string, TaskInputSnapshot | null>;
  abortControllers: Record<string, AbortController | null>;
  error: string | null;
  sessionId: string;
  model: string;

  setSessionId: (sessionId: string) => void;
  setModel: (model: string) => void;
  sendMessage: (message: string, contextFiles: string[], options?: SendMessageOptions) => Promise<void>;
  sendMessageForSession: (
    sessionId: string,
    message: string,
    contextFiles: string[],
    options?: SendMessageOptions
  ) => Promise<void>;
  ingestTaskEvent: (sessionId: string, event: TaskEventPayload) => void;
  cancelActiveTask: (sessionId: string) => Promise<void>;
  retryLastTask: (sessionId: string) => Promise<void>;
  isSessionLoading: (sessionId: string) => boolean;
  getActiveTask: (sessionId: string) => ActiveTaskState | null;
  getTaskBoard: (sessionId: string) => TaskBoardItem[];
  getPendingPrompt: (sessionId: string) => PendingPromptState | null;
  answerTaskPrompt: (
    sessionId: string,
    taskId: string,
    payload: {
      promptId: string;
      selectedOptionId?: string;
      otherText?: string;
    }
  ) => Promise<void>;
  clearMessages: () => void;
  clearSessionMessages: (sessionId: string) => void;
  getCurrentMessages: () => ChatMessage[];
  getMessagesForSession: (sessionId: string) => ChatMessage[];
  getSessionReferences: (sessionId: string) => SessionReferenceItem[];
  addSessionReference: (
    sessionId: string,
    reference: {
      sourceFileId: string;
      sourceFileName: string;
      markdown: string;
      plainText?: string;
    }
  ) => void;
  removeSessionReference: (sessionId: string, referenceId: string) => void;
  clearSessionReferences: (sessionId: string) => void;
  loadSessionMessages: (sessionId: string) => Promise<void>;
}

function computeGlobalLoading(loadingSessions: Record<string, boolean>): boolean {
  return Object.values(loadingSessions).some(Boolean);
}

function generateTaskId(sessionId: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `task-${sessionId}-${Date.now()}-${suffix}`;
}

function asTaskEventMessage(event: TaskEventPayload): ChatMessage {
  return {
    id: event.event_id,
    role: 'task_event',
    content: event.message,
    timestamp: event.timestamp,
    tool_results: { task_event: event },
  };
}

function normalizeTaskBoardItem(raw: unknown): TaskBoardItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = String(item.id || item.task_item_id || '').trim();
  const name = String(item.name || item.task_name || '').trim();
  const statusRaw = String(item.status || '').trim().toLowerCase();
  const status: TaskBoardStatus =
    statusRaw === 'completed' ? 'completed' : statusRaw === 'running' ? 'running' : 'waiting';

  if (!id || !name) return null;

  const createdAt = String(item.created_at || item.createdAt || new Date().toISOString());
  const updatedAt = String(item.updated_at || item.updatedAt || createdAt);
  const description = item.description ? String(item.description) : undefined;
  const completionSummary = item.completion_summary
    ? String(item.completion_summary)
    : item.completionSummary
      ? String(item.completionSummary)
      : undefined;

  return {
    id,
    name,
    status,
    description,
    completionSummary,
    createdAt,
    updatedAt,
  };
}

function upsertTaskBoardItem(items: TaskBoardItem[], nextItem: TaskBoardItem): TaskBoardItem[] {
  const index = items.findIndex((item) => item.id === nextItem.id);
  if (index === -1) {
    return [...items, nextItem];
  }

  const merged: TaskBoardItem = {
    ...items[index],
    ...nextItem,
    description: nextItem.description ?? items[index].description,
    completionSummary: nextItem.completionSummary ?? items[index].completionSummary,
  };
  return [...items.slice(0, index), merged, ...items.slice(index + 1)];
}

function applyTaskEventToBoard(items: TaskBoardItem[], event: TaskEventPayload): TaskBoardItem[] {
  const payload = event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : null;
  const rawTaskItem = payload?.task_item;
  const parsed = normalizeTaskBoardItem(rawTaskItem);
  if (!parsed) {
    return items;
  }

  const eventType = String(event.event_type || '').toLowerCase();
  const explicitStatus =
    eventType === 'task_item_delivered'
      ? 'completed'
      : eventType === 'task_item_started'
        ? 'running'
        : parsed.status;

  const enriched: TaskBoardItem = {
    ...parsed,
    status: explicitStatus,
    updatedAt: event.timestamp || parsed.updatedAt,
    completionSummary: parsed.completionSummary,
  };

  let next = upsertTaskBoardItem(items, enriched);

  if (eventType === 'task_item_started') {
    next = next.map((item) =>
      item.id === enriched.id
        ? item
        : item.status === 'running'
          ? { ...item, status: 'waiting' }
          : item
    );
  }

  return next;
}

function deriveTaskBoardFromMessages(messages: ChatMessage[]): TaskBoardItem[] {
  const taskEvents = messages
    .filter((message) => message.role === 'task_event')
    .map((message) => {
      const payload = (message.tool_results as any)?.task_event;
      return payload && typeof payload === 'object' ? (payload as TaskEventPayload) : null;
    })
    .filter((event): event is TaskEventPayload => Boolean(event))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return taskEvents.reduce<TaskBoardItem[]>((acc, event) => applyTaskEventToBoard(acc, event), []);
}

function normalizeTaskPrompt(raw: unknown): TaskPromptPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const prompt = raw as Record<string, unknown>;
  const promptId = String(prompt.prompt_id || '').trim();
  const question = String(prompt.question || '').trim();
  const optionsRaw = Array.isArray(prompt.options) ? prompt.options : [];
  if (!promptId || !question || optionsRaw.length === 0) return null;

  const options = optionsRaw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item, index) => ({
      id: String(item.id || `opt_${index + 1}`).trim(),
      label: String(item.label || '').trim(),
      description: item.description ? String(item.description) : undefined,
      recommended: Boolean(item.recommended),
    }))
    .filter((item) => item.label.length > 0);

  if (!options.length) return null;

  return {
    prompt_id: promptId,
    question,
    options,
    recommended_option_id: prompt.recommended_option_id
      ? String(prompt.recommended_option_id)
      : undefined,
    allow_other: typeof prompt.allow_other === 'boolean' ? prompt.allow_other : true,
    other_placeholder: prompt.other_placeholder
      ? String(prompt.other_placeholder)
      : undefined,
  };
}

function derivePendingPromptFromMessages(messages: ChatMessage[]): PendingPromptState | null {
  const taskEvents = messages
    .filter((message) => message.role === 'task_event')
    .map((message) => {
      const payload = (message.tool_results as any)?.task_event;
      return payload && typeof payload === 'object' ? (payload as TaskEventPayload) : null;
    })
    .filter((event): event is TaskEventPayload => Boolean(event))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  let pending: PendingPromptState | null = null;
  for (const event of taskEvents) {
    const eventType = String(event.event_type || '').toLowerCase();
    if (eventType === 'user_input_requested') {
      const prompt = normalizeTaskPrompt((event.payload as any)?.prompt);
      if (prompt) {
        pending = {
          taskId: event.task_id,
          prompt,
          requestedAt: event.timestamp,
        };
      }
      continue;
    }

    if (eventType === 'task_resumed' || eventType === 'task_completed' || eventType === 'task_failed' || eventType === 'task_cancelled') {
      pending = null;
    }
  }
  return pending;
}

function pickLatestViewport(viewports: unknown): { file_id?: string; page?: number } | null {
  if (!Array.isArray(viewports) || viewports.length === 0) {
    return null;
  }

  const normalized = viewports
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .sort((a, b) => {
      const aTime = new Date(String(a.timestamp || '')).getTime();
      const bTime = new Date(String(b.timestamp || '')).getTime();
      return bTime - aTime;
    });

  if (normalized.length === 0) {
    return null;
  }
  const latest = normalized[0];
  return {
    file_id: typeof latest.file_id === 'string' ? latest.file_id : undefined,
    page: typeof latest.page === 'number' ? latest.page : undefined,
  };
}

function buildReferencePreamble(references: SessionReferenceItem[]): string {
  if (!references.length) return '';

  const rendered = references
    .slice(-6)
    .map((ref, index) => {
      const snippet = ref.markdown.trim().slice(0, 2200);
      return `Reference ${index + 1} (${ref.sourceFileName}):\n${snippet}`;
    })
    .join('\n\n');

  return [
    'The user provided the following reference snippets from documents.',
    'Use them as high-priority context when answering.',
    rendered,
  ].join('\n\n');
}

const sessionMessageLoadTokens: Record<string, number> = {};

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: {},
      sessionReferences: {},
      loading: false,
      loadingSessions: {},
      activeTasks: {},
      pendingPrompts: {},
      taskBoards: {},
      lastTaskInput: {},
      abortControllers: {},
      error: null,
      sessionId: 'default-session',
      model: DEFAULT_CHAT_MODEL,

      setSessionId: (sessionId) => set({ sessionId }),

      setModel: (model) => set({ model }),

      getCurrentMessages: () => {
        const { messages, sessionId } = get();
        return messages[sessionId] || [];
      },

      getMessagesForSession: (sessionId: string) => get().messages[sessionId] || [],
      getSessionReferences: (sessionId: string) => get().sessionReferences[sessionId] || [],

      isSessionLoading: (sessionId: string) => !!get().loadingSessions[sessionId],

      getActiveTask: (sessionId: string) => get().activeTasks[sessionId] || null,
      getTaskBoard: (sessionId: string) => get().taskBoards[sessionId] || [],
      getPendingPrompt: (sessionId: string) => get().pendingPrompts[sessionId] || null,

      sendMessage: async (message, contextFiles = [], options) => {
        const { sessionId } = get();
        return get().sendMessageForSession(sessionId, message, contextFiles, options);
      },

      sendMessageForSession: async (sessionId, message, contextFiles = [], options = {}) => {
        const existingTask = get().activeTasks[sessionId];
        if (existingTask && (existingTask.status === 'running' || existingTask.status === 'cancelling' || existingTask.status === 'paused')) {
          set({ error: 'A task is active for this session. Resolve it before starting a new one.' });
          return;
        }

        const taskId = generateTaskId(sessionId);
        const now = new Date().toISOString();
        const abortController = new AbortController();

        const userMessage: ChatMessage = {
          id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content: message,
          timestamp: now,
        };

        const localStartEvent: ChatMessage = {
          id: `local-start-${taskId}`,
          role: 'task_event',
          content: 'Task started',
          timestamp: now,
          tool_results: {
            task_event: {
              event_id: `local-start-${taskId}`,
              session_id: sessionId,
              task_id: taskId,
              event_type: 'task_started',
              stage: 'planning',
              message: 'Task started',
              progress: 0,
              status: 'running',
              timestamp: now,
              payload: {},
            },
          },
        };

        set((state) => {
          const loadingSessions = {
            ...state.loadingSessions,
            [sessionId]: true,
          };
          return {
            error: null,
            loadingSessions,
            loading: computeGlobalLoading(loadingSessions),
            abortControllers: {
              ...state.abortControllers,
              [sessionId]: abortController,
            },
            activeTasks: {
              ...state.activeTasks,
              [sessionId]: {
                taskId,
                status: 'running',
                stage: 'planning',
                progress: 0,
                startedAt: now,
                updatedAt: now,
                lastMessage: message,
                contextFiles,
              },
            },
            pendingPrompts: {
              ...state.pendingPrompts,
              [sessionId]: null,
            },
            lastTaskInput: {
              ...state.lastTaskInput,
              [sessionId]: {
                message,
                contextFiles,
              },
            },
            messages: {
              ...state.messages,
              [sessionId]: [...(state.messages[sessionId] || []), userMessage, localStartEvent],
            },
          };
        });

        try {
          const references = get().sessionReferences[sessionId] || [];
          const preamble = buildReferencePreamble(references);
          const modelMessage = preamble
            ? `${preamble}\n\nUser request:\n${message}`
            : message;

          const sessionPermissions = useSessionStore.getState().getSessionPermissions(sessionId);
          let activeFileId = options.activeFileId;
          let activePage = options.activePage;

          if (!activeFileId || typeof activePage !== 'number') {
            try {
              const viewportResponse = await api.getViewport(sessionId);
              if (viewportResponse.success && viewportResponse.data?.viewports) {
                const latest = pickLatestViewport(viewportResponse.data.viewports);
                if (latest) {
                  activeFileId = activeFileId || latest.file_id;
                  if (typeof activePage !== 'number' && typeof latest.page === 'number') {
                    activePage = latest.page;
                  }
                }
              }
            } catch {
              // Viewport context is optional; continue without it.
            }
          }

          const response = await api.chatCompletion(
            sessionId,
            modelMessage,
            contextFiles,
            get().model,
            true,
            {
              permissions: sessionPermissions,
              taskId,
              signal: abortController.signal,
              activeFileId,
              activePage,
              compactMode: options.compactMode || 'auto',
            }
          );

          if (response.success && response.data) {
            const isCancelled = Boolean(response.data.cancelled);
            const isFailed = Boolean(response.data.failed);
            const isPaused = Boolean(response.data.paused);
            const pausedPrompt = normalizeTaskPrompt(response.data.awaiting_user_input);
            const assistantMessage: ChatMessage = {
              id: response.data.message_id,
              role: 'assistant',
              content: response.data.content,
              timestamp: response.data.timestamp,
              tool_calls: response.data.tool_calls,
              tool_results: response.data.tool_results,
              citations: response.data.citations,
            };

            set((state) => {
              const loadingSessions = {
                ...state.loadingSessions,
                [sessionId]: false,
              };
              const existing = state.activeTasks[sessionId];
              const nextMessages = isPaused
                ? (state.messages[sessionId] || [])
                : [...(state.messages[sessionId] || []), assistantMessage];
              return {
                error: isFailed ? response.data.content || 'Task failed' : null,
                messages: {
                  ...state.messages,
                  [sessionId]: nextMessages,
                },
                loadingSessions,
                loading: computeGlobalLoading(loadingSessions),
                activeTasks: {
                  ...state.activeTasks,
                  [sessionId]: existing
                    ? {
                        ...existing,
                        status: isPaused ? 'paused' : isCancelled ? 'cancelled' : isFailed ? 'failed' : 'completed',
                        stage: isPaused ? 'blocked' : isCancelled || isFailed ? 'blocked' : 'done',
                        progress: isPaused ? existing.progress : 100,
                        updatedAt: new Date().toISOString(),
                      }
                    : null,
                },
                pendingPrompts: {
                  ...state.pendingPrompts,
                  [sessionId]: isPaused && pausedPrompt
                    ? {
                        taskId,
                        prompt: pausedPrompt,
                        requestedAt: response.data.timestamp || new Date().toISOString(),
                      }
                    : null,
                },
              };
            });

            useSessionStore.setState((state) => ({
              syncStatus: {
                ...state.syncStatus,
                [sessionId]: true,
              },
            }));
          } else {
            set((state) => {
              const loadingSessions = {
                ...state.loadingSessions,
                [sessionId]: false,
              };
              const existing = state.activeTasks[sessionId];
              return {
                error: response.error || 'Failed to send message',
                loadingSessions,
                loading: computeGlobalLoading(loadingSessions),
                activeTasks: {
                  ...state.activeTasks,
                  [sessionId]: existing
                    ? {
                        ...existing,
                        status: 'failed',
                        stage: 'blocked',
                        updatedAt: new Date().toISOString(),
                      }
                    : null,
                },
                pendingPrompts: {
                  ...state.pendingPrompts,
                  [sessionId]: null,
                },
              };
            });
          }
        } catch (err: any) {
          const isAbort = err?.name === 'AbortError';

          set((state) => {
            const loadingSessions = {
              ...state.loadingSessions,
              [sessionId]: false,
            };
            const existing = state.activeTasks[sessionId];
            return {
              error: isAbort ? null : 'Failed to connect to server',
              loadingSessions,
              loading: computeGlobalLoading(loadingSessions),
              activeTasks: {
                ...state.activeTasks,
                [sessionId]: existing
                  ? {
                      ...existing,
                      status: isAbort ? 'cancelled' : 'failed',
                      stage: 'blocked',
                      updatedAt: new Date().toISOString(),
                    }
                  : null,
              },
              pendingPrompts: {
                ...state.pendingPrompts,
                [sessionId]: null,
              },
            };
          });
        } finally {
          set((state) => ({
            abortControllers: {
              ...state.abortControllers,
              [sessionId]: null,
            },
          }));
        }
      },

      ingestTaskEvent: (sessionId: string, event: TaskEventPayload) => {
        set((state) => {
          const currentMessages = state.messages[sessionId] || [];
          const duplicated = currentMessages.some((msg) => msg.id === event.event_id);
          const messages = duplicated
            ? state.messages
            : {
                ...state.messages,
                [sessionId]: [...currentMessages, asTaskEventMessage(event)],
              };

          const prevTask = state.activeTasks[sessionId];
          const nextTask: ActiveTaskState = prevTask && prevTask.taskId === event.task_id
            ? {
                ...prevTask,
                status: event.status,
                stage: event.stage,
                progress: event.progress,
                updatedAt: event.timestamp,
                lastMessage: event.message || prevTask.lastMessage,
              }
            : {
                taskId: event.task_id,
                status: event.status,
                stage: event.stage,
                progress: event.progress,
                startedAt: event.timestamp,
                updatedAt: event.timestamp,
                lastMessage: event.message || prevTask?.lastMessage || '',
                contextFiles: prevTask?.contextFiles || [],
              };

          const isRunning = event.status === 'running' || event.status === 'cancelling';
          const loadingSessions = {
            ...state.loadingSessions,
            [sessionId]: isRunning,
          };

          const eventType = String(event.event_type || '').toLowerCase();
          let nextPendingPrompt = state.pendingPrompts[sessionId] || null;
          if (eventType === 'user_input_requested') {
            const prompt = normalizeTaskPrompt((event.payload as any)?.prompt);
            if (prompt) {
              nextPendingPrompt = {
                taskId: event.task_id,
                prompt,
                requestedAt: event.timestamp,
              };
            }
          } else if (
            eventType === 'task_resumed'
            || eventType === 'task_completed'
            || eventType === 'task_failed'
            || eventType === 'task_cancelled'
          ) {
            nextPendingPrompt = null;
          }

          return {
            messages,
            loadingSessions,
            loading: computeGlobalLoading(loadingSessions),
            activeTasks: {
              ...state.activeTasks,
              [sessionId]: nextTask,
            },
            taskBoards: {
              ...state.taskBoards,
              [sessionId]: applyTaskEventToBoard(state.taskBoards[sessionId] || [], event),
            },
            pendingPrompts: {
              ...state.pendingPrompts,
              [sessionId]: nextPendingPrompt,
            },
          };
        });
      },

      cancelActiveTask: async (sessionId: string) => {
        const task = get().activeTasks[sessionId];
        if (!task || (task.status !== 'running' && task.status !== 'cancelling' && task.status !== 'paused')) {
          return;
        }

        const now = new Date().toISOString();

        set((state) => ({
          activeTasks: {
            ...state.activeTasks,
            [sessionId]: {
              ...task,
              status: 'cancelling',
              stage: 'blocked',
              updatedAt: now,
            },
          },
          messages: {
            ...state.messages,
            [sessionId]: [
              ...(state.messages[sessionId] || []),
              {
                id: `local-cancel-${task.taskId}-${Date.now()}`,
                role: 'task_event',
                content: 'Cancellation requested',
                timestamp: now,
                tool_results: {
                  task_event: {
                    event_id: `local-cancel-${task.taskId}-${Date.now()}`,
                    session_id: sessionId,
                    task_id: task.taskId,
                    event_type: 'cancel_requested',
                    stage: 'blocked',
                    message: 'Cancellation requested',
                    progress: null,
                    status: 'cancelling',
                    timestamp: now,
                    payload: {},
                  },
                },
              },
            ],
          },
          pendingPrompts: {
            ...state.pendingPrompts,
            [sessionId]: null,
          },
        }));

        try {
          await api.cancelTask(sessionId, task.taskId);
        } catch {
          // Ignore cancel API errors; local abort still proceeds.
        }

        const controller = get().abortControllers[sessionId];
        if (controller) {
          controller.abort();
        }
      },

      retryLastTask: async (sessionId: string) => {
        const runningTask = get().activeTasks[sessionId];
        if (runningTask && (runningTask.status === 'running' || runningTask.status === 'cancelling' || runningTask.status === 'paused')) {
          set({ error: 'A task is still running. Cancel it before retrying.' });
          return;
        }

        const snapshot = get().lastTaskInput[sessionId];
        if (!snapshot) {
          set({ error: 'No task input found to retry for this session.' });
          return;
        }

        await get().sendMessageForSession(sessionId, snapshot.message, snapshot.contextFiles);
      },

      answerTaskPrompt: async (sessionId, taskId, payload) => {
        const pending = get().pendingPrompts[sessionId];
        if (!pending || pending.taskId !== taskId) {
          set({ error: 'No pending prompt found for this task.' });
          return;
        }

        const optionLabel = payload.selectedOptionId
          ? pending.prompt.options.find((option) => option.id === payload.selectedOptionId)?.label
          : payload.otherText?.trim();
        const answerText = optionLabel || payload.selectedOptionId || payload.otherText || '';
        const now = new Date().toISOString();
        const userMessage: ChatMessage = {
          id: `user-answer-${taskId}-${Date.now()}`,
          role: 'user',
          content: `[Paused Prompt Answer] ${answerText}`,
          timestamp: now,
        };

        set((state) => {
          const loadingSessions = {
            ...state.loadingSessions,
            [sessionId]: true,
          };
          const existing = state.activeTasks[sessionId];
          return {
            error: null,
            loadingSessions,
            loading: computeGlobalLoading(loadingSessions),
            messages: {
              ...state.messages,
              [sessionId]: [...(state.messages[sessionId] || []), userMessage],
            },
            activeTasks: {
              ...state.activeTasks,
              [sessionId]: existing
                ? {
                    ...existing,
                    status: 'running',
                    stage: 'executing',
                    updatedAt: now,
                  }
                : null,
            },
          };
        });

        try {
          const response = await api.answerTaskPrompt(sessionId, taskId, {
            promptId: payload.promptId,
            selectedOptionId: payload.selectedOptionId,
            otherText: payload.otherText,
          });

          if (response.success && response.data) {
            const isCancelled = Boolean(response.data.cancelled);
            const isFailed = Boolean(response.data.failed);
            const isPaused = Boolean(response.data.paused);
            const pausedPrompt = normalizeTaskPrompt(response.data.awaiting_user_input);
            const assistantMessage: ChatMessage = {
              id: response.data.message_id,
              role: 'assistant',
              content: response.data.content,
              timestamp: response.data.timestamp,
              tool_calls: response.data.tool_calls,
              tool_results: response.data.tool_results,
              citations: response.data.citations,
            };

            set((state) => {
              const loadingSessions = {
                ...state.loadingSessions,
                [sessionId]: false,
              };
              const existing = state.activeTasks[sessionId];
              const nextMessages = isPaused
                ? (state.messages[sessionId] || [])
                : [...(state.messages[sessionId] || []), assistantMessage];
              return {
                error: isFailed ? response.data.content || 'Task failed' : null,
                messages: {
                  ...state.messages,
                  [sessionId]: nextMessages,
                },
                loadingSessions,
                loading: computeGlobalLoading(loadingSessions),
                activeTasks: {
                  ...state.activeTasks,
                  [sessionId]: existing
                    ? {
                        ...existing,
                        status: isPaused ? 'paused' : isCancelled ? 'cancelled' : isFailed ? 'failed' : 'completed',
                        stage: isPaused ? 'blocked' : isCancelled || isFailed ? 'blocked' : 'done',
                        progress: isPaused ? existing.progress : 100,
                        updatedAt: new Date().toISOString(),
                      }
                    : null,
                },
                pendingPrompts: {
                  ...state.pendingPrompts,
                  [sessionId]: isPaused && pausedPrompt
                    ? {
                        taskId,
                        prompt: pausedPrompt,
                        requestedAt: response.data.timestamp || new Date().toISOString(),
                      }
                    : null,
                },
              };
            });
          } else {
            set((state) => {
              const loadingSessions = {
                ...state.loadingSessions,
                [sessionId]: false,
              };
              const existing = state.activeTasks[sessionId];
              return {
                error: response.error || 'Failed to answer prompt',
                loadingSessions,
                loading: computeGlobalLoading(loadingSessions),
                activeTasks: {
                  ...state.activeTasks,
                  [sessionId]: existing
                    ? {
                        ...existing,
                        status: 'failed',
                        stage: 'blocked',
                        updatedAt: new Date().toISOString(),
                      }
                    : null,
                },
              };
            });
          }
        } catch {
          set((state) => {
            const loadingSessions = {
              ...state.loadingSessions,
              [sessionId]: false,
            };
            const existing = state.activeTasks[sessionId];
            return {
              error: 'Failed to answer prompt',
              loadingSessions,
              loading: computeGlobalLoading(loadingSessions),
              activeTasks: {
                ...state.activeTasks,
                [sessionId]: existing
                  ? {
                      ...existing,
                      status: 'failed',
                      stage: 'blocked',
                      updatedAt: new Date().toISOString(),
                    }
                  : null,
              },
            };
          });
        }
      },

      clearMessages: () => {
        const { sessionId } = get();
        set((state) => ({
          messages: {
            ...state.messages,
            [sessionId]: [],
          },
          activeTasks: {
            ...state.activeTasks,
            [sessionId]: null,
          },
          taskBoards: {
            ...state.taskBoards,
            [sessionId]: [],
          },
          pendingPrompts: {
            ...state.pendingPrompts,
            [sessionId]: null,
          },
          lastTaskInput: {
            ...state.lastTaskInput,
            [sessionId]: null,
          },
          error: null,
        }));
      },

      clearSessionMessages: (sessionId: string) => {
        set((state) => {
          const { [sessionId]: _, ...restMessages } = state.messages;
          const { [sessionId]: _______, ...restReferences } = state.sessionReferences;
          const { [sessionId]: __, ...restLoading } = state.loadingSessions;
          const { [sessionId]: ___, ...restTasks } = state.activeTasks;
          const { [sessionId]: ____, ...restBoards } = state.taskBoards;
          const { [sessionId]: _____pending, ...restPending } = state.pendingPrompts;
          const { [sessionId]: _____, ...restInputs } = state.lastTaskInput;
          const { [sessionId]: ______, ...restControllers } = state.abortControllers;
          return {
            messages: restMessages,
            sessionReferences: restReferences,
            loadingSessions: restLoading,
            loading: computeGlobalLoading(restLoading),
            activeTasks: restTasks,
            taskBoards: restBoards,
            pendingPrompts: restPending,
            lastTaskInput: restInputs,
            abortControllers: restControllers,
          };
        });
      },

      addSessionReference: (sessionId, reference) => {
        const markdown = reference.markdown.trim();
        const plainText = (reference.plainText || reference.markdown).trim();
        if (!markdown) return;

        const now = new Date().toISOString();
        const existing = get().sessionReferences[sessionId] || [];
        const duplicated = existing.some(
          (item) => item.sourceFileId === reference.sourceFileId && item.markdown === markdown
        );
        if (duplicated) return;

        set((state) => ({
          sessionReferences: {
            ...state.sessionReferences,
            [sessionId]: [
              ...existing,
              {
                id: `ref-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                sourceFileId: reference.sourceFileId,
                sourceFileName: reference.sourceFileName,
                markdown,
                plainText,
                createdAt: now,
              },
            ],
          },
        }));
      },

      removeSessionReference: (sessionId, referenceId) => {
        set((state) => ({
          sessionReferences: {
            ...state.sessionReferences,
            [sessionId]: (state.sessionReferences[sessionId] || []).filter((item) => item.id !== referenceId),
          },
        }));
      },

      clearSessionReferences: (sessionId) => {
        set((state) => ({
          sessionReferences: {
            ...state.sessionReferences,
            [sessionId]: [],
          },
        }));
      },

      loadSessionMessages: async (sessionId: string) => {
        const requestToken = (sessionMessageLoadTokens[sessionId] || 0) + 1;
        sessionMessageLoadTokens[sessionId] = requestToken;
        try {
          const response = await api.getSessionMessages(sessionId);
          if (sessionMessageLoadTokens[sessionId] !== requestToken) return;
          if (response.success && response.data) {
            const messages = response.data.messages;
            if (messages) {
              set((state) => {
                if (sessionMessageLoadTokens[sessionId] !== requestToken) {
                  return state;
                }
                return {
                  messages: {
                    ...state.messages,
                    [sessionId]: messages,
                  },
                  taskBoards: {
                    ...state.taskBoards,
                    [sessionId]: deriveTaskBoardFromMessages(messages),
                  },
                  pendingPrompts: {
                    ...state.pendingPrompts,
                    [sessionId]: derivePendingPromptFromMessages(messages),
                  },
                };
              });
            }
          }
        } catch (err) {
          if (sessionMessageLoadTokens[sessionId] !== requestToken) return;
          console.error('Failed to load session messages:', err);
        }
      },
    }),
    {
      name: 'chat-storage',
      partialize: (state) => ({
        messages: state.messages,
        sessionReferences: state.sessionReferences,
        sessionId: state.sessionId,
        model: state.model,
        activeTasks: state.activeTasks,
        taskBoards: state.taskBoards,
        pendingPrompts: state.pendingPrompts,
        lastTaskInput: state.lastTaskInput,
      }),
    }
  )
);
