import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskEventPayload } from '../../api/client';

const { mockApi, getSessionPermissions, setSessionState } = vi.hoisted(() => ({
  mockApi: {
    getViewport: vi.fn(),
    chatCompletion: vi.fn(),
    cancelTask: vi.fn(),
    answerTaskPrompt: vi.fn(),
    getSessionMessages: vi.fn(),
  },
  getSessionPermissions: vi.fn(() => ({})),
  setSessionState: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: mockApi,
}));

vi.mock('../sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      getSessionPermissions,
    }),
    setState: setSessionState,
  },
}));

import { useChatStore } from '../chatStore';

function resetStore() {
  useChatStore.setState({
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
    model: 'kimi-latest',
  });
}

describe('useChatStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('handles sendMessageForSession success flow', async () => {
    mockApi.getViewport.mockResolvedValueOnce({
      success: true,
      data: { viewports: [{ file_id: 'f1', page: 2, timestamp: new Date().toISOString() }] },
    });
    mockApi.chatCompletion.mockResolvedValueOnce({
      success: true,
      data: {
        message_id: 'assistant-1',
        content: 'done',
        timestamp: new Date().toISOString(),
        tool_calls: [],
        tool_results: [],
        citations: [],
      },
    });

    await useChatStore.getState().sendMessageForSession('s1', 'hello', ['f1']);
    const messages = useChatStore.getState().messages.s1;
    expect(messages[messages.length - 1]?.role).toBe('assistant');
    expect(useChatStore.getState().activeTasks.s1?.status).toBe('completed');
    expect(useChatStore.getState().loadingSessions.s1).toBe(false);
    expect(setSessionState).toHaveBeenCalled();
  });

  it('handles sendMessageForSession response failure and thrown error', async () => {
    mockApi.getViewport.mockResolvedValueOnce({ success: false });
    mockApi.chatCompletion.mockResolvedValueOnce({ success: false, error: 'backend fail' });
    await useChatStore.getState().sendMessageForSession('s2', 'hello', []);
    expect(useChatStore.getState().error).toBe('backend fail');
    expect(useChatStore.getState().activeTasks.s2?.status).toBe('failed');

    mockApi.getViewport.mockRejectedValueOnce(new Error('network'));
    mockApi.chatCompletion.mockRejectedValueOnce(new Error('network'));
    await useChatStore.getState().sendMessageForSession('s3', 'hello', []);
    expect(useChatStore.getState().activeTasks.s3?.status).toBe('failed');
  });

  it('ingests task events and updates pending prompts/task board', () => {
    const base: TaskEventPayload = {
      event_id: 'e1',
      session_id: 's4',
      task_id: 't1',
      event_type: 'user_input_requested',
      stage: 'blocked',
      message: 'need input',
      status: 'paused',
      timestamp: new Date().toISOString(),
      payload: {
        prompt: {
          prompt_id: 'p1',
          question: 'Choose',
          options: [{ id: 'o1', label: 'A' }, { id: 'o2', label: 'B' }],
        },
        task_item: { id: 'task-1', name: 'Do thing', status: 'running' },
      },
    };
    useChatStore.getState().ingestTaskEvent('s4', base);
    expect(useChatStore.getState().pendingPrompts.s4?.prompt.prompt_id).toBe('p1');
    expect(useChatStore.getState().taskBoards.s4).toHaveLength(1);

    useChatStore.getState().ingestTaskEvent('s4', {
      ...base,
      event_id: 'e2',
      event_type: 'task_completed',
      status: 'completed',
    });
    expect(useChatStore.getState().pendingPrompts.s4).toBeNull();
  });

  it('cancels active task and retries from snapshot', async () => {
    const controller = new AbortController();
    const abortSpy = vi.spyOn(controller, 'abort');
    useChatStore.setState({
      activeTasks: {
        s5: {
          taskId: 'task-1',
          status: 'running',
          stage: 'executing',
          progress: 30,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastMessage: 'hello',
          contextFiles: [],
        },
      },
      abortControllers: { s5: controller },
      loadingSessions: {},
      loading: false,
      messages: {},
      pendingPrompts: {},
      taskBoards: {},
      lastTaskInput: { s5: { message: 'hello', contextFiles: [] } },
      sessionReferences: {},
      error: null,
      sessionId: 'default-session',
      model: 'kimi-latest',
    });

    mockApi.cancelTask.mockResolvedValueOnce({ success: true });
    await useChatStore.getState().cancelActiveTask('s5');
    expect(abortSpy).toHaveBeenCalled();
    expect(useChatStore.getState().activeTasks.s5?.status).toBe('cancelling');

    mockApi.getViewport.mockResolvedValueOnce({ success: false });
    mockApi.chatCompletion.mockResolvedValueOnce({
      success: true,
      data: {
        message_id: 'assistant-2',
        content: 'retried',
        timestamp: new Date().toISOString(),
        tool_calls: [],
        tool_results: [],
        citations: [],
      },
    });
    useChatStore.setState((state) => ({
      ...state,
      activeTasks: {
        ...state.activeTasks,
        s5: null,
      },
    }));
    await useChatStore.getState().retryLastTask('s5');
    const sessionMessages = useChatStore.getState().messages.s5;
    expect(sessionMessages[sessionMessages.length - 1]?.content).toBe('retried');
  });

  it('answers pending task prompt and manages references/messages', async () => {
    const now = new Date().toISOString();
    useChatStore.setState({
      pendingPrompts: {
        s6: {
          taskId: 'task-2',
          prompt: {
            prompt_id: 'p2',
            question: 'Pick',
            options: [{ id: 'o1', label: 'A' }, { id: 'o2', label: 'B' }],
          },
          requestedAt: now,
        },
      },
      activeTasks: {
        s6: {
          taskId: 'task-2',
          status: 'paused',
          stage: 'blocked',
          progress: null,
          startedAt: now,
          updatedAt: now,
          lastMessage: 'msg',
          contextFiles: [],
        },
      },
      loadingSessions: {},
      loading: false,
      messages: { s6: [] },
      taskBoards: {},
      lastTaskInput: {},
      abortControllers: {},
      sessionReferences: {},
      error: null,
      sessionId: 'default-session',
      model: 'kimi-latest',
    });

    mockApi.answerTaskPrompt.mockResolvedValueOnce({
      success: true,
      data: {
        message_id: 'assistant-3',
        content: 'paused again',
        timestamp: now,
        paused: true,
        awaiting_user_input: {
          prompt_id: 'p3',
          question: 'Again',
          options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }],
        },
      },
    });

    await useChatStore.getState().answerTaskPrompt('s6', 'task-2', {
      promptId: 'p2',
      selectedOptionId: 'o1',
    });
    expect(useChatStore.getState().pendingPrompts.s6?.prompt.prompt_id).toBe('p3');

    useChatStore.getState().addSessionReference('s6', {
      sourceFileId: 'f1',
      sourceFileName: 'doc.md',
      markdown: '## ref',
    });
    useChatStore.getState().addSessionReference('s6', {
      sourceFileId: 'f1',
      sourceFileName: 'doc.md',
      markdown: '## ref',
    });
    expect(useChatStore.getState().getSessionReferences('s6')).toHaveLength(1);

    const refId = useChatStore.getState().getSessionReferences('s6')[0].id;
    useChatStore.getState().removeSessionReference('s6', refId);
    expect(useChatStore.getState().getSessionReferences('s6')).toHaveLength(0);

    useChatStore.getState().clearSessionReferences('s6');
    useChatStore.getState().clearSessionMessages('s6');
    expect(useChatStore.getState().messages.s6).toBeUndefined();
  });

  it('loads session messages and derives board/prompt', async () => {
    const ts = new Date().toISOString();
    mockApi.getSessionMessages.mockResolvedValueOnce({
      success: true,
      data: {
        messages: [
          {
            id: 'te1',
            role: 'task_event',
            content: 'start',
            timestamp: ts,
            tool_results: {
              task_event: {
                event_id: 'te1',
                session_id: 's7',
                task_id: 'task-7',
                event_type: 'user_input_requested',
                stage: 'blocked',
                message: 'Need choice',
                status: 'paused',
                timestamp: ts,
                payload: {
                  prompt: {
                    prompt_id: 'pp',
                    question: 'Pick',
                    options: [{ id: '1', label: 'One' }, { id: '2', label: 'Two' }],
                  },
                  task_item: { id: 'ti', name: 'Task item', status: 'running' },
                },
              },
            },
          },
        ],
      },
    });
    await useChatStore.getState().loadSessionMessages('s7');
    expect(useChatStore.getState().messages.s7).toHaveLength(1);
    expect(useChatStore.getState().taskBoards.s7).toHaveLength(1);
    expect(useChatStore.getState().pendingPrompts.s7?.prompt.prompt_id).toBe('pp');
  });

  it('blocks new send when task is active and supports sendMessage wrapper', async () => {
    useChatStore.setState({
      sessionId: 'sx',
      activeTasks: {
        sx: {
          taskId: 'running-1',
          status: 'running',
          stage: 'executing',
          progress: 20,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastMessage: 'busy',
          contextFiles: [],
        },
      },
    });

    await useChatStore.getState().sendMessageForSession('sx', 'blocked', []);
    expect(useChatStore.getState().error).toContain('A task is active');
    expect(mockApi.chatCompletion).not.toHaveBeenCalled();

    useChatStore.setState({
      activeTasks: {},
      error: null,
    });
    mockApi.getViewport.mockResolvedValueOnce({ success: false });
    mockApi.chatCompletion.mockResolvedValueOnce({
      success: true,
      data: {
        message_id: 'assistant-wrap',
        content: 'wrapped send',
        timestamp: new Date().toISOString(),
        tool_calls: [],
        tool_results: [],
        citations: [],
      },
    });

    await useChatStore.getState().sendMessage('hello via wrapper', []);
    expect(useChatStore.getState().messages.sx?.some((m) => m.id === 'assistant-wrap')).toBe(true);
  });

  it('handles paused/cancelled/failed/abort outcomes for sendMessageForSession', async () => {
    mockApi.getViewport.mockResolvedValue({ success: false });
    mockApi.chatCompletion
      .mockResolvedValueOnce({
        success: true,
        data: {
          message_id: 'assistant-paused',
          content: 'waiting',
          timestamp: new Date().toISOString(),
          paused: true,
          awaiting_user_input: { prompt_id: 'bad', question: 'Q', options: [] },
          tool_calls: [],
          tool_results: [],
          citations: [],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          message_id: 'assistant-cancelled',
          content: 'cancelled',
          timestamp: new Date().toISOString(),
          cancelled: true,
          tool_calls: [],
          tool_results: [],
          citations: [],
        },
      })
      .mockResolvedValueOnce({
        success: true,
        data: {
          message_id: 'assistant-failed',
          content: 'failed-content',
          timestamp: new Date().toISOString(),
          failed: true,
          tool_calls: [],
          tool_results: [],
          citations: [],
        },
      })
      .mockRejectedValueOnce({ name: 'AbortError' });

    await useChatStore.getState().sendMessageForSession('sp', 'paused', []);
    expect(useChatStore.getState().activeTasks.sp?.status).toBe('paused');
    expect(useChatStore.getState().pendingPrompts.sp).toBeNull();

    await useChatStore.getState().sendMessageForSession('sc', 'cancelled', []);
    expect(useChatStore.getState().activeTasks.sc?.status).toBe('cancelled');

    await useChatStore.getState().sendMessageForSession('sf', 'failed', []);
    expect(useChatStore.getState().activeTasks.sf?.status).toBe('failed');
    expect(useChatStore.getState().error).toBe('failed-content');

    await useChatStore.getState().sendMessageForSession('sa', 'abort', []);
    expect(useChatStore.getState().activeTasks.sa?.status).toBe('cancelled');
    expect(useChatStore.getState().error).toBeNull();
  });

  it('deduplicates task events and updates board transitions', () => {
    const ts = new Date().toISOString();
    const startedA: TaskEventPayload = {
      event_id: 'evt-a',
      session_id: 'sboard',
      task_id: 'task-board',
      event_type: 'task_item_started',
      stage: 'executing',
      message: 'start a',
      status: 'running',
      timestamp: ts,
      payload: {
        task_item: {
          id: 'item-a',
          name: 'Item A',
          status: 'running',
        },
      },
    };

    useChatStore.getState().ingestTaskEvent('sboard', startedA);
    useChatStore.getState().ingestTaskEvent('sboard', startedA);
    expect(useChatStore.getState().messages.sboard).toHaveLength(1);

    useChatStore.getState().ingestTaskEvent('sboard', {
      ...startedA,
      event_id: 'evt-b',
      event_type: 'task_item_started',
      payload: {
        task_item: {
          id: 'item-b',
          name: 'Item B',
          status: 'running',
        },
      },
    });

    const board = useChatStore.getState().taskBoards.sboard;
    const itemA = board.find((item) => item.id === 'item-a');
    const itemB = board.find((item) => item.id === 'item-b');
    expect(itemA?.status).toBe('waiting');
    expect(itemB?.status).toBe('running');
  });

  it('handles cancel/retry guardrails and clearMessages', async () => {
    const ts = new Date().toISOString();
    const abortController = new AbortController();
    const abortSpy = vi.spyOn(abortController, 'abort');
    useChatStore.setState({
      sessionId: 's-clear',
      activeTasks: {
        's-clear': {
          taskId: 't-clear',
          status: 'paused',
          stage: 'blocked',
          progress: null,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastMessage: 'old',
          contextFiles: ['f1'],
        },
      },
      abortControllers: { 's-clear': abortController },
      lastTaskInput: { 's-clear': { message: 'retry this', contextFiles: ['f1'] } },
      loadingSessions: {},
      loading: false,
      messages: { 's-clear': [] },
      pendingPrompts: {},
      taskBoards: {},
      sessionReferences: {},
      error: null,
      model: 'kimi-latest',
    });

    mockApi.cancelTask.mockRejectedValueOnce(new Error('cancel api down'));
    await useChatStore.getState().cancelActiveTask('s-clear');
    expect(abortSpy).toHaveBeenCalled();
    expect(useChatStore.getState().activeTasks['s-clear']?.status).toBe('cancelling');

    await useChatStore.getState().retryLastTask('s-clear');
    expect(useChatStore.getState().error).toContain('still running');

    useChatStore.setState({
      activeTasks: { 's-clear': null },
      lastTaskInput: { 's-clear': null },
    });
    await useChatStore.getState().retryLastTask('s-clear');
    expect(useChatStore.getState().error).toContain('No task input');

    useChatStore.setState({
      messages: { 's-clear': [{ id: 'm1', role: 'user', content: 'x', timestamp: new Date().toISOString() }] as any },
      taskBoards: { 's-clear': [{ id: 'i1', name: 'task', status: 'running', createdAt: ts, updatedAt: ts }] as any },
      pendingPrompts: { 's-clear': { taskId: 't-clear', prompt: { prompt_id: 'p', question: 'q', options: [{ id: '1', label: 'one' }] }, requestedAt: ts } as any },
      lastTaskInput: { 's-clear': { message: 'x', contextFiles: [] } },
    });
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().messages['s-clear']).toEqual([]);
    expect(useChatStore.getState().activeTasks['s-clear']).toBeNull();
  });

  it('handles answerTaskPrompt error branches and session-message loading fallbacks', async () => {
    await useChatStore.getState().answerTaskPrompt('spx', 'task-x', {
      promptId: 'missing',
    });
    expect(useChatStore.getState().error).toContain('No pending prompt');

    const now = new Date().toISOString();
    useChatStore.setState({
      pendingPrompts: {
        spx: {
          taskId: 'task-x',
          prompt: {
            prompt_id: 'p1',
            question: 'Pick one',
            options: [{ id: 'o1', label: 'A' }],
          },
          requestedAt: now,
        },
      },
      activeTasks: {
        spx: {
          taskId: 'task-x',
          status: 'paused',
          stage: 'blocked',
          progress: null,
          startedAt: now,
          updatedAt: now,
          lastMessage: 'msg',
          contextFiles: [],
        },
      },
      messages: { spx: [] },
      loadingSessions: {},
      loading: false,
      taskBoards: {},
      lastTaskInput: {},
      abortControllers: {},
      sessionReferences: {},
      error: null,
      sessionId: 'default-session',
      model: 'kimi-latest',
    });

    mockApi.answerTaskPrompt.mockResolvedValueOnce({ success: false, error: 'answer failed' });
    await useChatStore.getState().answerTaskPrompt('spx', 'task-x', {
      promptId: 'p1',
      selectedOptionId: 'o1',
    });
    expect(useChatStore.getState().activeTasks.spx?.status).toBe('failed');

    mockApi.answerTaskPrompt.mockRejectedValueOnce(new Error('network answer'));
    await useChatStore.getState().answerTaskPrompt('spx', 'task-x', {
      promptId: 'p1',
      otherText: 'manual answer',
    });
    expect(useChatStore.getState().error).toBe('Failed to answer prompt');

    useChatStore.getState().addSessionReference('spx', {
      sourceFileId: 'f-empty',
      sourceFileName: 'empty.md',
      markdown: '   ',
    });
    expect(useChatStore.getState().getSessionReferences('spx')).toHaveLength(0);

    mockApi.getSessionMessages.mockResolvedValueOnce({ success: true, data: {} });
    await useChatStore.getState().loadSessionMessages('spx');
    expect(useChatStore.getState().messages.spx).toHaveLength(2);

    mockApi.getSessionMessages.mockRejectedValueOnce(new Error('load failed'));
    await useChatStore.getState().loadSessionMessages('spx');
    expect(useChatStore.getState().messages.spx).toHaveLength(2);
  });

  it('covers task normalization and prompt fallback parsing from loaded messages', async () => {
    const t1 = new Date(Date.now() - 1000).toISOString();
    const t2 = new Date().toISOString();
    mockApi.getSessionMessages.mockResolvedValueOnce({
      success: true,
      data: {
        messages: [
          {
            id: 'a',
            role: 'task_event',
            content: 'delivered',
            timestamp: t1,
            tool_results: {
              task_event: {
                event_id: 'evt-a',
                session_id: 's-fallback',
                task_id: 'task-a',
                event_type: 'task_item_delivered',
                stage: 'done',
                message: 'done',
                status: 'completed',
                timestamp: t1,
                payload: {
                  task_item: {
                    task_item_id: 'item-alt',
                    task_name: 'Alt Item',
                    status: 'completed',
                    description: 'desc',
                    completion_summary: 'sum',
                  },
                },
              },
            },
          },
          {
            id: 'b',
            role: 'task_event',
            content: 'needs input',
            timestamp: t2,
            tool_results: {
              task_event: {
                event_id: 'evt-b',
                session_id: 's-fallback',
                task_id: 'task-a',
                event_type: 'user_input_requested',
                stage: 'blocked',
                message: 'need choose',
                status: 'paused',
                timestamp: t2,
                payload: {
                  prompt: {
                    prompt_id: 'p-fallback',
                    question: 'Pick one',
                    options: [
                      { label: 'Choice A', recommended: true, description: 'best' },
                      { id: 'x2', label: '' },
                    ],
                    recommended_option_id: 'x1',
                    allow_other: false,
                    other_placeholder: 'other...',
                  },
                },
              },
            },
          },
          {
            id: 'c',
            role: 'task_event',
            content: 'resumed',
            timestamp: new Date(Date.now() + 1000).toISOString(),
            tool_results: {
              task_event: {
                event_id: 'evt-c',
                session_id: 's-fallback',
                task_id: 'task-a',
                event_type: 'task_resumed',
                stage: 'executing',
                message: 'resumed',
                status: 'running',
                timestamp: new Date(Date.now() + 1000).toISOString(),
                payload: {},
              },
            },
          },
          {
            id: 'd',
            role: 'task_event',
            content: 'invalid payload',
            timestamp: t2,
            tool_results: {},
          },
        ],
      },
    });

    await useChatStore.getState().loadSessionMessages('s-fallback');
    const board = useChatStore.getState().taskBoards['s-fallback'];
    expect(board[0].id).toBe('item-alt');
    expect(board[0].name).toBe('Alt Item');
    expect(board[0].status).toBe('completed');
    expect(board[0].description).toBe('desc');
    expect(board[0].completionSummary).toBe('sum');
    expect(useChatStore.getState().pendingPrompts['s-fallback']).toBeNull();
  });

  it('ignores stale session message loads that resolve out of order', async () => {
    const olderTimestamp = new Date(Date.now() - 1000).toISOString();
    const newerTimestamp = new Date().toISOString();

    let resolveFirst: ((value: any) => void) | undefined;
    let resolveSecond: ((value: any) => void) | undefined;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise((resolve) => {
      resolveSecond = resolve;
    });

    mockApi.getSessionMessages
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);

    const loadFirst = useChatStore.getState().loadSessionMessages('s-race');
    const loadSecond = useChatStore.getState().loadSessionMessages('s-race');

    resolveSecond?.({
      success: true,
      data: {
        messages: [
          { id: 'newer', role: 'assistant', content: 'newer', timestamp: newerTimestamp },
        ],
      },
    });
    await loadSecond;

    resolveFirst?.({
      success: true,
      data: {
        messages: [
          { id: 'older', role: 'assistant', content: 'older', timestamp: olderTimestamp },
        ],
      },
    });
    await loadFirst;

    expect(useChatStore.getState().messages['s-race']).toEqual([
      { id: 'newer', role: 'assistant', content: 'newer', timestamp: newerTimestamp },
    ]);
  });

  it('covers reference preamble, default send/answer fallbacks, and guard statuses', async () => {
    useChatStore.getState().addSessionReference('s-ref', {
      sourceFileId: 'f1',
      sourceFileName: 'doc.md',
      markdown: '## context block',
    });
    mockApi.getViewport.mockResolvedValueOnce({
      success: true,
      data: { viewports: [{ timestamp: new Date().toISOString(), file_id: 123, page: 'x' }] as any },
    });
    mockApi.chatCompletion.mockResolvedValueOnce({
      success: true,
      data: {
        message_id: 'assistant-ref',
        content: 'ok',
        timestamp: new Date().toISOString(),
        tool_calls: [],
        tool_results: [],
        citations: [],
      },
    });
    await useChatStore.getState().sendMessageForSession('s-ref', 'hello', []);
    expect(mockApi.chatCompletion).toHaveBeenCalledWith(
      's-ref',
      expect.stringContaining('Reference 1 (doc.md):'),
      [],
      expect.any(String),
      true,
      expect.objectContaining({ activeFileId: undefined, activePage: undefined })
    );

    mockApi.getViewport.mockResolvedValueOnce({ success: false });
    mockApi.chatCompletion.mockResolvedValueOnce({ success: false });
    await useChatStore.getState().sendMessageForSession('s-fail-default', 'oops', []);
    expect(useChatStore.getState().error).toBe('Failed to send message');

    useChatStore.setState({
      activeTasks: {
        's-guard-cancel': {
          taskId: 't1',
          status: 'cancelling',
          stage: 'blocked',
          progress: null,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastMessage: '',
          contextFiles: [],
        },
        's-guard-paused': {
          taskId: 't2',
          status: 'paused',
          stage: 'blocked',
          progress: null,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastMessage: '',
          contextFiles: [],
        },
      },
    });
    await useChatStore.getState().sendMessageForSession('s-guard-cancel', 'x', []);
    expect(useChatStore.getState().error).toContain('A task is active');
    await useChatStore.getState().sendMessageForSession('s-guard-paused', 'x', []);
    expect(useChatStore.getState().error).toContain('A task is active');

    useChatStore.setState({
      pendingPrompts: {
        's-answer': {
          taskId: 'ta',
          prompt: {
            prompt_id: 'pa',
            question: 'pick',
            options: [{ id: 'ok', label: 'OK' }],
          },
          requestedAt: new Date().toISOString(),
        },
      },
      activeTasks: {},
      messages: {},
      loadingSessions: {},
      loading: false,
      taskBoards: {},
      lastTaskInput: {},
      abortControllers: {},
      sessionReferences: {},
      error: null,
      sessionId: 'default-session',
      model: 'kimi-latest',
    });
    mockApi.answerTaskPrompt.mockResolvedValueOnce({
      success: true,
      data: {
        message_id: 'assistant-answer',
        content: 'paused',
        paused: true,
        awaiting_user_input: {
          prompt_id: 'pb',
          question: 'again',
          options: [{ label: 'fallback option' }],
        },
      },
    });
    await useChatStore.getState().answerTaskPrompt('s-answer', 'ta', {
      promptId: 'pa',
      selectedOptionId: 'unknown-option',
    });
    expect(useChatStore.getState().messages['s-answer'][0].content).toContain('unknown-option');
    expect(useChatStore.getState().pendingPrompts['s-answer']?.prompt.options[0].id).toBe('opt_1');
  });

  it('covers paused send prompt creation and answer transitions for cancelled/failed/default-error', async () => {
    mockApi.getViewport.mockResolvedValueOnce({ success: false });
    mockApi.chatCompletion.mockResolvedValueOnce({
      success: true,
      data: {
        message_id: 'assistant-paused-valid',
        content: 'paused with prompt',
        timestamp: new Date().toISOString(),
        paused: true,
        awaiting_user_input: {
          prompt_id: 'p-valid',
          question: 'Choose',
          options: [{ id: 'a', label: 'A' }],
        },
        tool_calls: [],
        tool_results: [],
        citations: [],
      },
    });
    await useChatStore.getState().sendMessageForSession('s-paused-valid', 'hello', []);
    expect(useChatStore.getState().pendingPrompts['s-paused-valid']?.prompt.prompt_id).toBe('p-valid');

    useChatStore.setState({
      pendingPrompts: {
        's-ans2': {
          taskId: 't-ans2',
          prompt: { prompt_id: 'p2', question: 'q', options: [{ id: 'x', label: 'X' }] },
          requestedAt: new Date().toISOString(),
        },
      },
      activeTasks: {
        's-ans2': {
          taskId: 't-ans2',
          status: 'paused',
          stage: 'blocked',
          progress: null,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastMessage: 'x',
          contextFiles: [],
        },
      },
      messages: { 's-ans2': [] },
      loadingSessions: {},
      loading: false,
      taskBoards: {},
      lastTaskInput: {},
      abortControllers: {},
      sessionReferences: {},
      error: null,
      sessionId: 'default-session',
      model: 'kimi-latest',
    });

    mockApi.answerTaskPrompt.mockResolvedValueOnce({
      success: true,
      data: {
        message_id: 'assistant-cancel',
        content: 'cancelled',
        timestamp: new Date().toISOString(),
        cancelled: true,
      },
    });
    await useChatStore.getState().answerTaskPrompt('s-ans2', 't-ans2', { promptId: 'p2' });
    expect(useChatStore.getState().messages['s-ans2'][0].content).toContain('[Paused Prompt Answer]');
    expect(useChatStore.getState().activeTasks['s-ans2']?.status).toBe('cancelled');

    useChatStore.setState({
      pendingPrompts: {
        's-ans3': {
          taskId: 't-ans3',
          prompt: { prompt_id: 'p3', question: 'q', options: [{ id: 'x', label: 'X' }] },
          requestedAt: new Date().toISOString(),
        },
      },
      activeTasks: {
        's-ans3': {
          taskId: 't-ans3',
          status: 'paused',
          stage: 'blocked',
          progress: null,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastMessage: 'x',
          contextFiles: [],
        },
      },
      messages: { 's-ans3': [] },
    } as any);
    mockApi.answerTaskPrompt.mockResolvedValueOnce({
      success: true,
      data: {
        message_id: 'assistant-failed',
        content: 'failed explicit',
        timestamp: new Date().toISOString(),
        failed: true,
      },
    });
    await useChatStore.getState().answerTaskPrompt('s-ans3', 't-ans3', { promptId: 'p3', selectedOptionId: 'x' });
    expect(useChatStore.getState().activeTasks['s-ans3']?.status).toBe('failed');
    expect(useChatStore.getState().error).toBe('failed explicit');

    useChatStore.setState({
      pendingPrompts: {
        's-ans4': {
          taskId: 't-ans4',
          prompt: { prompt_id: 'p4', question: 'q', options: [{ id: 'x', label: 'X' }] },
          requestedAt: new Date().toISOString(),
        },
      },
      activeTasks: {
        's-ans4': {
          taskId: 't-ans4',
          status: 'paused',
          stage: 'blocked',
          progress: null,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastMessage: 'x',
          contextFiles: [],
        },
      },
      messages: { 's-ans4': [] },
    } as any);
    mockApi.answerTaskPrompt.mockResolvedValueOnce({ success: false });
    await useChatStore.getState().answerTaskPrompt('s-ans4', 't-ans4', { promptId: 'p4', selectedOptionId: 'x' });
    expect(useChatStore.getState().error).toBe('Failed to answer prompt');

    useChatStore.setState({
      activeTasks: {
        's-retry-paused': {
          taskId: 't-retry',
          status: 'paused',
          stage: 'blocked',
          progress: null,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastMessage: 'x',
          contextFiles: [],
        },
      },
    } as any);
    await useChatStore.getState().retryLastTask('s-retry-paused');
    expect(useChatStore.getState().error).toContain('still running');
  });
});
