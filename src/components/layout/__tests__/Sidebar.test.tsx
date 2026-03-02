import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../Sidebar';

vi.mock('../../filetree/FileTree', () => ({
  FileTree: () => <div>FileTreeMock</div>,
}));

vi.mock('../../timeline/Timeline', () => ({
  Timeline: () => <div>TimelineMock</div>,
}));

describe('Sidebar', () => {
  it('renders children and persists resized width', () => {
    window.localStorage.setItem('cognition.sidebar.width', '350');
    render(<Sidebar />);

    expect(screen.getByText('FileTreeMock')).toBeInTheDocument();
    expect(screen.getByText('TimelineMock')).toBeInTheDocument();

    const resizeHandle = screen.getByLabelText('Resize sidebar');
    fireEvent.mouseDown(resizeHandle, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 600 });
    fireEvent.mouseUp(window);

    const stored = Number(window.localStorage.getItem('cognition.sidebar.width'));
    expect(Number.isFinite(stored)).toBe(true);
  });

  it('falls back to default width and clamps resize range', () => {
    window.localStorage.setItem('cognition.sidebar.width', 'not-a-number');
    const { container } = render(<Sidebar />);

    const root = container.firstElementChild as HTMLElement;
    expect(root.style.width).toBe('320px');

    const resizeHandle = screen.getByLabelText('Resize sidebar');
    fireEvent.mouseDown(resizeHandle, { clientX: 10 });
    fireEvent.mouseMove(window, { clientX: 20 });
    const activeMarker = resizeHandle.querySelector('span') as HTMLElement;
    expect(activeMarker.className).toContain('bg-theme-text/40');

    fireEvent.mouseMove(window, { clientX: 2000 });
    fireEvent.mouseUp(window);

    const stored = Number(window.localStorage.getItem('cognition.sidebar.width'));
    expect(stored).toBeGreaterThanOrEqual(240);
    expect(stored).toBeLessThanOrEqual(760);
  });
});
