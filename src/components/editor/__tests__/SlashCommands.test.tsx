import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandList, commands, slashCommandsSuggestion } from '../SlashCommands';

describe('SlashCommands', () => {
  it('filters items by query', async () => {
    const itemsRaw = slashCommandsSuggestion.items?.({ query: 'heading', editor: {} as any } as any) || [];
    const items = await Promise.resolve(itemsRaw);
    expect(items.some((item: any) => item.title === 'Heading 1')).toBe(true);

    const chineseItemsRaw = slashCommandsSuggestion.items?.({ query: '引用', editor: {} as any } as any) || [];
    const chineseItems = await Promise.resolve(chineseItemsRaw);
    expect(chineseItems.some((item: any) => item.title === 'Quote')).toBe(true);
  });

  it('renders command list and supports keyboard navigation', () => {
    const onCommand = vi.fn();
    const ref = createRef<{ onKeyDown: (props: { event: KeyboardEvent }) => boolean }>();

    render(<CommandList ref={ref} items={commands.slice(0, 3)} command={onCommand} />);

    fireEvent.mouseEnter(screen.getByText('Heading 2'));
    fireEvent.click(screen.getByText('Heading 2'));
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ title: 'Heading 2' }));

    expect(ref.current?.onKeyDown({ event: { key: 'ArrowDown' } as KeyboardEvent })).toBe(true);
    expect(ref.current?.onKeyDown({ event: { key: 'ArrowUp' } as KeyboardEvent })).toBe(true);
    expect(ref.current?.onKeyDown({ event: { key: 'Enter' } as KeyboardEvent })).toBe(true);
    expect(ref.current?.onKeyDown({ event: { key: 'x' } as KeyboardEvent })).toBe(false);
  });

  it('shows empty state when no command matches', () => {
    render(<CommandList items={[]} command={vi.fn()} />);
    expect(screen.getByText('No commands found')).toBeInTheDocument();
  });

  it('executes every command against editor chain', () => {
    const run = vi.fn();
    const chain = {
      focus: vi.fn(() => chain),
      deleteRange: vi.fn(() => chain),
      setNode: vi.fn(() => chain),
      toggleBulletList: vi.fn(() => chain),
      toggleOrderedList: vi.fn(() => chain),
      toggleBlockquote: vi.fn(() => chain),
      toggleCodeBlock: vi.fn(() => chain),
      setHorizontalRule: vi.fn(() => chain),
      run,
    };
    const editor = { chain: () => chain } as any;

    for (const item of commands) {
      item.command({ editor, range: { from: 1, to: 2 } });
    }

    expect(chain.deleteRange).toHaveBeenCalled();
    expect(chain.focus).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
  });
});
