import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from '../useWebSocket';
import { useDiffStore } from '../../stores/diffStore';

class MockSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockSocket[] = [];

  url: string;
  readyState = MockSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  private openListeners: Array<() => void> = [];
  closeCalled = 0;

  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
  }

  addEventListener(event: string, cb: () => void) {
    if (event === 'open') this.openListeners.push(cb);
  }

  emitOpen() {
    this.readyState = MockSocket.OPEN;
    this.onopen?.();
    this.openListeners.forEach((cb) => cb());
  }

  emitMessage(data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  emitClose() {
    this.readyState = MockSocket.CLOSED;
    this.onclose?.();
  }

  close() {
    this.closeCalled += 1;
    this.readyState = MockSocket.CLOSED;
  }
}

describe('useWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockSocket.instances = [];
    vi.stubGlobal('WebSocket', MockSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('connects, dispatches events, and reconnects on close', () => {
    const status = vi.fn();
    const clearDiff = vi.fn();
    useDiffStore.setState({ clearDiff });

    const diffEventSpy = vi.fn();
    const taskEventSpy = vi.fn();
    const assistantStreamSpy = vi.fn();
    window.addEventListener('diff-event-created', diffEventSpy);
    window.addEventListener('agent-task-event', taskEventSpy);
    window.addEventListener('assistant-stream-event', assistantStreamSpy);

    const { unmount } = renderHook(() => useWebSocket('session-1', status));

    act(() => {
      vi.advanceTimersByTime(220);
    });
    expect(MockSocket.instances).toHaveLength(1);
    const socket = MockSocket.instances[0];
    expect(socket.url).toContain('/ws/connect?session_id=session-1');

    act(() => {
      socket.emitOpen();
      socket.emitMessage({ type: 'diff_event_created', data: { id: 'd1' } });
      socket.emitMessage({ type: 'task_progress', data: { id: 't1' } });
      socket.emitMessage({ type: 'assistant_stream', data: { id: 'a1' } });
      socket.emitMessage({ type: 'file_update', data: { id: 'f1' } });
      socket.emitClose();
      vi.advanceTimersByTime(3000);
    });

    expect(status).toHaveBeenCalledWith('checking');
    expect(status).toHaveBeenCalledWith('connected');
    expect(status).toHaveBeenCalledWith('reconnecting');
    expect(diffEventSpy).toHaveBeenCalled();
    expect(taskEventSpy).toHaveBeenCalled();
    expect(assistantStreamSpy).toHaveBeenCalled();
    expect(clearDiff).toHaveBeenCalled();
    expect(MockSocket.instances.length).toBeGreaterThan(1);

    unmount();
  });

  it('skips connection when session id is empty', () => {
    const status = vi.fn();
    renderHook(() => useWebSocket('', status));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(MockSocket.instances).toHaveLength(0);
    expect(status).not.toHaveBeenCalled();
  });

  it('handles invalid messages and closes socket on error when open', () => {
    const status = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderHook(() => useWebSocket('session-2', status));

    act(() => {
      vi.advanceTimersByTime(220);
    });
    const socket = MockSocket.instances[0];
    act(() => {
      socket.emitOpen();
      socket.onmessage?.({ data: '{bad-json' });
    });
    expect(consoleSpy).toHaveBeenCalled();

    socket.readyState = MockSocket.OPEN;
    act(() => {
      socket.onerror?.();
    });
    expect(socket.closeCalled).toBe(1);

    socket.readyState = MockSocket.CLOSING;
    act(() => {
      socket.onerror?.();
    });
    expect(socket.closeCalled).toBe(1);
  });

  it('closes connecting socket during cleanup after it eventually opens', () => {
    const { unmount } = renderHook(() => useWebSocket('session-3', vi.fn()));
    act(() => {
      vi.advanceTimersByTime(220);
    });
    const socket = MockSocket.instances[0];
    expect(socket.readyState).toBe(MockSocket.CONNECTING);

    unmount();
    act(() => {
      socket.emitOpen();
    });
    expect(socket.readyState).toBe(MockSocket.CLOSED);
  });
});
