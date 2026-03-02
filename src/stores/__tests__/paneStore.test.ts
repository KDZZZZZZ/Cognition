import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaneStore } from '../paneStore';
import type { Tab } from '../../types';

const defaultPaneState = {
  panes: [{ id: 'default', tabs: [], activeTabId: null }],
  activePaneId: 'default',
};

function resetPaneState() {
  usePaneStore.setState(defaultPaneState);
}

function tab(id: string, mode: 'editor' | 'preview' = 'editor'): Tab {
  return { id, name: id, type: 'md', mode };
}

describe('usePaneStore', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    resetPaneState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates panes and closes the active pane safely', () => {
    const state = usePaneStore.getState();
    state.createPane();
    expect(usePaneStore.getState().panes).toHaveLength(2);
    expect(usePaneStore.getState().activePaneId).toBe('1700000000000');

    state.closePane('1700000000000');
    expect(usePaneStore.getState().panes).toHaveLength(1);
    expect(usePaneStore.getState().activePaneId).toBe('default');
  });

  it('adds, closes and activates tabs', () => {
    const state = usePaneStore.getState();
    state.openTab('default', tab('a'));
    state.openTab('default', tab('b'));
    expect(usePaneStore.getState().panes[0].tabs.map((t) => t.id)).toEqual(['a', 'b']);

    state.openTab('default', tab('a', 'preview'));
    expect(usePaneStore.getState().panes[0].tabs.find((t) => t.id === 'a')?.mode).toBe('preview');
    expect(usePaneStore.getState().panes[0].activeTabId).toBe('a');

    state.setActiveTab('default', 'b');
    expect(usePaneStore.getState().panes[0].activeTabId).toBe('b');

    state.closeTab('default', 'b');
    expect(usePaneStore.getState().panes[0].tabs.map((t) => t.id)).toEqual(['a']);
    expect(usePaneStore.getState().panes[0].activeTabId).toBe('a');
  });

  it('moves and reorders tabs across panes', () => {
    const state = usePaneStore.getState();
    const p2 = state.addPane();

    state.openTab('default', tab('x'));
    state.openTab('default', tab('y'));
    state.reorderTabs('default', 0, 1);
    expect(usePaneStore.getState().panes.find((p) => p.id === 'default')?.tabs.map((t) => t.id)).toEqual(['y', 'x']);

    state.moveTabToPane('default', p2, 'x', 0);
    const source = usePaneStore.getState().panes.find((p) => p.id === 'default');
    const target = usePaneStore.getState().panes.find((p) => p.id === p2);
    expect(source?.tabs.map((t) => t.id)).toEqual(['y']);
    expect(target?.tabs.map((t) => t.id)).toEqual(['x']);
    expect(target?.activeTabId).toBe('x');

    expect(usePaneStore.getState().getAllOpenTabs().map((t) => t.id).sort()).toEqual(['x', 'y']);
    expect(usePaneStore.getState().getActiveTab(p2)?.id).toBe('x');
  });

  it('closes one tab in all panes', () => {
    const state = usePaneStore.getState();
    const p2 = state.addPane();
    state.openTab('default', tab('shared'));
    state.openTab(p2, tab('shared'));
    state.openTab(p2, tab('another'));

    state.closeTabInAllPanes('shared');
    expect(usePaneStore.getState().panes.find((p) => p.id === 'default')?.tabs).toHaveLength(0);
    expect(usePaneStore.getState().panes.find((p) => p.id === p2)?.tabs.map((t) => t.id)).toEqual(['another']);
  });

  it('handles close/set branches for non-active panes and tabs', () => {
    const state = usePaneStore.getState();
    const p2 = state.addPane();
    state.openTab('default', tab('keep'));
    state.openTab(p2, tab('t2'));

    usePaneStore.setState({
      panes: usePaneStore.getState().panes,
      activePaneId: 'default',
    });
    state.closePane(p2);
    expect(usePaneStore.getState().activePaneId).toBe('default');

    state.closeTab('default', 'missing');
    expect(usePaneStore.getState().panes.find((p) => p.id === 'default')?.activeTabId).toBe('keep');

    state.setActiveTab('missing-pane', 'x');
    expect(usePaneStore.getState().panes.find((p) => p.id === 'default')?.activeTabId).toBe('keep');
  });

  it('guards moveTabToPane and returns null active tab when unmatched', () => {
    const state = usePaneStore.getState();
    const p2 = state.addPane();
    state.openTab('default', tab('shared'));
    state.openTab(p2, tab('shared'));

    const before = usePaneStore.getState().panes.map((p) => ({ id: p.id, count: p.tabs.length }));
    state.moveTabToPane('missing', p2, 'shared');
    state.moveTabToPane('default', p2, 'missing');
    expect(usePaneStore.getState().panes.map((p) => ({ id: p.id, count: p.tabs.length }))).toEqual(before);

    state.moveTabToPane('default', p2, 'shared', 0);
    const targetTabs = usePaneStore.getState().panes.find((p) => p.id === p2)?.tabs.map((t) => t.id);
    expect(targetTabs).toEqual(['shared']);

    usePaneStore.setState({
      panes: [{ id: 'default', tabs: [{ ...tab('a'), id: 'a' }], activeTabId: 'missing-tab' }],
      activePaneId: 'default',
    });
    expect(usePaneStore.getState().getActiveTab('default')).toBeNull();
    expect(usePaneStore.getState().getActiveTab('not-exist')).toBeNull();
  });

  it('uses persist partialize fallbacks', () => {
    const options = (usePaneStore as any).persist.getOptions();
    const partialized = options.partialize({
      panes: [],
      activePaneId: null,
    });
    expect(partialized.panes).toEqual([{ id: 'default', tabs: [], activeTabId: null }]);
    expect(partialized.activePaneId).toBe('default');
  });
});
