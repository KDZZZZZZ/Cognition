export const MOCK_MD_CONTENT = `# Project Notes

## 1. Introduction
This is a **Typora-style** demo.
Click a specific line to edit it. Other lines remain rendered.

## 2. Features
- [x] Block-based Editing
- [x] Rendered Diff
- [ ] Cloud Sync

> "Simplicity is the soul of efficiency."

\`\`\`javascript
console.log("Only the active line shows raw code.");
\`\`\`
`;

export const MOCK_TIMELINE = {
  'd2': [
    {
      id: 'v3',
      date: 'Just now',
      author: 'You' as const,
      message: 'Update project features',
      type: 'current' as const,
    },
    {
      id: 'v2',
      date: '2 hours ago',
      author: 'AI Assistant' as const,
      message: 'Refactor lists',
      type: 'history' as const,
    },
  ],
};

export const MOCK_DIFF_DATA = [
  { line: 1, content: '# Project Notes', type: 'normal' as const },
  { line: 2, content: '', type: 'normal' as const },
  { line: 3, content: '## 1. Introduction', type: 'normal' as const },
  { line: 4, content: 'Old plain text introduction.', type: 'remove' as const },
  { line: 5, content: '**New Typora Style** Introduction.', type: 'add' as const },
  { line: 6, content: '', type: 'normal' as const },
  { line: 7, content: '- [ ] Old Task', type: 'remove' as const },
  { line: 8, content: '- [x] New Task', type: 'add' as const },
];

export const MOCK_FILE_CONTENTS: Record<string, string> = {
  'd2': MOCK_MD_CONTENT,
};
