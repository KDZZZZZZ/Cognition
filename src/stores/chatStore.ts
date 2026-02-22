import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../api/client';
import type { ChatMessage, TaskEventPayload, TaskStatus } from '../api/client';
import { useSessionStore } from './sessionStore';

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

interface SendMessageOptions {
  activeFileId?: string;
  activePage?: number;
  compactMode?: 'auto' | 'off' | 'force';
}

interface ChatState {
  messages: Record<string, ChatMessage[]>;
  loading: boolean;
  loadingSessions: Record<string, boolean>;
  activeTasks: Record<string, ActiveTaskState | null>;
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
  clearMessages: () => void;
  clearSessionMessages: (sessionId: string) => void;
  getCurrentMessages: () => ChatMessage[];
  getMessagesForSession: (sessionId: string) => ChatMessage[];
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

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: {},
      loading: false,
      loadingSessions: {},
      activeTasks: {},
      lastTaskInput: {},
      abortControllers: {},
      error: null,
      sessionId: 'default-session',
      model: 'qwen-plus',

      setSessionId: (sessionId) => set({ sessionId }),

      setModel: (model) => set({ model }),

      getCurrentMessages: () => {
        const { messages, sessionId } = get();
        return messages[sessionId] || [];
      },

      getMessagesForSession: (sessionId: string) => get().messages[sessionId] || [],

      isSessionLoading: (sessionId: string) => !!get().loadingSessions[sessionId],

      getActiveTask: (sessionId: string) => get().activeTasks[sessionId] || null,

      sendMessage: async (message, contextFiles = [], options) => {
        const { sessionId } = get();
        return get().sendMessageForSession(sessionId, message, contextFiles, options);
      },

      sendMessageForSession: async (sessionId, message, contextFiles = [], options = {}) => {
        const existingTask = get().activeTasks[sessionId];
        if (existingTask && (existingTask.status === 'running' || existingTask.status === 'cancelling')) {
          set({ error: 'A task is already running for this session. Cancel it before starting a new one.' });
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
            message,
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
              return {
                messages: {
                  ...state.messages,
                  [sessionId]: [...(state.messages[sessionId] || []), assistantMessage],
                },
                loadingSessions,
                loading: computeGlobalLoading(loadingSessions),
                activeTasks: {
                  ...state.activeTasks,
                  [sessionId]: existing
                    ? {
                        ...existing,
                        status: response.data.cancelled ? 'cancelled' : 'completed',
                        stage: response.data.cancelled ? 'blocked' : 'done',
                        progress: 100,
                        updatedAt: new Date().toISOString(),
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
              }
            : {
                taskId: event.task_id,
                status: event.status,
                stage: event.stage,
                progress: event.progress,
                startedAt: event.timestamp,
                updatedAt: event.timestamp,
                lastMessage: prevTask?.lastMessage || '',
                contextFiles: prevTask?.contextFiles || [],
              };

          const isRunning = event.status === 'running' || event.status === 'cancelling';
          const loadingSessions = {
            ...state.loadingSessions,
            [sessionId]: isRunning,
          };

          return {
            messages,
            loadingSessions,
            loading: computeGlobalLoading(loadingSessions),
            activeTasks: {
              ...state.activeTasks,
              [sessionId]: nextTask,
            },
          };
        });
      },

      cancelActiveTask: async (sessionId: string) => {
        const task = get().activeTasks[sessionId];
        if (!task || (task.status !== 'running' && task.status !== 'cancelling')) {
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
        if (runningTask && (runningTask.status === 'running' || runningTask.status === 'cancelling')) {
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
          const { [sessionId]: __, ...restLoading } = state.loadingSessions;
          const { [sessionId]: ___, ...restTasks } = state.activeTasks;
          const { [sessionId]: ____, ...restInputs } = state.lastTaskInput;
          const { [sessionId]: _____, ...restControllers } = state.abortControllers;
          return {
            messages: restMessages,
            loadingSessions: restLoading,
            loading: computeGlobalLoading(restLoading),
            activeTasks: restTasks,
            lastTaskInput: restInputs,
            abortControllers: restControllers,
          };
        });
      },

      loadSessionMessages: async (sessionId: string) => {
        try {
          const response = await api.getSessionMessages(sessionId);
          if (response.success && response.data) {
            const messages = response.data.messages;
            if (messages) {
              set((state) => ({
                messages: {
                  ...state.messages,
                  [sessionId]: messages,
                },
              }));
            }
          }
        } catch (err) {
          console.error('Failed to load session messages:', err);
        }
      },
    }),
    {
      name: 'chat-storage',
      partialize: (state) => ({
        messages: state.messages,
        sessionId: state.sessionId,
        model: state.model,
        activeTasks: state.activeTasks,
        lastTaskInput: state.lastTaskInput,
      }),
    }
  )
);
