import { describe, expect, it, vi } from 'vitest';

describe('main entry', () => {
  it('mounts App into #root', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const render = vi.fn();
    const createRoot = vi.fn(() => ({ render }));

    vi.doMock('react-dom/client', () => ({ createRoot }));
    vi.doMock('../App.tsx', () => ({ default: () => null }));

    await import('../main');

    expect(createRoot).toHaveBeenCalled();
    expect(render).toHaveBeenCalled();
  });
});
