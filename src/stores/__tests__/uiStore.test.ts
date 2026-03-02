import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from '../uiStore';

describe('useUIStore', () => {
  beforeEach(() => {
    useUIStore.setState({
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
    });
    document.documentElement.classList.add('dark');
  });

  it('toggles and updates UI state fields', () => {
    const state = useUIStore.getState();

    state.toggleTheme();
    expect(useUIStore.getState().theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    state.toggleSidebar();
    expect(useUIStore.getState().sidebarOpen).toBe(false);

    state.setActivePane('pane-1');
    expect(useUIStore.getState().activePaneId).toBe('pane-1');

    state.toggleTimeline();
    expect(useUIStore.getState().timelineExpanded).toBe(false);

    state.showContextMenu(10, 20, { id: 'file-1', name: 'a.md', type: 'md' });
    expect(useUIStore.getState().contextMenu.visible).toBe(true);

    state.hideContextMenu();
    expect(useUIStore.getState().contextMenu.visible).toBe(false);
  });
});
