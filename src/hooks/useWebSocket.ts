import { useEffect, useRef } from 'react';
import { usePaneStore } from '../stores/paneStore';
import { useFileStore } from '../stores/apiStore';
import { useDiffStore } from '../stores/diffStore';
import { useUIStore } from '../stores/uiStore';

const WEBSOCKET_URL = 'ws://localhost:8000/ws';

export function useWebSocket(sessionId: string) {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<number>();
  const { setTabMode, getAllOpenTabs, panes } = usePaneStore();
  const { setFileContent, getFileContent } = useFileStore();
  const { setActiveDiff } = useDiffStore();

  useEffect(() => {
    if (!sessionId) return;

    function connect() {
      // Close existing connection if any
      if (ws.current) {
        ws.current.close();
      }

      const socket = new WebSocket(`${WEBSOCKET_URL}/${sessionId}`);
      ws.current = socket;

      socket.onopen = () => {
        console.log('WebSocket connected');
      };

      socket.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);

          if (message.type === 'file_update') {
            const { file_id, content, version_id, author } = message.data;

            // Only handle agent updates for diff view
            if (author === 'agent') {
              console.log('Received agent file update:', file_id);

              // 1. Get current content (old content)
              // We need to fetch it freshly or use what's in store
              // For diff purposes, we assume store has the pre-update content
              // But we might need to fetch it if it's not loaded.
              // However, since the agent just updated it on the backend,
              // the "old" content is what we currently have in the frontend store.
              const currentContent = useFileStore.getState().fileContents[file_id] || '';

              // 2. Set the diff
              setActiveDiff({
                fileId: file_id,
                versionId: version_id,
                oldContent: currentContent, // The content before this update
                newContent: content,        // The new content from agent
                versionLabel: `Agent Update ${version_id.substring(0, 8)}`
              });

              // 3. Find all open tabs for this file and switch them to diff mode
              // We need to find which pane has this file open
              panes.forEach(pane => {
                const tab = pane.tabs.find(t => t.id === file_id);
                if (tab) {
                  // Switch this tab to diff mode
                  setTabMode(pane.id, file_id, 'diff');

                  // Make this pane active if it's not
                  // (Optional: might be distracting if user is working elsewhere)
                  // usePaneStore.getState().setActivePane(pane.id);
                  // usePaneStore.getState().setActiveTab(pane.id, file_id);
                }
              });

              // 4. Update the file content in the store so other components know (eventually)
              // BUT: If we update it now, the "oldContent" in diff might be wrong if we re-read.
              // Actually, for the diff view to work, it uses the data in diffStore.
              // We should probably NOT update the main file store content yet,
              // or the user might see the new content if they switch back to editor mode
              // without "accepting" the diff.
              // However, the backend is already updated.
              // Let's update the store so if they open a new tab it shows new content,
              // but the diff view will show the comparison.
              setFileContent(file_id, content);
            }
          }
        } catch (err) {
          console.error('WebSocket message error:', err);
        }
      };

      socket.onclose = () => {
        console.log('WebSocket disconnected');
        // Reconnect after 3 seconds
        reconnectTimeout.current = window.setTimeout(connect, 3000);
      };

      socket.onerror = (err) => {
        console.error('WebSocket error:', err);
        socket.close();
      };
    }

    connect();

    return () => {
      if (ws.current) {
        ws.current.close();
      }
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
    };
  }, [sessionId, setTabMode, setActiveDiff, setFileContent, panes]);
}
