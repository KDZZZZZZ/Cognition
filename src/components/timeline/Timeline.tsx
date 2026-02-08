import { useEffect, useState } from 'react';
import { ChevronRight, ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { usePaneStore } from '../../stores/paneStore';
import { useUIStore } from '../../stores/uiStore';
import { useFileTreeStore } from '../../stores/fileTreeStore';
import { useFileStore } from '../../stores/apiStore';
import { useDiffStore } from '../../stores/diffStore';
import { api, FileVersion } from '../../api/client';

interface TimelineItem {
  id: string;
  date: string;
  author: string;
  message: string;
  changeType: string;
}

export function Timeline() {
  const { timelineExpanded, toggleTimeline } = useUIStore();
  const { panes, activePaneId, setTabMode } = usePaneStore();
  const { findFile } = useFileTreeStore();
  const { lastUpdated } = useFileStore();
  const { setActiveDiff } = useDiffStore();

  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeFileId =
    panes.find((p) => p.id === activePaneId)?.activeTabId || null;

  // Fetch timeline data when active file changes or when lastUpdated changes
  useEffect(() => {
    if (!activeFileId || !timelineExpanded) {
      setTimeline([]);
      return;
    }

    // Only fetch for backend files (no underscore in ID)
    if (activeFileId.includes('_')) {
      setTimeline([]);
      return;
    }

    const fetchVersions = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await api.getFileVersions(activeFileId);
        if (response.success && response.data) {
          const versions = response.data.versions || [];
          // Transform backend versions to timeline items
          const items: TimelineItem[] = versions.map((v: FileVersion) => ({
            id: v.id,
            date: new Date(v.timestamp).toLocaleString(),
            author: v.author === 'human' ? 'You' : 'AI',
            message: v.summary,
            changeType: v.change_type,
          }));
          setTimeline(items);
        } else {
          setError(response.error || 'Failed to load versions');
        }
      } catch (err) {
        setError('Network error loading timeline');
        console.error('Failed to fetch versions:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchVersions();
  }, [activeFileId, timelineExpanded, lastUpdated]);

  const handleTimelineClick = async (item: TimelineItem) => {
    if (!activeFileId) return;

    const file = findFile(activeFileId);
    if (!file) return;

    try {
      // Get the current file content
      const contentResponse = await api.getFileContent(activeFileId);
      if (!contentResponse.success || !contentResponse.data) {
        console.error('Failed to get file content');
        return;
      }

      const currentContent = contentResponse.data.content;

      // Get the version details to get the old content
      const versionsResponse = await api.getFileVersions(activeFileId);
      if (!versionsResponse.success || !versionsResponse.data) {
        console.error('Failed to get versions');
        return;
      }

      const versions = versionsResponse.data.versions || [];
      const targetVersion = versions.find((v: FileVersion) => v.id === item.id);

      if (!targetVersion) {
        console.error('Version not found');
        return;
      }

      // Use the version's context_snapshot as old content
      // If not available, use empty string
      const oldContent = targetVersion.context_snapshot || '';
      const newContent = currentContent;

      // Set up the diff comparison
      setActiveDiff({
        fileId: activeFileId,
        versionId: item.id,
        oldContent,
        newContent,
        versionLabel: `${item.message}`,
      });

      // Switch the tab to diff mode
      setTabMode(activePaneId || '', activeFileId, 'diff');

    } catch (err) {
      console.error('Failed to open diff view:', err);
    }
  };

  const getChangeTypeColor = (changeType: string) => {
    switch (changeType) {
      case 'edit':
        return 'bg-blue-400';
      case 'refactor':
        return 'bg-purple-400';
      case 'create':
        return 'bg-green-400';
      case 'delete':
        return 'bg-red-400';
      default:
        return 'bg-gray-400';
    }
  };

  return (
    <div
      className="border-t border-theme-border/20 bg-theme-bg/50 flex flex-col transition-colors duration-300"
      style={{ height: timelineExpanded ? '35%' : 'auto' }}
    >
      <div
        className="p-2 bg-theme-bg/30 border-b border-theme-border/20 flex items-center justify-between cursor-pointer"
        onClick={toggleTimeline}
      >
        <div className="flex items-center gap-1 text-xs font-bold text-theme-text/60 uppercase">
          {timelineExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Timeline
        </div>
        <div className="flex items-center gap-2">
          {loading && timelineExpanded && (
            <Loader2 size={12} className="animate-spin text-theme-text/50" />
          )}
          {timelineExpanded && activeFileId && !activeFileId.includes('_') && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                // Force refresh by triggering a new fetch
                setLoading(true);
                api.getFileVersions(activeFileId).then((response) => {
                  if (response.success && response.data) {
                    const versions = response.data.versions || [];
                    const items: TimelineItem[] = versions.map((v: FileVersion) => ({
                      id: v.id,
                      date: new Date(v.timestamp).toLocaleString(),
                      author: v.author === 'human' ? 'You' : 'AI',
                      message: v.summary,
                      changeType: v.change_type,
                    }));
                    setTimeline(items);
                  }
                  setLoading(false);
                });
              }}
              className="p-1 hover:bg-theme-text/10 rounded transition-colors"
              title="Refresh timeline"
            >
              <RefreshCw size={12} className="text-theme-text/50" />
            </button>
          )}
        </div>
      </div>

      {timelineExpanded && (
        <div className="flex-1 overflow-y-auto p-4">
          {!activeFileId ? (
            <div className="text-xs text-theme-text/40 text-center mt-2">
              No file active
            </div>
          ) : activeFileId.includes('_') ? (
            <div className="text-xs text-theme-text/40 text-center mt-2">
              Local sessions don't have version history
            </div>
          ) : loading ? (
            <div className="flex items-center justify-center mt-4">
              <Loader2 size={16} className="animate-spin text-theme-text/40" />
              <span className="ml-2 text-xs text-theme-text/40">Loading...</span>
            </div>
          ) : error ? (
            <div className="text-xs text-red-400 text-center mt-2">{error}</div>
          ) : timeline.length === 0 ? (
            <div className="text-xs text-theme-text/40 text-center mt-2">
              No versions yet. Edit the file to create a version.
            </div>
          ) : (
            timeline.map((item) => (
              <div
                key={item.id}
                onClick={() => handleTimelineClick(item)}
                className="mb-4 relative pl-3 border-l border-theme-border/20 cursor-pointer group hover:bg-theme-text/5 rounded p-1 -ml-1 transition-colors"
              >
                <div
                  className={`absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full border-2 border-theme-bg group-hover:scale-110 transition-transform ${getChangeTypeColor(
                    item.changeType
                  )}`}
                />
                <div className="text-xs font-medium text-theme-text/80 group-hover:text-theme-text">
                  {item.message}
                </div>
                <div className="text-[10px] text-theme-text/40 mt-0.5">
                  {item.date} • {item.author}
                </div>
                <div className="text-[10px] text-theme-text/30 mt-0.5 capitalize">
                  {item.changeType}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
