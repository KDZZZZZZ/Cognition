import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import App from '../App';

const loadFiles = vi.fn();
const toggleSidebar = vi.fn();
const createPane = vi.fn();
const openTab = vi.fn();
const setUiActivePane = vi.fn();
const setPaneStoreActivePane = vi.fn();
const setModel = vi.fn();

const uiState = {
  sidebarOpen: true,
  toggleSidebar,
  activePaneId: null as string | null,
  setActivePane: setUiActivePane,
};

let paneState = {
  panes: [] as Array<{ id: string }>,
  activePaneId: null as string | null,
  createPane,
  openTab,
  setActivePane: setPaneStoreActivePane,
};

vi.mock('../stores/uiStore', () => ({
  useUIStore: () => uiState,
}));

vi.mock('../stores/paneStore', () => ({
  usePaneStore: () => paneState,
}));

vi.mock('../stores/apiStore', () => ({
  useFileStore: () => ({ loadFiles }),
}));

vi.mock('../stores/chatStore', () => ({
  useChatStore: (selector: (state: { setModel: typeof setModel }) => unknown) =>
    selector({ setModel }),
}));

vi.mock('../components/layout/Sidebar', () => ({
  Sidebar: () => <div>SidebarMock</div>,
}));

vi.mock('../components/pane/PaneRenderer', () => ({
  PaneRenderer: ({
    pane,
    onActivate,
    onDrop,
  }: {
    pane: { id: string };
    onActivate: () => void;
    onDrop: (e: any) => void;
  }) => (
    <div data-testid={`pane-${pane.id}`} onDrop={onDrop}>
      <button onClick={onActivate}>Pane-{pane.id}</button>
    </div>
  ),
}));

describe('App', () => {
  it('loads files on mount and supports creating panes', () => {
    paneState = { ...paneState, panes: [], activePaneId: null };
    render(<App />);
    expect(loadFiles).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('拆分视图'));
    expect(createPane).toHaveBeenCalled();
  });

  it('renders panes and handles activation', () => {
    paneState = {
      ...paneState,
      panes: [{ id: 'p1' }, { id: 'p2' }],
      activePaneId: 'p1',
    };
    render(<App />);

    expect(screen.getByText('SidebarMock')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-sidebar-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('mobile-sidebar-shell')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Pane-p2'));
    expect(setUiActivePane).toHaveBeenCalledWith('p2');
    expect(setPaneStoreActivePane).toHaveBeenCalledWith('p2');
  });

  it('uses the mobile sidebar shell on narrow viewports', () => {
    vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
      matches: query === '(max-width: 960px)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(<App />);

    expect(screen.getByTestId('mobile-sidebar-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('desktop-sidebar-shell')).not.toBeInTheDocument();
  });

  it('toggles sidebar from toolbar button', () => {
    render(<App />);
    fireEvent.click(screen.getByTitle('侧边栏'));
    expect(toggleSidebar).toHaveBeenCalled();
  });

  it('opens runtime settings and saves model config', () => {
    render(<App />);

    fireEvent.click(screen.getByTitle('接口与模型'));
    expect(screen.getByTestId('runtime-settings-dialog')).toBeInTheDocument();

    const modelInputs = screen.getAllByPlaceholderText(/gpt-4o \/ kimi \/ deepseek-chat|DeepSeek-OCR|text-embedding-3-large/);
    fireEvent.change(modelInputs[0], { target: { value: 'kimi-latest' } });
    fireEvent.click(screen.getByText('保存'));

    expect(setModel).toHaveBeenCalledWith('kimi-latest');
  });

  it('opens dropped file tabs and ignores folder/invalid payloads', () => {
    paneState = {
      ...paneState,
      panes: [{ id: 'p1' }],
      activePaneId: 'p1',
    };
    render(<App />);
    const pane = screen.getByTestId('pane-p1');

    fireEvent.drop(pane, {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: () => JSON.stringify({ id: 'f1', name: 'doc.md', type: 'md' }),
      },
    });
    expect(openTab).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ id: 'f1', name: 'doc.md', type: 'md', mode: 'editor' })
    );

    fireEvent.drop(pane, {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: () => JSON.stringify({ id: 'd1', name: 'folder', type: 'folder' }),
      },
    });
    expect(openTab).toHaveBeenCalledTimes(1);

    fireEvent.drop(pane, {
      preventDefault: vi.fn(),
      dataTransfer: {
        getData: () => '{not-json',
      },
    });
    expect(openTab).toHaveBeenCalledTimes(1);
  });
});
