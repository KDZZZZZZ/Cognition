import { useEffect, useRef } from 'react';
import { useDiffStore } from '../stores/diffStore';
import { runtimeConfig } from '../config/runtime';

export type RealtimeStatus = 'checking' | 'connected' | 'reconnecting';

function getWsBaseUrl() {
  return runtimeConfig.wsBaseUrl;
}

function closeSocketGracefully(socket: WebSocket | null) {
  if (!socket) return;
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.addEventListener(
      'open',
      () => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close();
        }
      },
      { once: true }
    );
    return;
  }
  if (socket.readyState === WebSocket.OPEN) {
    socket.close();
  }
}

export function useWebSocket(
  sessionId: string,
  onStatusChange?: (status: RealtimeStatus) => void
) {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<number>();
  const connectTimeout = useRef<number>();
  const { clearDiff } = useDiffStore();

  useEffect(() => {
    if (!sessionId) return;

    const wsBase = getWsBaseUrl();
    let shouldReconnect = true;
    let hasConnectedAtLeastOnce = false;

    function connect() {
      closeSocketGracefully(ws.current);
      onStatusChange?.(hasConnectedAtLeastOnce ? 'reconnecting' : 'checking');

      const socket = new WebSocket(
        `${wsBase}/ws/connect?session_id=${encodeURIComponent(sessionId)}`
      );
      ws.current = socket;

      socket.onopen = () => {
        hasConnectedAtLeastOnce = true;
        onStatusChange?.('connected');
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'diff_event_created') {
            // Notify interested views to refresh pending diff state.
            window.dispatchEvent(new CustomEvent('diff-event-created', { detail: message.data }));
          } else if (message.type === 'task_progress') {
            // Stream task progress/events into chat timeline.
            window.dispatchEvent(new CustomEvent('agent-task-event', { detail: message.data }));
          } else if (message.type === 'assistant_stream') {
            window.dispatchEvent(new CustomEvent('assistant-stream-event', { detail: message.data }));
          } else if (message.type === 'file_update') {
            // Legacy support: clear outdated manual diff state.
            clearDiff();
          }
        } catch (err) {
          console.error('WebSocket message error:', err);
        }
      };

      socket.onclose = () => {
        if (shouldReconnect) {
          onStatusChange?.('reconnecting');
          reconnectTimeout.current = window.setTimeout(connect, 3000);
        }
      };

      socket.onerror = () => {
        if (socket.readyState !== WebSocket.CLOSING && socket.readyState !== WebSocket.CLOSED) {
          socket.close();
        }
      };
    }

    // Delay first connect slightly to avoid connect/close thrash when users switch tabs quickly.
    onStatusChange?.('checking');
    connectTimeout.current = window.setTimeout(connect, 220);

    return () => {
      shouldReconnect = false;
      if (connectTimeout.current) clearTimeout(connectTimeout.current);
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      if (ws.current) {
        closeSocketGracefully(ws.current);
        ws.current = null;
      }
    };
  }, [sessionId, clearDiff, onStatusChange]);
}
