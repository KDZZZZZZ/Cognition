import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  rendererInstances: [] as any[],
  tippyInstances: [] as any[],
  tippyFactory: vi.fn(),
}));

vi.mock('@tiptap/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tiptap/react')>();
  class MockRenderer {
    element = document.createElement('div');
    ref = { onKeyDown: vi.fn(() => true) };
    updateProps = vi.fn();
    destroy = vi.fn();
    constructor(_component: any, _opts: any) {
      m.rendererInstances.push(this);
    }
  }
  return {
    ...actual,
    ReactRenderer: MockRenderer as any,
  };
});

vi.mock('tippy.js', () => {
  const create = vi.fn((_target: string, _opts: any) => {
    const instance = {
      setProps: vi.fn(),
      hide: vi.fn(),
      destroy: vi.fn(),
    };
    m.tippyInstances.push(instance);
    return [instance];
  });
  m.tippyFactory = create;
  return {
    default: create,
  };
});

import { slashCommandsSuggestion } from '../SlashCommands';

describe('SlashCommands suggestion render', () => {
  it('handles start/update/keydown/exit lifecycle', () => {
    const renderFn = slashCommandsSuggestion.render;
    if (!renderFn) {
      throw new Error('Expected suggestion render hook');
    }
    const renderHooks = renderFn();
    if (!renderHooks.onStart || !renderHooks.onUpdate || !renderHooks.onKeyDown || !renderHooks.onExit) {
      throw new Error('Expected full suggestion lifecycle hooks');
    }
    const baseProps: any = {
      editor: {},
      items: [],
      command: vi.fn(),
      clientRect: () => new DOMRect(0, 0, 100, 20),
    };

    renderHooks.onStart(baseProps);
    expect(m.rendererInstances.length).toBeGreaterThan(0);
    expect(m.tippyFactory).toHaveBeenCalled();

    renderHooks.onUpdate(baseProps);
    expect(m.rendererInstances[0].updateProps).toHaveBeenCalled();
    expect(m.tippyInstances[0].setProps).toHaveBeenCalled();

    expect(
      renderHooks.onKeyDown({
        event: { key: 'Escape' } as KeyboardEvent,
        view: {} as any,
        range: { from: 0, to: 0 } as any,
      } as any)
    ).toBe(true);
    expect(m.tippyInstances[0].hide).toHaveBeenCalled();

    expect(
      renderHooks.onKeyDown({
        event: { key: 'Enter' } as KeyboardEvent,
        view: {} as any,
        range: { from: 0, to: 0 } as any,
      } as any)
    ).toBe(true);
    expect(m.rendererInstances[0].ref.onKeyDown).toHaveBeenCalled();

    renderHooks.onExit(baseProps);
    expect(m.tippyInstances[0].destroy).toHaveBeenCalled();
    expect(m.rendererInstances[0].destroy).toHaveBeenCalled();
  });

  it('gracefully handles missing clientRect and popup on update', () => {
    const renderFn = slashCommandsSuggestion.render;
    if (!renderFn) {
      throw new Error('Expected suggestion render hook');
    }
    const renderHooks = renderFn();
    if (!renderHooks.onStart || !renderHooks.onUpdate || !renderHooks.onKeyDown) {
      throw new Error('Expected lifecycle hooks');
    }
    const noRectProps: any = {
      editor: {},
      items: [],
      command: vi.fn(),
      clientRect: null,
    };

    renderHooks.onStart(noRectProps);
    renderHooks.onUpdate(noRectProps);
    expect(
      renderHooks.onKeyDown({
        event: { key: 'x' } as KeyboardEvent,
        view: {} as any,
        range: { from: 0, to: 0 } as any,
      } as any)
    ).toBe(true);
  });
});
