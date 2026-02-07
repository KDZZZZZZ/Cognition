import { Menu } from 'lucide-react';
import { Sidebar } from './components/layout/Sidebar';
import { PaneRenderer } from './components/pane/PaneRenderer';
import { useUIStore } from './stores/uiStore';
import { usePaneStore } from './stores/paneStore';
import { FileNode, ViewMode } from './types';

function App() {
  const { sidebarOpen, toggleSidebar, activePaneId, setActivePane } = useUIStore();
  const { panes, activePaneId: storeActivePaneId, createPane, openTab } = usePaneStore();

  const handleDrop = (e: React.DragEvent, paneId: string) => {
    e.preventDefault();
    const data = e.dataTransfer.getData('application/json');
    if (data) {
      try {
        const file = JSON.parse(data) as FileNode;
        if (file.type === 'folder') return;
        openTab(paneId, {
          id: file.id,
          name: file.name,
          type: file.type,
          mode: 'editor' as ViewMode,
        });
      } catch (err) {
        console.error('Failed to parse dropped file:', err);
      }
    }
  };

  return (
    <div className="flex flex-col h-screen w-full bg-white text-gray-800 font-sans overflow-hidden">
      <div className="h-12 bg-white border-b border-gray-200 flex items-center px-4 justify-between flex-shrink-0 z-20 shadow-sm">
        <div className="flex items-center gap-4">
          <button
            onClick={toggleSidebar}
            className="p-1 hover:bg-gray-100 rounded text-gray-600"
          >
            <Menu size={20} />
          </button>
        </div>
        <div className="text-sm font-medium text-gray-400 select-none">
          Knowledge IDE
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden relative">
        {sidebarOpen && <Sidebar />}
        <div className="flex-1 flex bg-gray-100 relative overflow-x-auto scroll-smooth">
          {panes.length === 0 ? (
            <div className="w-full flex flex-col items-center justify-center text-gray-400">
              <button
                onClick={createPane}
                className="bg-white p-6 rounded-xl shadow-sm hover:shadow-md transition-all flex flex-col items-center"
              >
                <span className="text-sm font-medium">New Pane</span>
              </button>
            </div>
          ) : (
            panes.map((pane) => (
              <PaneRenderer
                key={pane.id}
                pane={pane}
                isActive={(activePaneId || storeActivePaneId) === pane.id}
                onActivate={() => setActivePane(pane.id)}
                onDragOver={() => {}}
                onDragLeave={() => {}}
                onDrop={() => handleDrop}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
