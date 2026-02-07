import { useState, useRef, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';

interface TyporaBlockEditorProps {
  content: string;
  onChange: (value: string) => void;
}

interface Block {
  id: string;
  content: string;
  type: 'paragraph' | 'heading' | 'code' | 'list' | 'blockquote' | 'hr' | 'table';
}

// Parse markdown content into blocks
function parseBlocks(content: string): Block[] {
  if (!content.trim()) {
    return [{ id: '0', content: '', type: 'paragraph' }];
  }

  const blocks: Block[] = [];
  const lines = content.split('\n');
  let currentBlock: string[] = [];
  let blockId = 0;
  let inCodeBlock = false;
  let inTable = false;

  const flushBlock = () => {
    if (currentBlock.length > 0) {
      const blockContent = currentBlock.join('\n');
      const firstLine = currentBlock[0].trim();

      let type: Block['type'] = 'paragraph';

      if (firstLine.startsWith('```')) {
        type = 'code';
      } else if (firstLine.startsWith('#')) {
        type = 'heading';
      } else if (firstLine.startsWith('>')) {
        type = 'blockquote';
      } else if (firstLine.match(/^[-*+]\s/) || firstLine.match(/^\d+\.\s/)) {
        type = 'list';
      } else if (firstLine.startsWith('---') || firstLine.startsWith('***')) {
        type = 'hr';
      } else if (firstLine.includes('|') && currentBlock.length > 1) {
        type = 'table';
      }

      blocks.push({
        id: String(blockId++),
        content: blockContent,
        type,
      });
      currentBlock = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Handle code blocks
    if (trimmedLine.startsWith('```')) {
      if (!inCodeBlock) {
        flushBlock();
        inCodeBlock = true;
        currentBlock.push(line);
      } else {
        currentBlock.push(line);
        flushBlock();
        inCodeBlock = false;
      }
      continue;
    }

    if (inCodeBlock) {
      currentBlock.push(line);
      continue;
    }

    // Handle tables
    if (trimmedLine.includes('|') && !inTable) {
      flushBlock();
      inTable = true;
      currentBlock.push(line);
      continue;
    }

    if (inTable) {
      if (trimmedLine.includes('|')) {
        currentBlock.push(line);
        continue;
      } else {
        flushBlock();
        inTable = false;
      }
    }

    // Handle headings
    if (trimmedLine.startsWith('#')) {
      flushBlock();
      currentBlock.push(line);
      flushBlock();
      continue;
    }

    // Handle horizontal rules
    if (trimmedLine.match(/^[-*_]{3,}$/)) {
      flushBlock();
      currentBlock.push(line);
      flushBlock();
      continue;
    }

    // Handle blockquotes
    if (trimmedLine.startsWith('>')) {
      if (currentBlock.length > 0 && !currentBlock[0].trim().startsWith('>')) {
        flushBlock();
      }
      currentBlock.push(line);
      continue;
    }

    // Handle lists
    if (trimmedLine.match(/^[-*+]\s/) || trimmedLine.match(/^\d+\.\s/)) {
      if (currentBlock.length > 0 &&
          !currentBlock[0].trim().match(/^[-*+]\s/) &&
          !currentBlock[0].trim().match(/^\d+\.\s/)) {
        flushBlock();
      }
      currentBlock.push(line);
      continue;
    }

    // Handle empty lines as block separators
    if (trimmedLine === '') {
      if (currentBlock.length > 0) {
        flushBlock();
      }
      continue;
    }

    // Regular paragraph content
    currentBlock.push(line);
  }

  flushBlock();

  // Ensure at least one block exists
  if (blocks.length === 0) {
    blocks.push({ id: '0', content: '', type: 'paragraph' });
  }

  return blocks;
}

// Serialize blocks back to markdown string
function serializeBlocks(blocks: Block[]): string {
  return blocks.map(b => b.content).join('\n\n');
}

// Individual block component
function BlockRenderer({
  block,
  isActive,
  onActivate,
  onChange,
  onKeyDown,
  textareaRef,
}: {
  block: Block;
  isActive: boolean;
  onActivate: () => void;
  onChange: (content: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
}) {
  // Auto-resize textarea
  useEffect(() => {
    if (isActive && textareaRef.current) {
      const textarea = textareaRef.current;
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.max(textarea.scrollHeight, 32)}px`;
    }
  }, [isActive, block.content, textareaRef]);

  if (isActive) {
    return (
      <div className="relative group">
        <textarea
          ref={textareaRef}
          value={block.content}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-full p-2 font-mono text-sm bg-gray-50 border border-blue-300 rounded-md resize-none outline-none focus:ring-2 focus:ring-blue-200 min-h-[32px]"
          placeholder="Type markdown here..."
          autoFocus
          spellCheck={false}
        />
        <div className="absolute -left-6 top-2 text-xs text-gray-400 opacity-0 group-hover:opacity-100">
          {block.type}
        </div>
      </div>
    );
  }

  // Render as formatted markdown
  if (!block.content.trim()) {
    return (
      <div
        onClick={onActivate}
        className="min-h-[24px] py-1 px-2 text-gray-400 italic cursor-text hover:bg-gray-50 rounded transition-colors"
      >
        Click to edit...
      </div>
    );
  }

  return (
    <div
      onClick={onActivate}
      className="cursor-text hover:bg-gray-50 rounded transition-colors py-1 px-2 -mx-2"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        components={{
          // Code blocks with syntax highlighting
          code: ({ node, inline, className, children, ...props }: any) => {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';

            if (!inline && language) {
              return (
                <div className="relative group my-2">
                  <div className="absolute top-2 right-2 text-xs text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity bg-white px-2 py-1 rounded shadow-sm">
                    {language}
                  </div>
                  <pre className="!mt-0 !mb-0 rounded-lg overflow-x-auto">
                    <code className={className} {...props}>
                      {children}
                    </code>
                  </pre>
                </div>
              );
            }

            // Inline code
            return (
              <code
                className="px-1.5 py-0.5 bg-gray-100 text-red-600 rounded text-sm font-mono"
                {...props}
              >
                {children}
              </code>
            );
          },

          // Headings
          h1: ({ children }) => (
            <h1 className="text-3xl font-bold text-gray-900 pb-2 border-b border-gray-200">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-2xl font-semibold text-gray-800 pb-1 border-b border-gray-100">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-xl font-semibold text-gray-800">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-lg font-semibold text-gray-700">
              {children}
            </h4>
          ),

          // Paragraphs
          p: ({ children }) => (
            <p className="leading-relaxed text-gray-700">
              {children}
            </p>
          ),

          // Blockquotes
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-blue-400 pl-4 py-2 bg-blue-50/50 italic text-gray-600 rounded-r">
              {children}
            </blockquote>
          ),

          // Lists
          ul: ({ children }) => (
            <ul className="ml-6 list-disc space-y-1 text-gray-700">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="ml-6 list-decimal space-y-1 text-gray-700">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed">{children}</li>
          ),

          // Task lists
          input: ({ checked, type, ...props }: any) => {
            if (type === 'checkbox') {
              return (
                <input
                  type="checkbox"
                  checked={checked}
                  readOnly
                  className="mr-2 rounded border-gray-300"
                  {...props}
                />
              );
            }
            return <input {...props} />;
          },

          // Tables
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 border border-gray-300">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-gray-50">{children}</thead>
          ),
          tbody: ({ children }) => (
            <tbody className="bg-white divide-y divide-gray-200">
              {children}
            </tbody>
          ),
          tr: ({ children }) => (
            <tr className="hover:bg-gray-50">{children}</tr>
          ),
          th: ({ children }) => (
            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-4 py-2 text-sm text-gray-700 whitespace-nowrap">
              {children}
            </td>
          ),

          // Horizontal rule
          hr: () => (
            <hr className="border-t-2 border-gray-200" />
          ),

          // Links
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-blue-600 hover:text-blue-800 underline"
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {children}
            </a>
          ),

          // Images
          img: ({ src, alt }) => (
            <img
              src={src}
              alt={alt || ''}
              className="max-w-full h-auto rounded-lg shadow-sm"
              loading="lazy"
            />
          ),

          // Strong (bold)
          strong: ({ children }) => (
            <strong className="font-semibold text-gray-900">{children}</strong>
          ),

          // Emphasis (italic)
          em: ({ children }) => (
            <em className="italic text-gray-700">{children}</em>
          ),
        }}
      >
        {block.content}
      </ReactMarkdown>
    </div>
  );
}

export function TyporaBlockEditor({ content, onChange }: TyporaBlockEditorProps) {
  const [blocks, setBlocks] = useState<Block[]>(() => parseBlocks(content));
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Update blocks when content prop changes
  useEffect(() => {
    setBlocks(parseBlocks(content));
  }, [content]);

  // Handle block content change
  const handleBlockChange = useCallback((blockId: string, newContent: string) => {
    setBlocks(prevBlocks => {
      const newBlocks = prevBlocks.map(b =>
        b.id === blockId ? { ...b, content: newContent } : b
      );
      // Immediately propagate changes to parent
      onChange(serializeBlocks(newBlocks));
      return newBlocks;
    });
  }, [onChange]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent, blockId: string) => {
    const blockIndex = blocks.findIndex(b => b.id === blockId);

    // Escape to deactivate
    if (e.key === 'Escape') {
      e.preventDefault();
      setActiveBlockId(null);
      return;
    }

    // Tab for indentation
    if (e.key === 'Tab') {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (textarea) {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const currentContent = blocks[blockIndex].content;
        const newContent = currentContent.substring(0, start) + '  ' + currentContent.substring(end);
        handleBlockChange(blockId, newContent);
        setTimeout(() => {
          textarea.selectionStart = textarea.selectionEnd = start + 2;
        }, 0);
      }
      return;
    }

    // Enter at the end of a block creates a new block
    if (e.key === 'Enter' && !e.shiftKey) {
      const textarea = textareaRef.current;
      if (textarea) {
        const cursorPos = textarea.selectionStart;
        const currentContent = blocks[blockIndex].content;

        // If cursor is at the end, create a new block
        if (cursorPos === currentContent.length) {
          e.preventDefault();
          const newBlockId = String(Date.now());
          const newBlocks = [...blocks];
          newBlocks.splice(blockIndex + 1, 0, {
            id: newBlockId,
            content: '',
            type: 'paragraph',
          });
          setBlocks(newBlocks);
          onChange(serializeBlocks(newBlocks));
          setTimeout(() => setActiveBlockId(newBlockId), 0);
          return;
        }
      }
    }

    // Backspace at the start of an empty block deletes it
    if (e.key === 'Backspace') {
      const textarea = textareaRef.current;
      if (textarea && textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
        const currentContent = blocks[blockIndex].content;
        if (currentContent === '' && blocks.length > 1) {
          e.preventDefault();
          const newBlocks = blocks.filter(b => b.id !== blockId);
          setBlocks(newBlocks);
          onChange(serializeBlocks(newBlocks));
          // Focus previous block
          if (blockIndex > 0) {
            setActiveBlockId(newBlocks[blockIndex - 1].id);
          }
          return;
        }
      }
    }

    // Arrow up at the start goes to previous block
    if (e.key === 'ArrowUp') {
      const textarea = textareaRef.current;
      if (textarea && textarea.selectionStart === 0 && blockIndex > 0) {
        e.preventDefault();
        setActiveBlockId(blocks[blockIndex - 1].id);
      }
    }

    // Arrow down at the end goes to next block
    if (e.key === 'ArrowDown') {
      const textarea = textareaRef.current;
      const currentContent = blocks[blockIndex].content;
      if (textarea && textarea.selectionStart === currentContent.length && blockIndex < blocks.length - 1) {
        e.preventDefault();
        setActiveBlockId(blocks[blockIndex + 1].id);
      }
    }
  }, [blocks, handleBlockChange, onChange]);

  // Handle click outside to deactivate
  const handleContainerClick = useCallback((e: React.MouseEvent) => {
    if (e.target === containerRef.current) {
      // Clicked on empty space, create new block at the end
      const newBlockId = String(Date.now());
      const newBlocks = [...blocks, { id: newBlockId, content: '', type: 'paragraph' as const }];
      setBlocks(newBlocks);
      setActiveBlockId(newBlockId);
    }
  }, [blocks]);

  return (
    <div className="w-full h-full flex flex-col bg-white">
      {/* Minimal Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-200 bg-gray-50">
        <div className="text-xs text-gray-500">
          Typora-style Editor • Click any block to edit
        </div>
        <div className="flex-1" />
        <div className="text-xs text-gray-400">
          {blocks.length} block{blocks.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Content Area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto p-6 min-h-[200px]"
        onClick={handleContainerClick}
      >
        <div className="max-w-3xl mx-auto space-y-2">
          {blocks.map((block) => (
            <BlockRenderer
              key={block.id}
              block={block}
              isActive={activeBlockId === block.id}
              onActivate={() => setActiveBlockId(block.id)}
              onChange={(content) => handleBlockChange(block.id, content)}
              onKeyDown={(e) => handleKeyDown(e, block.id)}
              textareaRef={activeBlockId === block.id ? textareaRef : { current: null }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
