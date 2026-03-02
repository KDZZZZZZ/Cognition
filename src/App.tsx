import { useEffect } from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './components/layout/Sidebar';
import { PaneRenderer } from './components/pane/PaneRenderer';
import { useUIStore } from './stores/uiStore';
import { usePaneStore } from './stores/paneStore';
import { useFileStore } from './stores/apiStore';
import { FileNode, ViewMode } from './types';

function App() {
  const { sidebarOpen, toggleSidebar, activePaneId, setActivePane: setUiActivePane } = useUIStore();
  const { panes, activePaneId: storeActivePaneId, createPane, openTab, setActivePane: setPaneStoreActivePane } =
    usePaneStore();
  const { loadFiles } = useFileStore();
  const paneCount = panes.length;

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

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
    <div className="relative flex flex-col h-screen w-full bg-theme-bg text-theme-text overflow-hidden transition-colors duration-300">
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute -top-24 -left-24 h-72 w-72 rounded-full bg-[radial-gradient(circle,rgba(24,100,87,0.25),transparent_70%)]" />
        <div className="absolute -bottom-20 right-[-5rem] h-[16.5rem] w-[16.5rem] rounded-full bg-[radial-gradient(circle,rgba(193,115,54,0.17),transparent_70%)]" />
      </div>
      <div
        className="h-12 border-b border-theme-border/30 paper-divider-dashed surface-panel flex items-center px-4 justify-between flex-shrink-0 z-20 transition-colors duration-300"
      >
        <div className="flex items-center gap-3">
          <button
            onClick={toggleSidebar}
            className="p-1.5 hover:bg-theme-text/8 rounded text-theme-text/80 transition-colors"
          >
            <Menu size={20} />
          </button>
          <div className="hidden sm:flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-theme-text/45">
            <span className="accent-dot" />
            Workspace Ready
          </div>
        </div>

        <div className="text-sm font-semibold tracking-[0.08em] uppercase text-theme-text/65 select-none flex items-center gap-2">
          <span className="text-theme-text/40">Cognition</span>
          <span className="h-3 w-px bg-theme-border/30" />
          <span>Knowledge IDE</span>
        </div>

        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.12em] text-theme-text/45">
          <span>Desktop Workspace</span>
          {paneCount > 0 && (
            <>
              <span className="h-3 w-px bg-theme-border/20" />
              <span>{paneCount} Pane{paneCount === 1 ? '' : 's'} Open</span>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden relative z-10">
        {sidebarOpen && (
          <div className="mobile-overlay-panel h-full flex-shrink-0">
            <Sidebar />
          </div>
        )}
        <div
          className="flex-1 flex relative overflow-x-auto scroll-smooth surface-panel-muted subtle-grid"
        >
          {panes.length === 0 ? (
            <div className="w-full flex flex-col items-center justify-center text-theme-text/40 fade-in-up">
              <button
                onClick={createPane}
                className="surface-panel pill-button bg-theme-bg border border-dashed border-theme-border/35 paper-divider-dashed p-6 rounded-xl hover:border-theme-border/65 hover:text-theme-text transition-all flex flex-col items-center"
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
