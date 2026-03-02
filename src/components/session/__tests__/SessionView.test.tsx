import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionView } from '../SessionView';

const mocks = vi.hoisted(() => ({
  sendMessageForSession: vi.fn(async () => {}),
  loadSessionMessages: vi.fn(async () => {}),
  ingestTaskEvent: vi.fn(),
  cancelActiveTask: vi.fn(async () => {}),
  retryLastTask: vi.fn(async () => {}),
  answerTaskPrompt: vi.fn(async () => {}),
  loadPermissionsFromBackend: vi.fn(async () => {}),
  getFileIndexStatus: vi.fn(async () => ({ success: true, data: { parse_status: 'ready', embedding_status: 'ready' } })),
  reindexFile: vi.fn(async () => ({ success: true, data: {} })),
  onTogglePermission: vi.fn(),
  removeSessionReference: vi.fn(),
  clearSessionReferences: vi.fn(),
  chatState: {} as any,
  synced: true,
  wsStatus: 'checking' as 'checking' | 'connected' | 'reconnecting',
}));

vi.mock('../../../hooks/useWebSocket', () => ({
  useWebSocket: (_sessionId: string, onStatusChange?: (status: 'checking' | 'connected' | 'reconnecting') => void) => {
    useEffect(() => {
      onStatusChange?.(mocks.wsStatus);
    });
  },
}));

vi.mock('../../../stores/chatStore', () => ({
  useChatStore: () => mocks.chatState,
}));

vi.mock('../../../stores/sessionStore', () => ({
  useSessionStore: () => ({
    loadPermissionsFromBackend: mocks.loadPermissionsFromBackend,
    isSynced: () => mocks.synced,
  }),
}));

vi.mock('../../../api/client', () => ({
  api: {
    getFileIndexStatus: (fileId: string) => (mocks.getFileIndexStatus as any)(fileId),
    reindexFile: (fileId: string, mode: 'parse_only' | 'embed_only' | 'all') => (mocks.reindexFile as any)(fileId, mode),
  },
}));

vi.mock('../../ui/PermissionToggle', () => ({
  PermissionToggle: ({ onClick, status }: { onClick: () => void; status: string }) => (
    <button onClick={onClick}>perm-{status}</button>
  ),
}));

vi.mock('../../ui/FileIcon', () => ({
  FileIcon: ({ type }: { type: string }) => <span>icon-{type}</span>,
}));

