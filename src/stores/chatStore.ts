import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '../api/client';
import type { ChatMessage } from '../api/client';
import { useSessionStore } from './sessionStore';

interface ChatState {
  messages: Record<string, ChatMessage[]>;
  loading: boolean;
  error: string | null;
  sessionId: string;
  model: 'deepseek-chat' | 'deepseek-reasoner';

  // Actions
  setSessionId: (sessionId: string) => void;
  setModel: (model: 'deepseek-chat' | 'deepseek-reasoner') => void;
  sendMessage: (message: string, contextFiles: string[]) => Promise<void>;
  sendMessageForSession: (sessionId: string, message: string, contextFiles: string[]) => Promise<void>;
  clearMessages: () => void;
  clearSessionMessages: (sessionId: string) => void;
  getCurrentMessages: () => ChatMessage[];
  getMessagesForSession: (sessionId: string) => ChatMessage[];
  loadSessionMessages: (sessionId: string) => Promise<void>;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: {},
      loading: false,
      error: null,
      sessionId: 'default-session',
      model: 'deepseek-chat',

      setSessionId: (sessionId) => set({ sessionId }),

      setModel: (model) => set({ model }),

      getCurrentMessages: () => {
        const { messages, sessionId } = get();
        return messages[sessionId] || [];
      },

      getMessagesForSession: (sessionId: string) => {
        return get().messages[sessionId] || [];
      },

      sendMessage: async (message, contextFiles = []) => {
        const { sessionId } = get();
        return get().sendMessageForSession(sessionId, message, contextFiles);
      },

      sendMessageForSession: async (sessionId, message, contextFiles = []) => {
        set({ loading: true, error: null });

        // Add user message
        const userMessage: ChatMessage = {
          id: Date.now().toString(),
          role: 'user',
          content: message,
          timestamp: new Date().toISOString(),
        };

        set((state) => ({
          messages: {
            ...state.messages,
            [sessionId]: [...(state.messages[sessionId] || []), userMessage],
          },
        }));

        try {
          // Get permissions for this session to sync with backend
          const sessionPermissions = useSessionStore.getState().getSessionPermissions(sessionId);

          const response = await api.chatCompletion(
            sessionId,
            message,
            contextFiles,
            get().model,
            true,
            sessionPermissions  // Pass permissions to initialize/update session
          );

          if (response.success && response.data) {
            const assistantMessage: ChatMessage = {
              id: response.data.message_id,
              role: 'assistant',
              content: response.data.content,
              timestamp: response.data.timestamp,
              tool_calls: response.data.tool_calls,
            };
            set((state) => ({
              messages: {
                ...state.messages,
                [sessionId]: [...(state.messages[sessionId] || []), assistantMessage],
              },
              loading: false,
            }));

            // Mark session as synced after successful message
            // Use the sessionStore's internal state update
            useSessionStore.setState((state) => ({
              syncStatus: {
                ...state.syncStatus,
                [sessionId]: true,
              },
            }));
          } else {
            set({ error: response.error || 'Failed to send message', loading: false });
          }
        } catch (err) {
          set({ error: 'Failed to connect to server', loading: false });
        }
      },

      clearMessages: () => {
        const { sessionId } = get();
        set((state) => ({
          messages: {
            ...state.messages,
            [sessionId]: [],
          },
          error: null,
        }));
      },

      clearSessionMessages: (sessionId: string) => {
        set((state) => {
          const { [sessionId]: _, ...rest } = state.messages;
          return { messages: rest };
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
      }),
    }
  )
);
