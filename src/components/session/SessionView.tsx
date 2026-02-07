import { useState, useEffect, useRef, useCallback } from 'react';
import { Bot, Send, Brain, Loader2, CloudOff, Check } from 'lucide-react';
import { PermissionToggle } from '../ui/PermissionToggle';
import { FileIcon } from '../ui/FileIcon';
import { Tab, Permission } from '../../types';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { api } from '../../api/client';

interface SessionViewProps {
  sessionId: string;
  allFiles: Tab[];
  permissions: Record<string, Permission>;
  onTogglePermission: (fileId: string) => void;
}

export function SessionView({ sessionId, allFiles, permissions, onTogglePermission }: SessionViewProps) {
  const { getMessagesForSession, loading, error, model, sendMessageForSession, loadSessionMessages } = useChatStore();
  const { loadPermissionsFromBackend, isSynced } = useSessionStore();
  const messages = getMessagesForSession(sessionId);
  const [input, setInput] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'checking' | 'connected' | 'error'>('checking');
  const [syncing, setSyncing] = useState(false);
  const [syncingFileId, setSyncingFileId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load session messages and permissions when sessionId changes
  useEffect(() => {
    if (sessionId) {
      loadSessionMessages(sessionId);

      // Load permissions from backend to ensure alignment
      const syncPermissions = async () => {
        setSyncing(true);
        await loadPermissionsFromBackend(sessionId);
        setSyncing(false);
      };
      syncPermissions();
    }
  }, [sessionId, loadSessionMessages, loadPermissionsFromBackend]);

  // Check backend connection
  useEffect(() => {
    api.health().then(res => {
      if (res.success) {
        setConnectionStatus('connected');
      } else {
        setConnectionStatus('error');
      }
    }).catch(() => setConnectionStatus('error'));
  }, []);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || loading) return;

    const message = input;
    setInput('');

    const contextFiles = Object.entries(permissions)
      .filter(([_, perm]) => perm !== 'none')
      .map(([fileId, _]) => fileId);

    await sendMessageForSession(sessionId, message, contextFiles);
  }, [input, loading, permissions, sessionId, sendMessageForSession]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    useChatStore.getState().setModel(e.target.value as any);
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Header with Model Selection */}
      <div className="bg-white border-b border-gray-200 px-4 py-2 shadow-sm z-10">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wider flex items-center gap-2">
            <Bot size={14} /> <span>AI Assistant</span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={model}
              onChange={handleModelChange}
              className="text-xs border border-gray-300 rounded px-2 py-1"
            >
              <option value="deepseek-chat">DeepSeek Chat</option>
              <option value="deepseek-reasoner">DeepSeek Reasoner</option>
            </select>
            {connectionStatus === 'connected' ? (
              <span className="text-xs text-green-500 flex items-center gap-1">
                <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                Connected
              </span>
            ) : connectionStatus === 'error' ? (
              <span className="text-xs text-red-500 flex items-center gap-1">
                <CloudOff size={12} />
                Offline
              </span>
            ) : (
              <span className="text-xs text-gray-400 flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" />
                Checking...
              </span>
            )}
            {/* Permission sync status indicator */}
            {isSynced(sessionId) && !syncing && connectionStatus === 'connected' && (
              <span className="text-xs text-blue-500 flex items-center gap-1" title="Permissions synced with backend">
                <Check size={12} />
              </span>
            )}
          </div>
        </div>

        {/* Context Permissions */}
        <div className="flex items-center gap-2">
          <div className="text-xs text-gray-400">Context Files:</div>
          {syncing && (
            <span className="text-xs text-blue-500 flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              Syncing permissions...
            </span>
          )}
        </div>
        {allFiles.length === 0 ? (
          <div className="text-xs text-gray-400 italic">No files open.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {allFiles.map((file) => {
              const status = permissions[file.id] || 'read';
              const isFileSyncing = syncingFileId === file.id;
              return (
                <div
                  key={file.id}
                  className={`flex items-center gap-2 bg-white border border-gray-200 rounded-md pl-2 pr-1 py-1 text-xs shadow-sm transition-all ${
                    status === 'none' ? 'opacity-50' : 'opacity-100'
                  }`}
                >
                  <FileIcon type={file.type} />
                  <span className="max-w-[80px] truncate font-medium text-gray-700">
                    {file.name}
                  </span>
                  <div className="h-4 w-px bg-gray-200 mx-1"></div>
                  <PermissionToggle
                    status={status}
                    syncing={isFileSyncing}
                    onClick={() => {
                      setSyncingFileId(file.id);
                      onTogglePermission(file.id);
                      // Reset syncing state after a short delay
                      setTimeout(() => setSyncingFileId(null), 500);
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 p-4 overflow-y-auto space-y-4">
        {messages.length === 0 && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 flex-shrink-0">
              <Bot size={18} />
            </div>
            <div className="bg-white p-3 rounded-lg rounded-tl-none border border-gray-200 shadow-sm text-sm text-gray-700 max-w-[85%]">
              <p className="mb-2">Hello! I'm your AI assistant. I can help you:</p>
              <ul className="list-disc list-inside text-gray-600 space-y-1">
                <li>Summarize documents</li>
                <li>Answer questions about content</li>
                <li>Edit and improve your writing</li>
                <li>Search across multiple files</li>
              </ul>
              <p className="mt-2 text-xs text-gray-400">
                {model === 'deepseek-reasoner' && (
                  <span className="flex items-center gap-1">
                    <Brain size={12} /> Deep reasoning mode enabled
                  </span>
                )}
              </p>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
            {msg.role === 'assistant' && (
              <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 flex-shrink-0">
                <Bot size={18} />
              </div>
            )}
            <div className={`max-w-[85%] ${
              msg.role === 'user'
                ? 'bg-blue-500 text-white rounded-lg rounded-tr-none px-4 py-2'
                : 'bg-white p-3 rounded-lg rounded-tl-none border border-gray-200 shadow-sm text-sm text-gray-700'
            }`}>
              {msg.role === 'assistant' && msg.tool_calls && (
                <div className="text-xs text-purple-600 mb-2 pb-2 border-b border-purple-100">
                  <span className="font-medium">Used tools:</span> {msg.tool_calls.map((t: any) => t.name).join(', ')}
                </div>
              )}
              <div className="whitespace-pre-wrap">{msg.content}</div>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-purple-100 flex items-center justify-center text-purple-600 flex-shrink-0">
              <Bot size={18} />
            </div>
            <div className="bg-white px-4 py-3 rounded-lg rounded-tl-none border border-gray-200 shadow-sm text-sm">
              <Loader2 size={14} className="animate-spin text-purple-500" />
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 text-red-600 px-4 py-2 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-gray-200 bg-white">
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
            className="w-full pl-4 pr-10 py-2.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-200 text-sm resize-none"
            rows={2}
            disabled={loading}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="absolute right-2 bottom-2 p-1.5 text-purple-600 hover:bg-purple-50 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
