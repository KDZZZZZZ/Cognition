import { useEffect, useRef } from 'react';
import { useDiffStore } from '../stores/diffStore';

function getWsBaseUrl() {
  const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
  if (apiBase.startsWith('https://')) return apiBase.replace('https://', 'wss://');
  if (apiBase.startsWith('http://')) return apiBase.replace('http://', 'ws://');
  return 'ws://localhost:8000';
}

export function useWebSocket(sessionId: string) {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<number>();
  const { clearDiff } = useDiffStore();

  useEffect(() => {
    if (!sessionId) return;

    const wsBase = getWsBaseUrl();
    let shouldReconnect = true;

    function connect() {
      if (ws.current) ws.current.close();

      const socket = new WebSocket(
        `${wsBase}/ws/connect?session_id=${encodeURIComponent(sessionId)}`
      );
      ws.current = socket;

      socket.onopen = () => {
        console.log('WebSocket connected');
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
          reconnectTimeout.current = window.setTimeout(connect, 3000);
        }
      };

      socket.onerror = (err) => {
        console.error('WebSocket error:', err);
        socket.close();
      };
    }

    connect();

    return () => {
      shouldReconnect = false;
      if (ws.current) ws.current.close();
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
    };
  }, [sessionId, clearDiff]);
}
