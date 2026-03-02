import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu } from '../ContextMenu';

const baseProps = {
  x: 10,
  y: 20,
  onClose: vi.fn(),
  onNewFile: vi.fn(),
  onNewSession: vi.fn(),
  onNewFolder: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onDownload: vi.fn(),
  onCopy: vi.fn(),
  onPaste: vi.fn(),
  onOpenInNewPane: vi.fn(),
  canPaste: true,
};

describe('ContextMenu', () => {
  it('triggers creation actions from root menu', () => {
    render(<ContextMenu {...baseProps} file={null} />);
    fireEvent.click(screen.getByText('New File'));
    fireEvent.click(screen.getByText('New Session'));
    fireEvent.click(screen.getByText('New Folder'));

    expect(baseProps.onNewFile).toHaveBeenCalled();
    expect(baseProps.onNewSession).toHaveBeenCalled();
    expect(baseProps.onNewFolder).toHaveBeenCalled();
  });

  it('shows file operations and handles actions for file nodes', () => {
    const file = { id: 'f1', name: 'doc.md', type: 'md' as const };
    render(<ContextMenu {...baseProps} file={file} />);

    fireEvent.click(screen.getByText('Open in New Pane'));
    fireEvent.click(screen.getByText('Rename'));
    fireEvent.click(screen.getByText('Copy'));
    fireEvent.click(screen.getByText('Download'));
    fireEvent.click(screen.getByText('Delete'));

    expect(baseProps.onOpenInNewPane).toHaveBeenCalledWith(file);
    expect(baseProps.onRename).toHaveBeenCalledWith(file);
    expect(baseProps.onCopy).toHaveBeenCalledWith(file);
    expect(baseProps.onDownload).toHaveBeenCalledWith('f1');
    expect(baseProps.onDelete).toHaveBeenCalledWith('f1');
  });

  it('supports paste disable state and closes on outside click/escape', () => {
    const onClose = vi.fn();
    render(<ContextMenu {...baseProps} onClose={onClose} canPaste={false} file={null} />);

    const pasteButton = screen.getByText('Paste').closest('button')!;
    expect(pasteButton).toBeDisabled();

    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
