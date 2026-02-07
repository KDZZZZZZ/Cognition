import { create } from 'zustand';
import { Pane, Tab, ViewMode } from '../types';

interface PaneState {
  panes: Pane[];
  activePaneId: string | null;

  createPane: () => void;
  addPane: () => string;
  closePane: (paneId: string) => void;
  setActivePane: (paneId: string) => void;

  openTab: (paneId: string, tab: Tab) => void;
  closeTab: (paneId: string, tabId: string) => void;
  closeTabInAllPanes: (tabId: string) => void;
  setActiveTab: (paneId: string, tabId: string) => void;
  setTabMode: (paneId: string, tabId: string, mode: ViewMode) => void;

  reorderTabs: (paneId: string, fromIndex: number, toIndex: number) => void;
  moveTabToPane: (sourcePaneId: string, targetPaneId: string, tabId: string, targetIndex?: number) => void;

  getActiveTab: (paneId: string) => Tab | null;
  getAllOpenTabs: () => Tab[];
}

export const usePaneStore = create<PaneState>((set, get) => ({
  panes: [{ id: 'default', tabs: [], activeTabId: null }],
  activePaneId: 'default',

  createPane: () => {
    const newPaneId = Date.now().toString();
    set((state) => ({
      panes: [...state.panes, { id: newPaneId, tabs: [], activeTabId: null }],
      activePaneId: newPaneId,
    }));
  },

  addPane: () => {
    const newPaneId = Date.now().toString();
    set((state) => ({
      panes: [...state.panes, { id: newPaneId, tabs: [], activeTabId: null }],
      activePaneId: newPaneId,
    }));
    return newPaneId;
  },

  closePane: (paneId: string) => {
    set((state) => {
      if (state.panes.length === 1) {
        return {
          panes: [{ id: state.panes[0].id, tabs: [], activeTabId: null }],
          activePaneId: state.panes[0].id,
        };
      }

      const newPanes = state.panes.filter((p) => p.id !== paneId);
      const newActiveId =
        state.activePaneId === paneId && newPanes.length > 0
          ? newPanes[newPanes.length - 1].id
          : state.activePaneId;

      return { panes: newPanes, activePaneId: newActiveId };
    });
  },

  setActivePane: (paneId: string) => set({ activePaneId: paneId }),

  openTab: (paneId: string, tab: Tab) => {
    set((state) => ({
      panes: state.panes.map((pane) => {
        if (pane.id !== paneId) return pane;

        const existingTab = pane.tabs.find((t) => t.id === tab.id);
        if (existingTab) {
          return {
            ...pane,
            activeTabId: tab.id,
            tabs: pane.tabs.map((t) =>
              t.id === tab.id ? { ...t, mode: tab.mode } : t
            ),
          };
        }

        return {
          ...pane,
          tabs: [...pane.tabs, tab],
          activeTabId: tab.id,
        };
      }),
    }));
  },

  closeTab: (paneId: string, tabId: string) => {
    set((state) => ({
      panes: state.panes.map((pane) => {
        if (pane.id !== paneId) return pane;

        const newTabs = pane.tabs.filter((t) => t.id !== tabId);
        const newActiveId =
          pane.activeTabId === tabId
            ? newTabs.length > 0
              ? newTabs[newTabs.length - 1].id
              : null
            : pane.activeTabId;

        return { ...pane, tabs: newTabs, activeTabId: newActiveId };
      }),
    }));
  },

  closeTabInAllPanes: (tabId: string) => {
    set((state) => ({
      panes: state.panes.map((pane) => {
        const newTabs = pane.tabs.filter((t) => t.id !== tabId);
        const newActiveId =
          pane.activeTabId === tabId
            ? newTabs.length > 0
              ? newTabs[newTabs.length - 1].id
              : null
            : pane.activeTabId;

        return { ...pane, tabs: newTabs, activeTabId: newActiveId };
      }),
    }));
  },

  setActiveTab: (paneId: string, tabId: string) => {
    set((state) => ({
      panes: state.panes.map((pane) =>
        pane.id === paneId ? { ...pane, activeTabId: tabId } : pane
      ),
    }));
  },

  setTabMode: (paneId: string, tabId: string, mode: ViewMode) => {
    set((state) => ({
      panes: state.panes.map((pane) => {
        if (pane.id !== paneId) return pane;

        return {
          ...pane,
          tabs: pane.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, mode } : tab
          ),
        };
      }),
    }));
  },

  reorderTabs: (paneId: string, fromIndex: number, toIndex: number) => {
    set((state) => ({
      panes: state.panes.map((pane) => {
        if (pane.id !== paneId) return pane;

        const newTabs = [...pane.tabs];
        const [movedTab] = newTabs.splice(fromIndex, 1);
        newTabs.splice(toIndex, 0, movedTab);

        return { ...pane, tabs: newTabs };
      }),
    }));
  },

  moveTabToPane: (sourcePaneId: string, targetPaneId: string, tabId: string, targetIndex?: number) => {
    set((state) => {
      const sourcePane = state.panes.find((p) => p.id === sourcePaneId);
      if (!sourcePane) return state;

      const tabToMove = sourcePane.tabs.find((t) => t.id === tabId);
      if (!tabToMove) return state;

      return {
        panes: state.panes.map((pane) => {
          if (pane.id === sourcePaneId) {
            const newTabs = pane.tabs.filter((t) => t.id !== tabId);
            const newActiveId =
              pane.activeTabId === tabId
                ? newTabs.length > 0
                  ? newTabs[newTabs.length - 1].id
                  : null
                : pane.activeTabId;
            return { ...pane, tabs: newTabs, activeTabId: newActiveId };
          }

          if (pane.id === targetPaneId) {
            const existingTab = pane.tabs.find((t) => t.id === tabId);
            if (existingTab) return pane;

            let newTabs = [...pane.tabs, tabToMove];
            if (targetIndex !== undefined && targetIndex < newTabs.length - 1) {
              newTabs.splice(newTabs.length - 1, 1);
              newTabs.splice(targetIndex, 0, tabToMove);
            }

            return { ...pane, tabs: newTabs, activeTabId: tabId };
          }

          return pane;
        }),
      };
    });
  },

  getActiveTab: (paneId: string) => {
    const pane = get().panes.find((p) => p.id === paneId);
    if (!pane) return null;
    return pane.tabs.find((t) => t.id === pane.activeTabId) || null;
  },

  getAllOpenTabs: () => {
    const tabMap = new Map<string, Tab>();
    get().panes.forEach((pane) =>
      pane.tabs.forEach((tab) => tabMap.set(tab.id, tab))
    );
    return Array.from(tabMap.values());
  },
}));
