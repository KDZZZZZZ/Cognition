import { describe, expect, it, vi } from 'vitest';
import { InlineMathEnterFix } from '../InlineMathEnterFix';

function createEditorHarness({
  isTextblock = true,
  canSplit = true,
  canHardBreak = true,
}: {
  isTextblock?: boolean;
  canSplit?: boolean;
  canHardBreak?: boolean;
}) {
  const chainRun = vi.fn(() => true);
  const chain = {
    setTextSelection: vi.fn(() => chain),
    splitBlock: vi.fn(() => chain),
    setHardBreak: vi.fn(() => chain),
    run: chainRun,
  };
  const canChain = {
    setTextSelection: vi.fn(() => canChain),
    splitBlock: vi.fn(() => canChain),
    setHardBreak: vi.fn(() => canChain),
    run: vi.fn(() => canSplit),
  };

  const editor = {
    state: {
      selection: {
        $from: { parent: { isTextblock } },
        to: 7,
      },
    },
    chain: vi.fn(() => chain),
    can: vi.fn(() => ({
      chain: () => ({
        ...canChain,
        run: vi.fn(() => canHardBreak),
      }),
    })),
  };

  return { editor, chain, chainRun };
}

describe('InlineMathEnterFix', () => {
  it('returns false when selection is not inside a text block', () => {
    const { editor } = createEditorHarness({ isTextblock: false });
    const shortcuts = (InlineMathEnterFix as any).config.addKeyboardShortcuts.call({ editor });
    expect(shortcuts.Enter()).toBe(false);
    expect(shortcuts['Shift-Enter']()).toBe(false);
  });

  it('splits block on Enter when command is available', () => {
    const { editor, chain } = createEditorHarness({ canSplit: true });
    const shortcuts = (InlineMathEnterFix as any).config.addKeyboardShortcuts.call({ editor });
    expect(shortcuts.Enter()).toBe(true);
    expect(chain.setTextSelection).toHaveBeenCalledWith(7);
    expect(chain.splitBlock).toHaveBeenCalled();
  });

  it('returns false on Enter when splitBlock is unavailable', () => {
    const editor = {
      state: {
        selection: {
          $from: { parent: { isTextblock: true } },
          to: 3,
        },
      },
      chain: vi.fn(() => ({
        setTextSelection: vi.fn().mockReturnThis(),
        splitBlock: vi.fn().mockReturnThis(),
        setHardBreak: vi.fn().mockReturnThis(),
        run: vi.fn(() => true),
      })),
      can: vi.fn(() => ({
        chain: () => ({
          setTextSelection: vi.fn().mockReturnThis(),
          splitBlock: vi.fn().mockReturnThis(),
          setHardBreak: vi.fn().mockReturnThis(),
          run: vi.fn(() => false),
        }),
      })),
    };
    const shortcuts = (InlineMathEnterFix as any).config.addKeyboardShortcuts.call({ editor });
    expect(shortcuts.Enter()).toBe(false);
  });

  it('handles Shift-Enter hard break path and fallback false branch', () => {
    const withHardBreak = {
      state: {
        selection: {
          $from: { parent: { isTextblock: true } },
          to: 8,
        },
      },
      chain: vi.fn(() => ({
        setTextSelection: vi.fn().mockReturnThis(),
        splitBlock: vi.fn().mockReturnThis(),
        setHardBreak: vi.fn().mockReturnThis(),
        run: vi.fn(() => true),
      })),
      can: vi.fn(() => ({
        chain: () => ({
          setTextSelection: vi.fn().mockReturnThis(),
          splitBlock: vi.fn().mockReturnThis(),
          setHardBreak: vi.fn().mockReturnThis(),
          run: vi.fn(() => true),
        }),
      })),
    };
    const shortcutsA = (InlineMathEnterFix as any).config.addKeyboardShortcuts.call({ editor: withHardBreak });
    expect(shortcutsA['Shift-Enter']()).toBe(true);

    const withoutHardBreak = {
      ...withHardBreak,
      can: vi.fn(() => ({
        chain: () => ({
          setTextSelection: vi.fn().mockReturnThis(),
          splitBlock: vi.fn().mockReturnThis(),
          setHardBreak: vi.fn().mockReturnThis(),
          run: vi.fn(() => false),
        }),
      })),
    };
    const shortcutsB = (InlineMathEnterFix as any).config.addKeyboardShortcuts.call({ editor: withoutHardBreak });
    expect(shortcutsB['Shift-Enter']()).toBe(false);
  });
});
