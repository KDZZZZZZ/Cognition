import { Menu, Sun } from 'lucide-react';
import { Sidebar } from './components/layout/Sidebar';
import { PaneRenderer } from './components/pane/PaneRenderer';
import { useUIStore } from './stores/uiStore';
import { usePaneStore } from './stores/paneStore';
import { FileNode, ViewMode } from './types';

function App() {
  const { sidebarOpen, toggleSidebar, activePaneId, setActivePane: setUiActivePane } = useUIStore();
  const { panes, activePaneId: storeActivePaneId, createPane, openTab, setActivePane: setPaneStoreActivePane } =
    usePaneStore();

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
    <div className="flex flex-col h-screen w-full bg-theme-bg text-theme-text overflow-hidden transition-colors duration-300">
      <div
        className="h-12 border-b border-theme-border/30 paper-divider-dashed flex items-center px-4 justify-between flex-shrink-0 z-20 shadow-[0_1px_0_rgba(16,16,16,0.05)] transition-colors duration-300"
        style={{ backgroundColor: 'var(--theme-surface)' }}
      >
        <div className="flex items-center gap-4">
          <button
            onClick={toggleSidebar}
            className="p-1 hover:bg-theme-text/8 rounded text-theme-text/80 transition-colors"
          >
            <Menu size={20} />
          </button>
        </div>

        <div className="text-sm font-semibold tracking-[0.08em] uppercase text-theme-text/65 select-none">
          Knowledge IDE
        </div>

        <div className="flex items-center gap-2">
          <button
            disabled
            className="p-1 rounded text-theme-text/35 bg-theme-text/[0.03] border border-theme-border/20 cursor-not-allowed"
            title="Light newspaper mode is fixed in this build"
          >
            <Sun size={18} />
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden relative">
        {sidebarOpen && <Sidebar />}
        <div
          className="flex-1 flex relative overflow-x-auto scroll-smooth"
          style={{ backgroundColor: 'var(--theme-surface-muted)' }}
        >
          {panes.length === 0 ? (
            <div className="w-full flex flex-col items-center justify-center text-theme-text/40">
              <button
                onClick={createPane}
                className="bg-theme-bg border border-dashed border-theme-border/35 paper-divider-dashed p-6 rounded-xl hover:border-theme-border/65 hover:text-theme-text transition-all flex flex-col items-center"
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
                onActivate={() => {
                  setUiActivePane(pane.id);
                  setPaneStoreActivePane(pane.id);
                }}
                onDragOver={() => {}}
                onDragLeave={() => {}}
                onDrop={(e) => handleDrop(e, pane.id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