describe('SessionView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (Element.prototype as any).scrollTo = vi.fn();
    mocks.synced = true;
    mocks.wsStatus = 'checking';
    mocks.getFileIndexStatus.mockResolvedValue({
      success: true,
      data: { parse_status: 'ready', embedding_status: 'ready' },
    });
    mocks.reindexFile.mockResolvedValue({ success: true, data: {} });

    mocks.chatState = {
      getMessagesForSession: () => [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: '## assistant heading\n\nInline math $a+b$',
          timestamp: new Date().toISOString(),
          tool_calls: [{ id: 'c1', function: { name: 'locate_relevant_segments', arguments: '{"q":"x"}' } }],
          tool_results: [{ id: 'r1', tool: 'locate_relevant_segments', result: { success: true, data: { score: 1 } } }],
        },
        {
          id: 'task-1',
          role: 'task_event',
          content: 'tool started',
          timestamp: new Date().toISOString(),
          tool_results: {
            task_event: {
              event_type: 'tool_started',
              stage: 'executing',
              payload: {
                tool: 'update_file',
                target_file_name: 'doc.md',
              },
            },
          },
        },
        {
          id: 'user-1',
          role: 'user',
          content: 'hello',
          timestamp: new Date().toISOString(),
        },
      ],
      isSessionLoading: () => false,
      getActiveTask: () => ({
        taskId: 't1',
        status: 'running',
        stage: 'exec',
        progress: 30,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMessage: 'x',
        contextFiles: [],
      }),
      getTaskBoard: () => [
        {
          id: 'item-1',
          name: 'Task one',
          status: 'running',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      getPendingPrompt: () => ({
        taskId: 't1',
        requestedAt: new Date().toISOString(),
        prompt: {
          prompt_id: 'p1',
          question: 'Choose option',
          options: [
            { id: 'o1', label: 'A', recommended: true, description: 'first' },
            { id: 'o2', label: 'B', description: 'second' },
          ],
          recommended_option_id: 'o1',
          allow_other: true,
        },
      }),
      getSessionReferences: () => [
        {
          id: 'ref-1',
          sourceFileId: 'f1',
          sourceFileName: 'doc.md',
          markdown: '## ref',
          plainText: 'ref',
          createdAt: new Date().toISOString(),
        },
      ],
      removeSessionReference: mocks.removeSessionReference,
      clearSessionReferences: mocks.clearSessionReferences,
      error: null,
      sendMessageForSession: mocks.sendMessageForSession,
      loadSessionMessages: mocks.loadSessionMessages,
      ingestTaskEvent: mocks.ingestTaskEvent,
      cancelActiveTask: mocks.cancelActiveTask,
      retryLastTask: mocks.retryLastTask,
      answerTaskPrompt: mocks.answerTaskPrompt,
    };
  });

  it('renders major sections and supports actions', async () => {
    const { container } = render(
      <SessionView
        sessionId="s1"
        allFiles={[
          { id: 'f1', name: 'doc.md', type: 'md', mode: 'editor' },
          { id: 'f2', name: 'paper.pdf', type: 'pdf', mode: 'editor' },
          { id: 's1', name: 'chat', type: 'session', mode: 'editor' },
        ]}
        permissions={{ f1: 'read', f2: 'none' }}
        onTogglePermission={mocks.onTogglePermission}
      />
    );

    await waitFor(() => {
      expect(mocks.loadSessionMessages).toHaveBeenCalledWith('s1');
      expect(mocks.loadPermissionsFromBackend).toHaveBeenCalledWith('s1');
    });

    expect(screen.getByText('Agent Tool Records')).toBeInTheDocument();
    expect(screen.getAllByText('x').length).toBeGreaterThan(0);
    expect(screen.getByText('assistant heading')).toBeInTheDocument();
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(screen.getByText('Task paused · choose to continue')).toBeInTheDocument();
    expect(screen.queryByText('Agent Action')).not.toBeInTheDocument();
    expect(screen.queryByText('executing')).not.toBeInTheDocument();
    expect(await screen.findAllByText('Index ready')).toHaveLength(1);
    expect(screen.getByText('References')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Hide context files'));
    expect(screen.queryByText('paper.pdf')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show context files'));
    expect(screen.getByText('paper.pdf')).toBeInTheDocument();

    fireEvent.click(screen.getByText('perm-read'));
    expect(mocks.onTogglePermission).toHaveBeenCalledWith('f1', 'md');

    fireEvent.click(screen.getByText('Cancel'));
    expect(mocks.cancelActiveTask).toHaveBeenCalledWith('s1');

    fireEvent.click(screen.getByLabelText('Remove reference'));
    expect(mocks.removeSessionReference).toHaveBeenCalledWith('s1', 'ref-1');

    fireEvent.click(screen.getByText('Clear'));
    expect(mocks.clearSessionReferences).toHaveBeenCalledWith('s1');

    fireEvent.click(screen.getByText('Continue Task'));
    await waitFor(() => {
      expect(mocks.answerTaskPrompt).toHaveBeenCalled();
    });

    window.dispatchEvent(new CustomEvent('agent-task-event', { detail: { session_id: 's1', event_type: 'task_item_started' } }));
    expect(mocks.ingestTaskEvent).toHaveBeenCalled();
  });

  it('shows warmup and assistant draft feedback for pending context files', async () => {
    mocks.chatState = {
      ...mocks.chatState,
      getMessagesForSession: () => [],
      getActiveTask: () => ({
        taskId: 't-stream',
        status: 'running',
        stage: 'planning',
        progress: 10,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMessage: 'Retrieving context from 1 file(s)',
        contextFiles: ['f1'],
      }),
      getTaskBoard: () => [],
      getPendingPrompt: () => null,
      getSessionReferences: () => [],
    };
    mocks.getFileIndexStatus.mockResolvedValue({
      success: true,
      data: { parse_status: 'pending', embedding_status: 'pending' },
    });

    render(
      <SessionView
        sessionId="s1"
        allFiles={[
          { id: 'f1', name: 'doc.md', type: 'md', mode: 'editor' },
          { id: 's1', name: 'chat', type: 'session', mode: 'editor' },
        ]}
        permissions={{ f1: 'read' }}
        onTogglePermission={mocks.onTogglePermission}
      />
    );

    expect(await screen.findByText(/Preparing index for 1 context file/)).toBeInTheDocument();
    expect(mocks.reindexFile).toHaveBeenCalledWith('f1', 'all');

    window.dispatchEvent(new CustomEvent('assistant-stream-event', {
      detail: {
        session_id: 's1',
        task_id: 't-stream',
        event_type: 'started',
        content: '',
      },
    }));
    window.dispatchEvent(new CustomEvent('assistant-stream-event', {
      detail: {
        session_id: 's1',
        task_id: 't-stream',
        event_type: 'delta',
        content: 'draft answer',
      },
    }));

    expect(await screen.findByText('Assistant Draft')).toBeInTheDocument();
    expect(screen.getByText('draft answer')).toBeInTheDocument();
    expect(screen.getAllByText('Retrieving context from 1 file(s)').length).toBeGreaterThan(0);
  });

  it('does not warm hidden or writable files in the background', async () => {
    mocks.chatState = {
      ...mocks.chatState,
      getMessagesForSession: () => [],
      getActiveTask: () => null,
      getTaskBoard: () => [],
      getPendingPrompt: () => null,
      getSessionReferences: () => [],
    };
    mocks.getFileIndexStatus.mockResolvedValue({
      success: true,
      data: { parse_status: 'pending', embedding_status: 'pending' },
    });

    render(
      <SessionView
        sessionId="s1"
        allFiles={[
          { id: 'f-read', name: 'paper.pdf', type: 'pdf', mode: 'editor' },
          { id: 'f-write', name: 'note.md', type: 'md', mode: 'editor' },
          { id: 'f-hidden', name: 'hidden.pdf', type: 'pdf', mode: 'editor' },
        ]}
        permissions={{ 'f-read': 'read', 'f-write': 'write', 'f-hidden': 'none' }}
        onTogglePermission={mocks.onTogglePermission}
      />
    );

    await waitFor(() => {
      expect(mocks.getFileIndexStatus).toHaveBeenCalledWith('f-read');
    });
    expect(mocks.getFileIndexStatus).not.toHaveBeenCalledWith('f-write');
    expect(mocks.getFileIndexStatus).not.toHaveBeenCalledWith('f-hidden');
    expect(mocks.reindexFile).toHaveBeenCalledTimes(1);
    expect(mocks.reindexFile).toHaveBeenCalledWith('f-read', 'all');
  });

  it('sends message when no active task is blocking input', async () => {
    mocks.chatState = {
      ...mocks.chatState,
      getMessagesForSession: () => [],
      getActiveTask: () => null,
      getTaskBoard: () => [],
      getPendingPrompt: () => null,
    };

    render(
      <SessionView
        sessionId="s1"
        allFiles={[
          { id: 'f1', name: 'doc.md', type: 'md', mode: 'editor' },
          { id: 'f2', name: 'paper.pdf', type: 'pdf', mode: 'editor' },
          { id: 's1', name: 'chat', type: 'session', mode: 'editor' },
        ]}
        permissions={{ f1: 'write', f2: 'none' }}
        onTogglePermission={mocks.onTogglePermission}
      />
    );

    const input = screen.getByPlaceholderText(/Type a message/);
    fireEvent.change(input, { target: { value: 'hello world' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(mocks.sendMessageForSession).toHaveBeenCalledWith('s1', 'hello world', ['f1']);
    });
  });

  it('renders connected/reconnecting states, empty files, and retry flow', async () => {
    mocks.wsStatus = 'connected';
    mocks.chatState = {
      ...mocks.chatState,
      getMessagesForSession: () => [],
      getActiveTask: () => ({
        taskId: 't-failed',
        status: 'failed',
        stage: 'blocked',
        progress: null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMessage: 'x',
        contextFiles: [],
      }),
      getTaskBoard: () => [],
      getPendingPrompt: () => null,
      getSessionReferences: () => [],
    };

    const { rerender } = render(
      <SessionView
        sessionId="s1"
        allFiles={[]}
        permissions={{}}
        onTogglePermission={mocks.onTogglePermission}
      />
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByTitle('Permissions synced with backend')).toBeInTheDocument();
    expect(screen.getAllByText('No files open.').length).toBeGreaterThan(0);
    expect(screen.queryByText('References')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('show'));
    expect(await screen.findByText(/No registered tasks yet/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Retry'));
    expect(mocks.retryLastTask).toHaveBeenCalledWith('s1');

    mocks.wsStatus = 'reconnecting';
    rerender(
      <SessionView
        sessionId="s1"
        allFiles={[]}
        permissions={{}}
        onTogglePermission={mocks.onTogglePermission}
      />
    );
    expect(screen.getByText('Reconnecting')).toBeInTheDocument();
  });

  it('handles cancelling task state, permission coercion, and pending prompt other-text answer', async () => {
    mocks.chatState = {
      ...mocks.chatState,
      getMessagesForSession: () => [
        {
          id: 'evt-complete',
          role: 'task_event',
          content: 'tool complete',
          timestamp: new Date().toISOString(),
          tool_results: {
            task_event: {
              event_type: 'tool_completed',
              stage: 'executing',
              payload: {
                tool: 'update_file',
                target_file_id: 'f2',
                success: false,
                error: 'boom',
              },
            },
          },
        },
      ],
      getActiveTask: () => ({
        taskId: 't-cancel',
        status: 'cancelling',
        stage: 'blocked',
        progress: null,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastMessage: 'x',
        contextFiles: [],
      }),
      getTaskBoard: () => [
        {
          id: 'item-1',
          name: 'Task one',
          status: 'running',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      getPendingPrompt: () => ({
        taskId: 't-cancel',
        requestedAt: new Date().toISOString(),
        prompt: {
          prompt_id: 'p-other',
          question: 'Choose',
          options: [{ id: 'o1', label: 'Option A' }],
          allow_other: true,
        },
      }),
      getSessionReferences: () => [],
    };

    render(
      <SessionView
        sessionId="s1"
        allFiles={[
          { id: 'f2', name: 'paper.pdf', type: 'pdf', mode: 'editor' },
          { id: 's1', name: 'chat', type: 'session', mode: 'editor' },
        ]}
        permissions={{ f2: 'write' }}
        onTogglePermission={mocks.onTogglePermission}
      />
    );

    expect(await screen.findByText('Cancelling')).toBeInTheDocument();
    expect(screen.getByText(/failed/)).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();

    fireEvent.click(screen.getByText('perm-read'));
    expect(mocks.onTogglePermission).toHaveBeenCalledWith('f2', 'pdf');

    const otherInput = screen.getByPlaceholderText('Input another option');
    fireEvent.change(otherInput, { target: { value: 'manual route' } });
    fireEvent.click(screen.getByText('Continue Task'));
    await waitFor(() => {
      expect(mocks.answerTaskPrompt).toHaveBeenCalledWith(
        's1',
        't-cancel',
        expect.objectContaining({
          promptId: 'p-other',
          selectedOptionId: undefined,
          otherText: 'manual route',
        })
      );
    });
  });
});
