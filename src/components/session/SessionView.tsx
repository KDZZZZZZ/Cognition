import { useState, useEffect, useRef, useCallback } from 'react';
import { Bot, Send, Loader2, Check, Activity, RotateCcw, Square, Layers3, Link2, X, ChevronDown, ChevronUp } from 'lucide-react';
import { PermissionToggle } from '../ui/PermissionToggle';
import { FileIcon } from '../ui/FileIcon';
import { MarkdownContent } from '../ui/MarkdownContent';
import { Tab, Permission, FileType } from '../../types';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useWebSocket } from '../../hooks/useWebSocket';
import {
  applyAssistantStreamEvent,
  extractToolCalls,
  extractToolResults,
  formatJsonPreview,
  inferActionKind,
  shouldClearAssistantPreview,
  StreamingAssistantState,
  summarizeIndexStatus,
  supportsIndexWarmup,
  FileIndexStatusSnapshot,
} from './sessionViewUtils';
import { api } from '../../api/client';

interface SessionViewProps {
  sessionId: string;
  allFiles: Tab[];
  permissions: Record<string, Permission>;
  onTogglePermission: (fileId: string, fileType: FileType) => void;
}

const TASK_STATUS_STYLES: Record<string, string> = {
  running: 'border-amber-600/35 bg-amber-50/80 text-amber-900',
  cancelling: 'border-orange-600/30 bg-orange-50/80 text-orange-900',
  paused: 'border-blue-600/30 bg-blue-50/80 text-blue-900',
  failed: 'border-red-600/30 bg-red-50/80 text-red-900',
  cancelled: 'border-slate-600/25 bg-slate-100/80 text-slate-800',
  completed: 'border-green-600/30 bg-green-50/80 text-green-900',
};

const REGISTRY_ITEM_STYLES: Record<string, string> = {
  pending: 'border border-theme-border/20 bg-theme-bg/80 opacity-60',
  running: 'border border-black/75 bg-theme-surface shadow-[0_2px_10px_rgba(0,0,0,0.08)]',
  blocked: 'border border-amber-500/35 bg-amber-50/70',
  completed: 'border border-theme-border/25 bg-theme-surface',
  cancelled: 'border border-theme-border/25 bg-theme-bg/70 opacity-70',
};

function formatElapsedLabel(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0s';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function getEffectivePermission(file: Tab, permissions: Record<string, Permission>): Permission {
  const raw = permissions[file.id] || 'read';
  if (file.type !== 'md' && raw === 'write') {
    return 'read';
  }
  return raw;
}

