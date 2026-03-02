import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FileIcon } from '../FileIcon';

describe('FileIcon', () => {
  it('renders icon for supported file types', () => {
    const types = ['folder', 'pdf', 'web', 'md', 'session', 'code', 'image'] as const;
    for (const type of types) {
      const { container, unmount } = render(<FileIcon type={type} />);
      expect(container.querySelector('svg')).not.toBeNull();
      unmount();
    }
  });

  it('falls back to generic icon for unknown type', () => {
    const { container } = render(<FileIcon type={'txt' as never} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
