import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, NodeViewProps, ReactNodeViewRenderer } from '@tiptap/react';
import { useState, useRef, useEffect, useCallback } from 'react';
import katex from 'katex';

// 数学公式 NodeView 组件
function MathNodeView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [localValue, setLocalValue] = useState(node.attrs.formula || '');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const isInline = node.type.name === 'mathInline';

  // 当节点选中时自动进入编辑模式
  useEffect(() => {
    if (selected && !isEditing) {
      setIsEditing(true);
    }
  }, [selected]);

  // 编辑模式时聚焦输入框
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // 同步外部变化
  useEffect(() => {
    setLocalValue(node.attrs.formula || '');
  }, [node.attrs.formula]);

  // 渲染 KaTeX
  const renderKatex = useCallback((formula: string) => {
    if (!formula.trim()) {
      return '<span class="text-gray-400 italic">Empty formula</span>';
    }
    try {
      return katex.renderToString(formula, {
        displayMode: !isInline,
        throwOnError: false,
        errorColor: '#dc2626',
      });
    } catch (e) {
      return `<span class="text-red-500">${formula}</span>`;
    }
  }, [isInline]);

  // 保存并退出编辑
  const saveAndExit = useCallback(() => {
    updateAttributes({ formula: localValue });
    setIsEditing(false);
  }, [localValue, updateAttributes]);

  // 处理键盘事件
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      saveAndExit();
    } else if (e.key === 'Enter' && !e.shiftKey && isInline) {
      e.preventDefault();
      e.stopPropagation();
      saveAndExit();
    } else if (e.key === 'Backspace' && localValue === '') {
      // 删除空公式节点
      e.preventDefault();
      e.stopPropagation();
      editor.commands.deleteNode(node.type.name);
    }
  }, [saveAndExit, localValue, editor, node.type.name, isInline]);

  // 处理点击进入编辑
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsEditing(true);
  }, []);

  // 处理失焦
  const handleBlur = useCallback((e: React.FocusEvent) => {
    // 检查是否点击了容器内部
    if (containerRef.current?.contains(e.relatedTarget as Node)) {
      return;
    }
    saveAndExit();
  }, [saveAndExit]);

  if (isEditing) {
    return (
      <NodeViewWrapper
        as={isInline ? 'span' : 'div'}
        className={isInline ? 'inline-block align-middle' : 'my-2'}
        ref={containerRef}
      >
        <div
          className={`
            ${isInline ? 'inline-flex' : 'flex flex-col'}
            bg-gray-50 border border-blue-400 rounded-md overflow-hidden
            ${isInline ? 'px-1' : 'p-2'}
          `}
        >
          <div className="flex items-center gap-1 text-xs text-gray-500 mb-1">
            <span className="font-mono">{isInline ? '$' : '$$'}</span>
            <span>LaTeX</span>
          </div>
          <textarea
            ref={inputRef}
            value={localValue}
            onChange={(e) => setLocalValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleBlur}
            className={`
              font-mono text-sm bg-white border border-gray-200 rounded
              focus:outline-none focus:ring-1 focus:ring-blue-300
              ${isInline ? 'w-32 h-6 px-1' : 'w-full min-h-[60px] p-2'}
              resize-none
            `}
            placeholder="Enter LaTeX formula..."
            spellCheck={false}
          />
          {!isInline && localValue && (
            <div className="mt-2 pt-2 border-t border-gray-200">
              <div className="text-xs text-gray-400 mb-1">Preview:</div>
              <div
                className="overflow-x-auto"
                dangerouslySetInnerHTML={{ __html: renderKatex(localValue) }}
              />
            </div>
          )}
        </div>
      </NodeViewWrapper>
    );
  }

  // 渲染模式
  return (
    <NodeViewWrapper
      as={isInline ? 'span' : 'div'}
      className={`
        ${isInline ? 'inline-block align-middle' : 'my-4 text-center'}
        cursor-pointer hover:bg-blue-50 rounded transition-colors
        ${selected ? 'ring-2 ring-blue-300' : ''}
      `}
      onClick={handleClick}
      title="Click to edit formula"
    >
      <div
        className={isInline ? 'inline' : 'block py-2'}
        dangerouslySetInnerHTML={{ __html: renderKatex(localValue) }}
      />
    </NodeViewWrapper>
  );
}

// 行内数学公式节点
export const MathInline = Node.create({
  name: 'mathInline',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      formula: {
        default: '',
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'math-inline',
      },
      {
        tag: 'span[data-math-inline]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['math-inline', mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView);
  },

  addInputRules() {
    return [
      {
        // 匹配 $...$ 行内公式
        find: /\$([^$\n]+)\$$/,
        handler: ({ state, range, match }) => {
          const formula = match[1];
          const { tr } = state;

          if (formula) {
            tr.replaceWith(
              range.from,
              range.to,
              this.type.create({ formula })
            );
          }
        },
      },
    ];
  },

  addCommands() {
    return {
      insertMathInline:
        (formula = '') =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { formula },
          });
        },
    } as any;
  },
});

// 块级数学公式节点
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      formula: {
        default: '',
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'math-block',
      },
      {
        tag: 'div[data-math-block]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['math-block', mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathNodeView);
  },

  addInputRules() {
    return [
      {
        // 匹配 $$...$$ 块级公式（在新行输入 $$ 开始）
        find: /^\$\$([^$]*)\$\$$/,
        handler: ({ state, range, match }) => {
          const formula = match[1];
          const { tr } = state;

          tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ formula })
          );
        },
      },
    ];
  },

  // 支持在空行输入 $$ 开始块级公式
  addKeyboardShortcuts() {
    return {
      'Mod-Shift-m': () => {
        return this.editor.commands.insertContent({
          type: this.name,
          attrs: { formula: '' },
        });
      },
    };
  },

  addCommands() {
    return {
      insertMathBlock:
        (formula = '') =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { formula },
          });
        },
    } as any;
  },
});
