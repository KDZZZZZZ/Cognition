import { describe, expect, it, vi } from 'vitest';
import { patchMarkdownSerializer } from '../InlineMathMarkdownStorage';

describe('InlineMathMarkdownStorage', () => {
  it('is no-op when markdown serializer is unavailable', () => {
    expect(() => patchMarkdownSerializer({ storage: {} } as any)).not.toThrow();
  });

  it('patches serializer inlineMath writer once', () => {
    const write = vi.fn();
    const serializer: any = { nodes: {} };
    const editor = {
      storage: {
        markdown: {
          serializer,
        },
      },
    } as any;

    patchMarkdownSerializer(editor);
    patchMarkdownSerializer(editor);

    expect(typeof serializer.nodes.inlineMath).toBe('function');

    serializer.nodes.inlineMath(
      { write } as any,
      { attrs: { latex: 'x+y', display: 'no' } } as any
    );
    serializer.nodes.inlineMath(
      { write } as any,
      { attrs: { latex: 'x+y', display: 'yes' } } as any
    );

    expect(write).toHaveBeenNthCalledWith(1, '$x+y$');
    expect(write).toHaveBeenNthCalledWith(2, '$$\nx+y\n$$');
  });
});
