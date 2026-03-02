import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PermissionToggle } from '../PermissionToggle';

describe('PermissionToggle', () => {
  it('renders status-specific labels and handles click', () => {
    const onClick = vi.fn();
    const { rerender } = render(<PermissionToggle status="read" onClick={onClick} />);
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Read permission');
    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<PermissionToggle status="write" onClick={onClick} />);
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Write permission');

    rerender(<PermissionToggle status="none" onClick={onClick} />);
    expect(screen.getByRole('button')).toHaveAttribute('title', 'Hidden from AI');
  });

  it('disables control while syncing', () => {
    render(<PermissionToggle status="read" onClick={() => {}} syncing />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
