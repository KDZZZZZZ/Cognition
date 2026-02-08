import { Menu, Moon, Sun } from 'lucide-react';
import { Sidebar } from './components/layout/Sidebar';
import { PaneRenderer } from './components/pane/PaneRenderer';
import { useUIStore } from './stores/uiStore';
import { usePaneStore } from './stores/paneStore';
import { FileNode, ViewMode } from './types';

function App() {
  const { sidebarOpen, toggleSidebar, activePaneId, setActivePane, theme, toggleTheme } = useUIStore();
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
    <div className="flex flex-col h-screen w-full bg-theme-bg text-theme-text font-sans overflow-hidden transition-colors duration-300">
      <div className="h-12 bg-theme-bg border-b border-theme-border flex items-center px-4 justify-between flex-shrink-0 z-20 shadow-sm transition-colors duration-300">
        <div className="flex items-center gap-4">
          <button
            onClick={toggleSidebar}
            className="p-1 hover:bg-theme-text/10 rounded text-theme-text/80 transition-colors"
          >
            <Menu size={20} />
          </button>
        </div>
        <div className="text-sm font-medium text-theme-text/60 select-none">
          Knowledge IDE
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={toggleTheme}
            className="p-1 hover:bg-theme-text/10 rounded text-theme-text/80 transition-colors"
            title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`}
          >
            {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
          </button>
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden relative">
        {sidebarOpen && <Sidebar />}
        <div className="flex-1 flex bg-theme-bg/50 relative overflow-x-auto scroll-smooth">
          {panes.length === 0 ? (
            <div className="w-full flex flex-col items-center justify-center text-theme-text/40">
              <button
                onClick={createPane}
                className="bg-theme-bg border-2 border-dashed border-theme-border/30 p-6 rounded-xl hover:border-theme-border hover:text-theme-text transition-all flex flex-col items-center"
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
