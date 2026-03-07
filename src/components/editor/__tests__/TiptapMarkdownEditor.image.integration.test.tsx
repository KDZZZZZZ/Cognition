import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TiptapMarkdownEditor } from '../TiptapMarkdownEditor';

vi.mock('../SlashCommands', () => ({
  SlashCommands: { configure: () => ({ name: 'slash' }) },
  slashCommandsSuggestion: {},
}));

vi.mock('@aarkue/tiptap-math-extension', () => ({
  MathExtension: { configure: () => ({ name: 'math-extension' }) },
}));

vi.mock('../extensions/InlineMathEnterFix', () => ({
  InlineMathEnterFix: { name: 'inline-math-enter-fix' },
}));

vi.mock('../extensions/InlineMathMarkdownStorage', () => ({
  InlineMathMarkdownStorage: { name: 'inline-math-markdown-storage' },
}));

vi.mock('../extensions/MathSyntaxBridge', () => ({
  MathSyntaxBridge: { name: 'math-syntax-bridge' },
  createBridgeTransaction: vi.fn(() => null),
}));

describe('TiptapMarkdownEditor image integration', () => {
  it('rehydrates markdown image content into an img node', async () => {
    render(
      <TiptapMarkdownEditor
        content={'# Figure\n\n![Chart p.5](/uploads/chart-crops/f1/page-0005-abc.jpg)'}
        editable={false}
      />
    );

    await waitFor(() => {
      const image = screen.getByRole('img', { name: 'Chart p.5' });
      expect(image).toHaveAttribute('src', '/uploads/chart-crops/f1/page-0005-abc.jpg');
    });
  });
});
