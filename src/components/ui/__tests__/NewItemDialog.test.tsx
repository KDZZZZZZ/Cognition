import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewItemDialog } from '../NewItemDialog';

describe('NewItemDialog', () => {
  it('does not render when closed', () => {
    const { container } = render(
      <NewItemDialog isOpen={false} onClose={() => {}} onCreate={() => {}} title="New" placeholder="name" />
    );
    expect(container.firstChild).toBeNull();
  });

  it('submits trimmed name and closes dialog', () => {
    const onClose = vi.fn();
    const onCreate = vi.fn();
    render(
      <NewItemDialog
        isOpen
        onClose={onClose}
        onCreate={onCreate}
        title="New File"
        placeholder="name"
        defaultValue="  test.md  "
      />
    );

    fireEvent.submit(screen.getByRole('button', { name: 'Create' }).closest('form')!);
    expect(onCreate).toHaveBeenCalledWith('test.md');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on escape key', () => {
    const onClose = vi.fn();
    render(
      <NewItemDialog
        isOpen
        onClose={onClose}
        onCreate={() => {}}
        title="New File"
        placeholder="name"
      />
    );

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
