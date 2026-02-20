import { useState, useEffect, useRef, useCallback } from 'react';
import { Bot, Send, Loader2, CloudOff, Check } from 'lucide-react';
import { PermissionToggle } from '../ui/PermissionToggle';
import { FileIcon } from '../ui/FileIcon';
import { Tab, Permission } from '../../types';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { api } from '../../api/client';
import { useWebSocket } from '../../hooks/useWebSocket';

interface SessionViewProps {
  sessionId: string;
  allFiles: Tab[];
  permissions: Record<string, Permission>;
  onTogglePermission: (fileId: string) => void;
}

export function SessionView({ sessionId, allFiles, permissions, onTogglePermission }: SessionViewProps) {
  const { getMessagesForSession, loading, error, sendMessageForSession, loadSessionMessages } = useChatStore();
  const { loadPermissionsFromBackend, isSynced } = useSessionStore();
  const messages = getMessagesForSession(sessionId);
  const [input, setInput] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'checking' | 'connected' | 'error'>('checking');
  const [syncing, setSyncing] = useState(false);
  const [syncingFileId, setSyncingFileId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useWebSocket(sessionId);

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

    const contextFiles = allFiles
      .filter((file) => file.type !== 'session')
      .filter((file) => (permissions[file.id] || 'read') !== 'none')
      .map((file) => file.id);

    await sendMessageForSession(sessionId, message, contextFiles);
    window.dispatchEvent(new CustomEvent('assistant-message-finished', { detail: { sessionId } }));
  }, [allFiles, input, loading, permissions, sessionId, sendMessageForSession]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-theme-bg/30">
      {/* Header */}
      <div className="bg-theme-bg border-b border-theme-border/20 px-4 py-2 shadow-sm z-10">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-bold text-theme-text/60 uppercase tracking-wider flex items-center gap-2">
            <Bot size={14} /> <span>AI Assistant</span>
          </div>
          <div className="flex items-center gap-2">
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
              <span className="text-xs text-theme-text/40 flex items-center gap-1">
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
          <div className="text-xs text-theme-text/40">Context Files:</div>
          {syncing && (
            <span className="text-xs text-blue-500 flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              Syncing permissions...
            </span>
          )}
        </div>
        {allFiles.length === 0 ? (
          <div className="text-xs text-theme-text/40 italic">No files open.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {allFiles.filter((f) => f.type !== 'session').map((file) => {
              const status = permissions[file.id] || 'read';
              const isFileSyncing = syncingFileId === file.id;
              return (
                <div
                  key={file.id}
                  className={`flex items-center gap-2 bg-theme-bg border border-theme-border/20 rounded-md pl-2 pr-1 py-1 text-xs shadow-sm transition-all ${
                    status === 'none' ? 'opacity-50' : 'opacity-100'
                  }`}
                >
                  <FileIcon type={file.type} />
                  <span className="max-w-[80px] truncate font-medium text-theme-text/80">
                    {file.name}
                  </span>
                  <div className="h-4 w-px bg-theme-border/20 mx-1"></div>
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
            <div className="w-8 h-8 rounded-full bg-theme-text/10 flex items-center justify-center text-theme-text flex-shrink-0">
              <Bot size={18} />
            </div>
            <div className="bg-theme-bg p-3 rounded-lg rounded-tl-none border border-theme-border/20 shadow-sm text-sm text-theme-text/80 max-w-[85%]">
              <p className="mb-2">Hello! I'm your AI assistant. I can help you:</p>
              <ul className="list-disc list-inside text-theme-text/70 space-y-1">
                <li>Summarize documents</li>
                <li>Answer questions about content</li>
                <li>Edit and improve your writing</li>
                <li>Search across multiple files</li>
              </ul>
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
            {msg.role === 'assistant' && (
              <div className="w-8 h-8 rounded-full bg-theme-text/10 flex items-center justify-center text-theme-text flex-shrink-0">
                <Bot size={18} />
              </div>
            )}
            <div className={`max-w-[85%] ${
              msg.role === 'user'
                ? 'bg-theme-text text-theme-bg rounded-lg rounded-tr-none px-4 py-2'
                : 'bg-theme-bg p-3 rounded-lg rounded-tl-none border border-theme-border/20 shadow-sm text-sm text-theme-text/80'
            }`}>
              {msg.role === 'assistant' && msg.tool_calls && (
                <div className="text-xs text-theme-text/60 mb-2 pb-2 border-b border-theme-border/10">
                  <span className="font-medium">Used tools:</span> {msg.tool_calls.map((t: any) => t.name).join(', ')}
                </div>
              )}
              <div className="whitespace-pre-wrap">{msg.content}</div>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-theme-text/10 flex items-center justify-center text-theme-text flex-shrink-0">
              <Bot size={18} />
            </div>
            <div className="bg-theme-bg px-4 py-3 rounded-lg rounded-tl-none border border-theme-border/20 shadow-sm text-sm">
              <Loader2 size={14} className="animate-spin text-theme-text" />
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
      <div className="p-4 border-t border-theme-border/20 bg-theme-bg">
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
            className="w-full pl-4 pr-10 py-2.5 border border-theme-border/30 bg-theme-bg text-theme-text rounded-lg focus:outline-none focus:ring-2 focus:ring-theme-text/20 text-sm resize-none placeholder:text-theme-text/30"
            rows={2}
            disabled={loading}
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="absolute right-2 bottom-2 p-1.5 text-theme-text hover:bg-theme-text/10 rounded disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
