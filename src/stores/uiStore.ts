import { create } from 'zustand';
import { UIState } from '../types';

export const useUIStore = create<UIState>((set) => ({
  theme: 'light',
  sidebarOpen: true,
  activePaneId: null,
  timelineExpanded: true,
  contextMenu: {
    visible: false,
    x: 0,
    y: 0,
    file: null,
  },

  toggleTheme: () => set(() => {
    document.documentElement.classList.remove('dark');
    return { theme: 'light' };
  }),

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

  setActivePane: (paneId: string | null) => set({ activePaneId: paneId }),

  toggleTimeline: () => set((state) => ({ timelineExpanded: !state.timelineExpanded })),

  showContextMenu: (x: number, y: number, file: any) =>
    set({ contextMenu: { visible: true, x, y, file } }),

  hideContextMenu: () =>
    set((state) => ({ contextMenu: { ...state.contextMenu, visible: false } })),
}));