export function SessionView({ sessionId, allFiles, permissions, onTogglePermission }: SessionViewProps) {
  const {
    getMessagesForSession,
    isSessionLoading,
    getActiveTask,
    getTaskRegistry,
    getPendingPrompt,
    getSessionReferences,
    removeSessionReference,
    clearSessionReferences,
    error,
    sendMessageForSession,
    loadSessionMessages,
    ingestTaskEvent,
    cancelActiveTask,
    retryLastTask,
    answerTaskPrompt,
  } = useChatStore();
  const { loadPermissionsFromBackend, isSynced } = useSessionStore();
  const messages = getMessagesForSession(sessionId);
  const taskRegistry = getTaskRegistry(sessionId);
  const registryTasks = taskRegistry?.tasks || [];
  const pendingPrompt = getPendingPrompt(sessionId);
  const sessionReferences = getSessionReferences(sessionId);
  const loading = isSessionLoading(sessionId);
  const activeTask = getActiveTask(sessionId);
  const activeTaskId = activeTask?.taskId;
  const activeTaskStatus = activeTask?.status;
  const isTaskRunning = !!activeTask && (activeTaskStatus === 'running' || activeTaskStatus === 'cancelling');
  const isTaskActive = !!activeTask && (activeTaskStatus === 'running' || activeTaskStatus === 'cancelling' || activeTaskStatus === 'paused');
  const [input, setInput] = useState('');
  const [selectedPromptOptionId, setSelectedPromptOptionId] = useState<string>('');
  const [promptOtherText, setPromptOtherText] = useState('');
  const [contextPanelExpanded, setContextPanelExpanded] = useState(true);
  const [taskBoardExpanded, setTaskBoardExpanded] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'checking' | 'connected' | 'reconnecting'>('checking');
  const [syncing, setSyncing] = useState(false);
  const [syncingFileId, setSyncingFileId] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [fileIndexStatus, setFileIndexStatus] = useState<Record<string, FileIndexStatusSnapshot>>({});
  const [indexingFileIds, setIndexingFileIds] = useState<Record<string, boolean>>({});
  const [streamingAssistant, setStreamingAssistant] = useState<StreamingAssistantState | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const indexWarmupAttemptedRef = useRef<Set<string>>(new Set());

  const totalTasks = registryTasks.length;
  const completedTasks = registryTasks.filter((item) => item.status === 'completed').length;
  const runningTasks = registryTasks.filter((item) => item.status === 'running').length;
  const activeRegistryTask = registryTasks.find((task) => task.task_id === taskRegistry?.active_task_id)
    || registryTasks.find((task) => task.status === 'running' || task.status === 'blocked')
    || null;
  const activeRegistryStep = activeRegistryTask?.steps.find((step) => step.status === 'running' || step.status === 'blocked')
    || (typeof activeRegistryTask?.current_step_index === 'number'
      ? activeRegistryTask.steps[activeRegistryTask.current_step_index]
      : undefined);

  useWebSocket(sessionId, setConnectionStatus);

  useEffect(() => {
    if (!activeTask?.startedAt || !['running', 'cancelling', 'paused'].includes(activeTask.status)) {
      setElapsedSeconds(0);
      return;
    }

    const startedAtMs = new Date(activeTask.startedAt).getTime();
    if (!Number.isFinite(startedAtMs)) {
      setElapsedSeconds(0);
      return;
    }

    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    };

    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(intervalId);
  }, [activeTask?.startedAt, activeTask?.status, activeTask?.taskId]);

  useEffect(() => {
    if (!pendingPrompt) {
      setSelectedPromptOptionId('');
      setPromptOtherText('');
      return;
    }
    const recommended = pendingPrompt.prompt.recommended_option_id
      || pendingPrompt.prompt.options.find((option) => option.recommended)?.id
      || pendingPrompt.prompt.options[0]?.id
      || '';
    setSelectedPromptOptionId(recommended);
    setPromptOtherText('');
  // Keep the draft answer stable while the same prompt remains active.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrompt?.prompt.prompt_id]);

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

  // Auto-scroll the message container only; avoid page-level jump.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const rafId = window.requestAnimationFrame(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: messages.length > 1 ? 'smooth' : 'auto',
      });
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [messages.length, loading, isTaskRunning]);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent;
      const detail = custom.detail;
      if (!detail || typeof detail !== 'object') return;
      if (detail.session_id && detail.session_id !== sessionId) return;
      if (shouldClearAssistantPreview(String((detail as any).event_type || ''))) {
        setStreamingAssistant(null);
      }
      ingestTaskEvent(sessionId, detail);
    };

    window.addEventListener('agent-task-event', handler);
    return () => window.removeEventListener('agent-task-event', handler);
  }, [ingestTaskEvent, sessionId]);

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent;
      const detail = custom.detail;
      if (!detail || typeof detail !== 'object') return;
      if (detail.session_id && detail.session_id !== sessionId) return;
      setStreamingAssistant((current) => applyAssistantStreamEvent(current, detail as any));
    };

    window.addEventListener('assistant-stream-event', handler);
    return () => window.removeEventListener('assistant-stream-event', handler);
  }, [sessionId]);

  useEffect(() => {
    if (!activeTaskId || (activeTaskStatus && ['completed', 'failed', 'cancelled'].includes(activeTaskStatus))) {
      setStreamingAssistant(null);
    }
  }, [activeTaskId, activeTaskStatus]);

  useEffect(() => {
    let cancelled = false;
    const warmupDelayMs = import.meta.env.MODE === 'test' ? 0 : 1500;
    const openDocs = allFiles.filter(
      (file) =>
        file.type !== 'session'
        && supportsIndexWarmup(file.type)
        && getEffectivePermission(file, permissions) === 'read'
    );

    if (openDocs.length === 0) {
      setFileIndexStatus({});
      return;
    }

    const refreshStatuses = async () => {
      const entries = await Promise.all(
        openDocs.map(async (file) => {
          try {
            const response = await api.getFileIndexStatus(file.id);
            return [file.id, response.success ? (response.data as FileIndexStatusSnapshot) : undefined] as const;
          } catch {
            return [file.id, undefined] as const;
          }
        })
      );

      if (cancelled) return;

      const nextStatus = Object.fromEntries(
        entries.filter((entry): entry is readonly [string, FileIndexStatusSnapshot] => Boolean(entry[1]))
      );
      setFileIndexStatus(nextStatus);

      for (const file of openDocs) {
        if (cancelled) return;
        const status = nextStatus[file.id];
        const summary = summarizeIndexStatus(status);
        if (!summary.needsWarmup || indexWarmupAttemptedRef.current.has(file.id)) continue;
        indexWarmupAttemptedRef.current.add(file.id);
        setIndexingFileIds((current) => ({ ...current, [file.id]: true }));

        try {
          await api.reindexFile(file.id, status?.parse_status === 'ready' ? 'embed_only' : 'all');
          const refreshed = await api.getFileIndexStatus(file.id);
          if (!cancelled && refreshed.success && refreshed.data) {
            setFileIndexStatus((current) => ({
              ...current,
              [file.id]: refreshed.data as FileIndexStatusSnapshot,
            }));
          }
        } catch {
          // Keep stale status visible; user still sees that warmup is pending/failed.
        } finally {
          if (!cancelled) {
            setIndexingFileIds((current) => ({ ...current, [file.id]: false }));
          }
        }
      }
    };

    const timeoutId = window.setTimeout(() => {
      void refreshStatuses();
    }, warmupDelayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [allFiles, permissions]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || loading || isTaskActive) return;

    const message = input;
    setInput('');

    const contextFiles = allFiles
      .filter((file) => file.type !== 'session')
      .filter((file) => (permissions[file.id] || 'read') !== 'none')
      .map((file) => file.id);

    await sendMessageForSession(sessionId, message, contextFiles);
    window.dispatchEvent(new CustomEvent('assistant-message-finished', { detail: { sessionId } }));
  }, [allFiles, input, isTaskActive, loading, permissions, sessionId, sendMessageForSession]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const longRunningTask = !!activeTask && activeTask.status === 'running' && elapsedSeconds >= 20;
  const activeTaskStatusClass = activeTask
    ? TASK_STATUS_STYLES[activeTask.status] || 'border-theme-border/25 bg-theme-bg/80 text-theme-text/80'
    : '';
  const contextFiles = allFiles.filter((file) => file.type !== 'session');
  const readableContextCount = contextFiles.filter((file) => getEffectivePermission(file, permissions) === 'read').length;
  const writableContextCount = contextFiles.filter((file) => getEffectivePermission(file, permissions) === 'write').length;
  const warmupFileCount = Object.entries(fileIndexStatus)
    .filter(([fileId, status]) => {
      const file = allFiles.find((item) => item.id === fileId);
      if (!file || getEffectivePermission(file, permissions) !== 'read') return false;
      return summarizeIndexStatus(status).needsWarmup || indexingFileIds[fileId];
    })
    .length;
  const failedWarmupFiles = Object.entries(fileIndexStatus)
    .filter(([fileId, status]) => {
      const file = allFiles.find((item) => item.id === fileId);
      return file && getEffectivePermission(file, permissions) === 'read' && summarizeIndexStatus(status).label === 'Index failed';
    })
    .map(([fileId]) => allFiles.find((file) => file.id === fileId)?.name || fileId);
  const activeTaskMessage = activeRegistryTask
    ? `${activeRegistryTask.goal}${activeRegistryStep ? ` · ${activeRegistryStep.type}` : ''}`
    : activeTask?.lastMessage || 'Working through the current request.';

  return (
    <div
      className="flex flex-col h-full min-h-0 subtle-grid"
      style={{ backgroundColor: 'var(--theme-surface-muted)' }}
    >
      {/* Header */}
      <div className="border-b border-theme-border/30 paper-divider-dashed px-4 py-1.5 surface-panel shadow-[0_1px_0_rgba(16,16,16,0.05)] z-10 flex-shrink-0">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] font-semibold tracking-[0.08em] text-theme-text/60 uppercase flex items-center gap-1.5">
            <Bot size={11} /> <span>AI Assistant</span>
          </div>
          <div className="flex items-center gap-2">
            {connectionStatus === 'connected' ? (
              <span className="text-[10px] text-green-600 flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                Connected
              </span>
            ) : connectionStatus === 'reconnecting' ? (
              <span className="text-[10px] text-amber-600 flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" />
                Reconnecting
              </span>
            ) : (
              <span className="text-[10px] text-theme-text/40 flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" />
                Connecting...
              </span>
            )}
            {/* Permission sync status indicator */}
            {isSynced(sessionId) && !syncing && connectionStatus === 'connected' && (
              <span className="text-[10px] text-blue-500 flex items-center gap-1" title="Permissions synced with backend">
                <Check size={10} />
              </span>
            )}
          </div>
        </div>

        <div className="mt-1.5">
          <button
            type="button"
            onClick={() => setContextPanelExpanded((prev) => !prev)}
            className="w-full rounded-lg border border-theme-border/18 bg-theme-bg/76 px-2.5 py-1.5 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] transition-colors hover:bg-theme-bg/92"
            aria-expanded={contextPanelExpanded}
            aria-label={contextPanelExpanded ? 'Hide context files' : 'Show context files'}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-semibold tracking-[0.08em] text-theme-text/58 uppercase">
                  <span>Context Files</span>
                  <span className="text-theme-text/38">{contextFiles.length} available</span>
                  {warmupFileCount > 0 && (
                    <span className="text-blue-800/85">{warmupFileCount} indexing</span>
                  )}
                  {syncing && (
                    <span className="text-blue-500 flex items-center gap-1 normal-case tracking-normal">
                      <Loader2 size={10} className="animate-spin" />
                      Syncing
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[10px] text-theme-text/46">
                  {contextFiles.length === 0
                    ? 'No files open.'
                    : `${readableContextCount} readable${writableContextCount ? ` · ${writableContextCount} writable` : ''}`}
                </div>
              </div>
              <span className="flex items-center gap-1 text-theme-text/42">
                {contextPanelExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              </span>
            </div>
          </button>

          {contextPanelExpanded && (
            <div className="mt-2 space-y-2">
              {warmupFileCount > 0 && (
                <section className="rounded-lg border border-blue-500/18 bg-blue-50/48 px-3 py-2 text-[11px] text-blue-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
                  <div className="flex items-center gap-2">
                    <Loader2 size={11} className="animate-spin" />
                    <span className="font-medium">
                      Preparing index for {warmupFileCount} context file{warmupFileCount > 1 ? 's' : ''}.
                    </span>
                  </div>
                  <div className="mt-1 text-blue-900/80">
                    You can ask now, but retrieval may be slower until indexing finishes.
                  </div>
                  {failedWarmupFiles.length > 0 && (
                    <div className="mt-1 text-red-800/90">
                      Retry still pending for: {failedWarmupFiles.join(', ')}.
                    </div>
                  )}
                </section>
              )}

              {contextFiles.length === 0 ? (
                <div className="rounded-lg border border-dashed border-theme-border/20 bg-theme-bg/60 px-3 py-2 text-[11px] text-theme-text/40 italic">
                  No files open.
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {contextFiles.map((file) => {
                    const status = getEffectivePermission(file, permissions);
                    const isFileSyncing = syncingFileId === file.id;
                    const indexStatus = fileIndexStatus[file.id];
                    const indexSummary = summarizeIndexStatus(indexStatus);
                    const isIndexing = Boolean(indexingFileIds[file.id]);
                    return (
                      <div
                        key={file.id}
                        data-context-file-id={file.id}
                        data-context-file-name={file.name}
                        className={`flex items-center gap-2 rounded-lg border border-theme-border/14 bg-theme-surface px-2 py-1.5 text-[11px] shadow-[0_3px_10px_rgba(16,16,16,0.04)] transition-all ${
                          status === 'none' ? 'opacity-50' : 'opacity-100'
                        }`}
                      >
                        <FileIcon type={file.type} size={14} className="text-theme-text/72" />
                        <div className="min-w-0 flex-1">
                          <div className="max-w-[132px] truncate font-medium text-theme-text/82">
                            {file.name}
                          </div>
                          {supportsIndexWarmup(file.type) && status === 'read' && (
                            <div className="mt-1 flex items-center gap-1.5">
                              <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] ${indexSummary.tone}`}>
                                {isIndexing && <Loader2 size={9} className="animate-spin" />}
                                {indexSummary.label}
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="h-4 w-px bg-theme-border/14" />
                        <PermissionToggle
                          status={status}
                          syncing={isFileSyncing}
                          data-context-permission-file-id={file.id}
                          onClick={() => {
                            setSyncingFileId(file.id);
                            onTogglePermission(file.id, file.type);
                            setTimeout(() => setSyncingFileId(null), 500);
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Task Board */}
      <div className="px-4 py-1.5 border-b border-theme-border/20 paper-divider-dashed bg-theme-bg/55 flex-shrink-0">
        <button
          onClick={() => setTaskBoardExpanded((prev) => !prev)}
          className="w-full text-left border border-theme-border/20 rounded-[16px] px-2.5 py-1.5 bg-theme-bg/88 hover:bg-theme-bg transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Layers3 size={12} className="text-theme-text/70 flex-shrink-0" />
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-theme-text/56">Task</span>
              <span className="text-[11px] text-theme-text/80 truncate">
                {completedTasks}/{totalTasks || 0} completed{runningTasks ? ` · ${runningTasks} running` : ''}
              </span>
              {registryTasks.length === 0 && (
                <span className="text-[10px] uppercase tracking-[0.08em] text-theme-text/38">no tasks</span>
              )}
            </div>
            <span className="text-[10px] uppercase tracking-[0.08em] text-theme-text/48">
              {taskBoardExpanded ? 'hide' : 'show'}
            </span>
          </div>
        </button>

        {taskBoardExpanded && (
          <div className="mt-2 grid grid-cols-1 gap-2">
            {registryTasks.length === 0 ? (
              <div className="text-xs text-theme-text/45 px-2 py-2 rounded-[16px] border border-dashed border-theme-border/25">
                No task registry yet. The orchestrator will register tasks when the request starts.
              </div>
            ) : (
              registryTasks
                .slice()
                .sort((a, b) => a.task_order - b.task_order)
                .map((item) => (
                <div
                  key={item.task_id}
                  className={`rounded-[18px] px-3 py-2 transition-all ${REGISTRY_ITEM_STYLES[item.status] || REGISTRY_ITEM_STYLES.pending}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-theme-text/85 truncate">{item.goal}</div>
                      <div className="text-[11px] text-theme-text/55 mt-1 capitalize">
                        {item.status} · step {Math.min(item.current_step_index + 1, Math.max(item.total_steps, 1))}/{Math.max(item.total_steps, 1)}
                      </div>
                    </div>
                    <div className="text-[10px] uppercase tracking-[0.08em] text-theme-text/42">
                      {item.task_id.split(':').slice(-1)[0] || item.task_id}
                    </div>
                  </div>
                  {item.blocked_reason && (
                    <div className="mt-2 rounded-[14px] border border-amber-500/25 bg-amber-50/60 px-2 py-1.5 text-[11px] text-amber-900">
                      Blocked: {item.blocked_reason}
                    </div>
                  )}
                  {Array.isArray(item.missing_inputs) && item.missing_inputs.length > 0 && (
                    <div className="mt-2 space-y-1 text-[11px] text-theme-text/70">
                      {item.missing_inputs.map((missing, index) => (
                        <div key={`${item.task_id}-missing-${index}`} className="rounded-[12px] border border-theme-border/16 bg-theme-bg/72 px-2 py-1.5">
                          <div className="font-medium">{String(missing.input || missing.description || 'missing input')}</div>
                          {missing.minimum_substitute && (
                            <div className="text-theme-text/55 mt-0.5">
                              Minimum substitute: {String(missing.minimum_substitute)}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 space-y-1.5">
                    {item.steps.map((step) => (
                      <div
                        key={`${item.task_id}-step-${step.index}`}
                        className={`rounded-[14px] border px-2.5 py-2 ${
                          step.status === 'completed'
                            ? 'border-green-600/18 bg-green-50/55'
                            : step.status === 'running'
                              ? 'border-black/20 bg-theme-bg'
                              : step.status === 'blocked'
                                ? 'border-amber-500/28 bg-amber-50/60'
                                : 'border-theme-border/15 bg-theme-bg/70'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="font-medium text-theme-text/82">{step.type}</span>
                          <span className="uppercase tracking-[0.08em] text-theme-text/48">{step.status}</span>
                        </div>
                        {step.output_preview && (
                          <div className="mt-1 text-[11px] text-theme-text/62 whitespace-pre-wrap line-clamp-4">
                            {step.output_preview}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} className="flex-1 min-h-0 p-4 overflow-y-auto space-y-3">
        {activeTask && (
          <div className="rounded-xl border border-theme-border/18 bg-theme-bg/92 px-3 py-2.5 text-xs text-theme-text/80 shadow-[0_8px_18px_rgba(16,16,16,0.05)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.08em] text-theme-text/55">
                  <span className={`inline-flex items-center rounded-full border px-2 py-0.5 ${activeTaskStatusClass}`}>
                    {activeTask.status}
                  </span>
                  {elapsedSeconds > 0 && (
                    <span className="normal-case text-theme-text/45">
                      Elapsed {formatElapsedLabel(elapsedSeconds)}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-theme-text/82">
                  <span className="inline-flex items-center gap-1 font-medium">
                    <Activity size={12} className="text-theme-text/62" />
                    Task `{activeTask.taskId}`
                  </span>
                  {activeTask.progress != null && <span className="text-theme-text/52">{activeTask.progress}%</span>}
                  {totalTasks > 0 && (
                    <span className="text-theme-text/52">
                      {completedTasks}/{totalTasks} completed
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-theme-text/58 leading-5">
                  {activeTaskMessage}
                </div>
                {longRunningTask && (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-50/75 px-2.5 py-2 text-[11px] text-amber-900">
                    Still waiting on retrieval or model output. Cancel and retry only if this stops changing.
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {(activeTask.status === 'running' || activeTask.status === 'cancelling' || activeTask.status === 'paused') && (
                  <button
                    onClick={() => cancelActiveTask(sessionId)}
                    disabled={activeTask.status === 'cancelling'}
                    className="inline-flex items-center gap-1 px-2 py-1 border border-theme-border/25 rounded hover:bg-theme-text/10 disabled:opacity-50"
                  >
                    <Square size={12} />
                    {activeTask.status === 'cancelling' ? 'Cancelling' : 'Cancel'}
                  </button>
                )}
                {(activeTask.status === 'failed' || activeTask.status === 'cancelled') && (
                  <button
                    onClick={() => retryLastTask(sessionId)}
                    className="inline-flex items-center gap-1 px-2 py-1 border border-theme-border/25 rounded hover:bg-theme-text/10"
                  >
                    <RotateCcw size={12} />
                    Retry
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {pendingPrompt && (
          <div className="border border-amber-300/60 rounded-xl bg-amber-50/70 px-3 py-3 text-xs text-theme-text/90 shadow-[0_8px_18px_rgba(193,115,54,0.08)]">
            <div className="font-semibold text-[12px] mb-2">Task paused · choose to continue</div>
            <div className="text-sm mb-2">{pendingPrompt.prompt.question}</div>
            <div className="space-y-1 mb-2">
              {pendingPrompt.prompt.options.map((option) => {
                const selected = selectedPromptOptionId === option.id;
                const recommended = option.id === pendingPrompt.prompt.recommended_option_id || option.recommended;
                return (
                  <button
                    key={option.id}
                    onClick={() => setSelectedPromptOptionId(option.id)}
                    className={`w-full text-left px-2 py-1.5 rounded border ${
                      selected ? 'border-black bg-theme-bg' : 'border-theme-border/25 bg-theme-bg/70'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span>{option.label}</span>
                      {recommended && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded border border-green-500/40 text-green-700">
                          Recommended
                        </span>
                      )}
                    </div>
                    {option.description && (
                      <div className="text-[11px] text-theme-text/60 mt-1">{option.description}</div>
                    )}
                  </button>
                );
              })}
            </div>

            {pendingPrompt.prompt.allow_other !== false && (
              <textarea
                value={promptOtherText}
                onChange={(event) => setPromptOtherText(event.target.value)}
                placeholder={pendingPrompt.prompt.other_placeholder || 'Input another option'}
                className="w-full px-2 py-1.5 border border-theme-border/30 bg-theme-bg text-theme-text rounded mb-2 text-xs resize-y"
                rows={2}
              />
            )}

            <button
              onClick={() => {
                const hasOther = promptOtherText.trim().length > 0;
                void answerTaskPrompt(sessionId, pendingPrompt.taskId, {
                  promptId: pendingPrompt.prompt.prompt_id,
                  selectedOptionId: hasOther ? undefined : selectedPromptOptionId,
                  otherText: hasOther ? promptOtherText.trim() : undefined,
                });
              }}
              disabled={!selectedPromptOptionId && !promptOtherText.trim()}
              className="inline-flex items-center gap-1 px-3 py-1.5 border border-theme-border/30 rounded bg-theme-bg hover:bg-theme-text/10 disabled:opacity-50"
            >
              Continue Task
            </button>
          </div>
        )}

        {messages.length === 0 && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-theme-text/10 flex items-center justify-center text-theme-text flex-shrink-0">
              <Bot size={18} />
            </div>
            <div className="surface-panel bg-theme-bg p-3 rounded-lg rounded-tl-none border border-theme-border/20 shadow-sm text-sm text-theme-text/80 max-w-[85%]">
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

        {messages.map((msg) => {
          if (msg.role === 'task_event') {
            const taskMeta = (msg.tool_results && (msg.tool_results as any).task_event) || null;
            const isToolEvent =
              taskMeta &&
              typeof taskMeta.event_type === 'string' &&
              (taskMeta.event_type === 'tool_started' || taskMeta.event_type === 'tool_completed');
            const toolName = isToolEvent ? String(taskMeta?.payload?.tool || 'unknown_tool') : '';
            const targetFileName = String(taskMeta?.payload?.target_file_name || taskMeta?.payload?.target_file_id || '').trim();
            const toolSuccess =
              isToolEvent && taskMeta.event_type === 'tool_completed'
                ? Boolean(taskMeta?.payload?.success)
                : null;
            const toolError = isToolEvent ? taskMeta?.payload?.error : null;
            const toolTone = toolSuccess === false ? 'text-red-700' : toolSuccess === true ? 'text-green-700' : 'text-theme-text/55';
            const compactMeta = [
              toolName || null,
              targetFileName || null,
              toolSuccess === null ? null : toolSuccess ? 'success' : 'failed',
            ].filter(Boolean);
            const actionKind = String(taskMeta?.payload?.action_kind || (isToolEvent ? inferActionKind(toolName) : 'other'));
            return (
              <div
                key={msg.id}
                className="relative pl-4 py-1 text-sm text-theme-text/74"
              >
                <span className="absolute left-0 top-[10px] h-1.5 w-1.5 rounded-full bg-theme-text/28" />
                {isToolEvent && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] uppercase tracking-[0.08em] text-theme-text/38">
                    <span>{actionKind}</span>
                    {compactMeta.length > 0 && (
                      <span className={`normal-case tracking-normal ${toolTone}`}>
                        {compactMeta.join(' · ')}
                      </span>
                    )}
                    {totalTasks > 0 && (
                      <span className="normal-case tracking-normal text-theme-text/34">
                        {completedTasks}/{totalTasks} complete
                      </span>
                    )}
                  </div>
                )}
                <div className="mt-0.5 whitespace-pre-wrap leading-5">{msg.content}</div>
                {toolError && (
                  <div className="mt-0.5 text-[11px] text-red-700">
                    {String(toolError)}
                  </div>
                )}
              </div>
            );
          }

          const toolCalls = msg.role === 'assistant' ? extractToolCalls(msg.tool_calls) : [];
          const toolResults = msg.role === 'assistant' ? extractToolResults(msg.tool_results) : [];
          const hasToolRecords = toolCalls.length > 0 || toolResults.length > 0;

          return (
            <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
              {msg.role === 'assistant' && (
                <div className="w-8 h-8 rounded-full bg-theme-text/10 flex items-center justify-center text-theme-text flex-shrink-0">
                  <Bot size={18} />
                </div>
              )}
              <div className={`max-w-[85%] ${
                msg.role === 'user'
                  ? 'bg-theme-text text-theme-bg rounded-[18px] rounded-tr-none px-4 py-3 shadow-[0_10px_22px_rgba(16,16,16,0.2)]'
                  : 'surface-panel bg-theme-bg p-3 rounded-[20px] rounded-tl-none border border-theme-border/18 shadow-[0_8px_18px_rgba(16,16,16,0.05)] text-sm text-theme-text/80'
              }`}>
                {msg.role === 'assistant' && (
                  <div className="mb-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-[0.08em] text-theme-text/45">
                    <span>Assistant</span>
                    {hasToolRecords && (
                      <span className="text-theme-text/40">
                        {toolCalls.length} calls · {toolResults.length} results
                      </span>
                    )}
                  </div>
                )}
                {msg.role === 'assistant' ? (
                  <MarkdownContent content={msg.content} className="text-theme-text/85" />
                ) : (
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                )}
                {msg.role === 'assistant' && hasToolRecords && (
                  <details className="mt-3 rounded-xl border border-theme-border/15 bg-theme-surface/55 px-3 py-2">
                    <summary className="cursor-pointer list-none text-xs text-theme-text/70 flex items-center justify-between gap-2">
                      <span className="font-medium">Agent Tool Records</span>
                      <span className="text-[11px] text-theme-text/45">
                        {toolCalls.length} calls · {toolResults.length} results
                      </span>
                    </summary>
                    <div className="mt-2 space-y-2">
                      {toolCalls.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-[11px] uppercase tracking-[0.06em] text-theme-text/45">Calls</div>
                          {toolCalls.map((call, index) => (
                            <details key={`${msg.id}-call-${call.id}-${index}`} className="rounded border border-theme-border/15 bg-theme-bg/85 px-2 py-1">
                              <summary className="cursor-pointer text-[11px] text-theme-text/75">
                                {index + 1}. {call.name}
                              </summary>
                              <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-theme-text/65">
                                {formatJsonPreview(call.arguments)}
                              </pre>
                            </details>
                          ))}
                        </div>
                      )}
                      {toolResults.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-[11px] uppercase tracking-[0.06em] text-theme-text/45">Results</div>
                          {toolResults.map((result, index) => (
                            <details key={`${msg.id}-result-${result.id}-${index}`} className="rounded border border-theme-border/15 bg-theme-bg/85 px-2 py-1">
                              <summary className="cursor-pointer text-[11px] text-theme-text/75">
                                {index + 1}. {result.tool} · {result.success ? 'success' : 'failed'}
                              </summary>
                              {result.error && (
                                <div className="mt-1 text-[11px] text-red-600">{result.error}</div>
                              )}
                              <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] text-theme-text/65">
                                {formatJsonPreview(result.data ?? result.raw)}
                              </pre>
                            </details>
                          ))}
                        </div>
                      )}
                    </div>
                  </details>
                )}
              </div>
            </div>
          );
        })}

        {isTaskRunning && (
          <div className="pl-3 border-l-2 border-theme-border/35 text-sm text-theme-text/70 flex items-center gap-2">
            <Loader2 size={14} className="animate-spin text-theme-text/70" />
            <span>{activeTaskMessage || 'Task running...'}</span>
          </div>
        )}

        {streamingAssistant && streamingAssistant.content && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-theme-text/10 flex items-center justify-center text-theme-text flex-shrink-0">
              <Bot size={18} />
            </div>
            <div className="surface-panel bg-theme-bg p-3 rounded-[20px] rounded-tl-none border border-theme-border/18 shadow-[0_8px_18px_rgba(16,16,16,0.05)] text-sm text-theme-text/80 max-w-[85%]">
              <div className="mb-2 flex items-center justify-between gap-2 text-[11px] uppercase tracking-[0.08em] text-theme-text/45">
                <span>Assistant Draft</span>
                <span className="inline-flex items-center gap-1 text-theme-text/40">
                  <Loader2 size={11} className="animate-spin" />
                  Streaming
                </span>
              </div>
              <MarkdownContent content={streamingAssistant.content} className="text-theme-text/85" />
            </div>
          </div>
        )}

        {loading && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-full bg-theme-text/10 flex items-center justify-center text-theme-text flex-shrink-0">
              <Bot size={18} />
            </div>
            <div className="surface-panel bg-theme-bg px-4 py-3 rounded-lg rounded-tl-none border border-theme-border/20 shadow-sm text-sm">
              <div className="flex items-center gap-2 text-theme-text/80">
                <Loader2 size={14} className="animate-spin text-theme-text" />
                <span className="text-[13px]">{activeTaskMessage || 'Waiting for assistant response...'}</span>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-500/25 bg-red-50 text-red-700 px-4 py-3 text-sm shadow-[0_8px_18px_rgba(127,29,29,0.08)]">
            {error}
          </div>
        )}

      </div>

      {/* Input */}
      <div
        className="p-4 border-t border-theme-border/30 paper-divider-dashed surface-panel flex-shrink-0"
      >
        <div className="relative">
          {warmupFileCount > 0 && (
            <div className="mb-2 rounded-lg border border-theme-border/18 bg-theme-bg/85 px-3 py-2 text-[11px] text-theme-text/60">
              Context indexing is running in background. First answer may take longer.
            </div>
          )}
          {sessionReferences.length > 0 && (
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              <div className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-theme-text/45">
                <Link2 size={10} />
                <span>References</span>
                <span className="text-theme-text/32">{sessionReferences.length}</span>
              </div>
              {sessionReferences.map((ref) => (
                <div
                  key={ref.id}
                  className="inline-flex max-w-[210px] items-center gap-1.5 rounded-md border border-theme-border/12 bg-theme-surface/88 px-2 py-1 text-[10px] text-theme-text/72 shadow-[0_1px_6px_rgba(16,16,16,0.03)]"
                  title={ref.markdown}
                >
                  <span className="truncate text-theme-text/58">{ref.sourceFileName}</span>
                  <span className="truncate text-theme-text/42">{ref.markdown.replace(/\s+/g, ' ')}</span>
                  <button
                    onClick={() => removeSessionReference(sessionId, ref.id)}
                    className="ml-auto rounded p-0.5 hover:bg-theme-text/10"
                    aria-label="Remove reference"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
              <button
                onClick={() => clearSessionReferences(sessionId)}
                className="text-[10px] uppercase tracking-[0.08em] text-theme-text/42 hover:text-theme-text"
              >
                Clear
              </button>
            </div>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
            className="w-full pl-4 pr-10 py-2.5 border border-theme-border/30 bg-theme-bg text-theme-text rounded-lg focus:outline-none focus:ring-2 focus:ring-theme-text/20 text-sm resize-none placeholder:text-theme-text/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]"
            rows={2}
            disabled={loading || isTaskActive}
          />
          <button
            onClick={handleSend}
            disabled={loading || isTaskActive || !input.trim()}
            className="absolute right-2 bottom-2 p-1.5 text-theme-text hover:bg-theme-text/10 rounded pill-button disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading || isTaskRunning ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
