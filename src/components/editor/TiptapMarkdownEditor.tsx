import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { MathExtension } from '@aarkue/tiptap-math-extension';
import { Markdown } from 'tiptap-markdown';
import { useEffect, forwardRef, useImperativeHandle } from 'react';
import { SlashCommands, slashCommandsSuggestion } from './SlashCommands';

import 'katex/dist/katex.min.css';
import './TiptapMarkdownEditor.css';

export interface TiptapMarkdownEditorProps {
  content?: string;
  onChange?: (markdown: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  editable?: boolean;
  className?: string;
  autofocus?: boolean;
}

export interface TiptapMarkdownEditorRef {
  editor: Editor | null;
  getMarkdown: () => string;
  setMarkdown: (markdown: string) => void;
  focus: () => void;
}

/**
 * TiptapMarkdownEditor: 输入即渲染的 Markdown 编辑器
 *
 * 特性：
 * 1. Schema & Rules: 输入 #, ##, ---, ``` 等自动转换
 * 2. Markdown 转换: 支持 MD 字符串导入导出
 * 3. 粘贴拦截: 智能识别并解析 MD 粘贴内容
 * 4. 视觉反馈: 活跃行显示 MD 语法标记 + 斜杠命令
 */
export const TiptapMarkdownEditor = forwardRef<TiptapMarkdownEditorRef, TiptapMarkdownEditorProps>(
  (
    {
      content = '',
      onChange,
      onBlur,
      placeholder = 'Type / for commands, or start writing...',
      editable = true,
      className = '',
      autofocus = false,
    },
    ref
  ) => {
    const editor = useEditor({
      extensions: [
        // Stage 1: Schema & Rules - StarterKit 包含所有基础 inputRules
        StarterKit.configure({
          heading: {
            levels: [1, 2, 3, 4, 5, 6],
          },
          codeBlock: {
            languageClassPrefix: 'language-',
          },
          horizontalRule: true,
          blockquote: true,
          bulletList: true,
          orderedList: true,
          listItem: true,
          bold: true,
          italic: true,
          strike: true,
          code: true,
        }),

        // 数学公式支持 (@aarkue/tiptap-math-extension)
        // 支持 $ 开启行内公式，$$ 开启块级公式
        // 点击公式可切换回源码编辑状态
        MathExtension.configure({
          evaluation: false, // 不自动计算
          katexOptions: {
            throwOnError: false,
            errorColor: '#dc2626',
          },
        }),

        // Placeholder 扩展
        Placeholder.configure({
          placeholder,
          emptyEditorClass: 'is-editor-empty',
          emptyNodeClass: 'is-empty',
        }),

        // Stage 2: Markdown 转换层
        Markdown.configure({
          html: true,
          tightLists: true,
          tightListClass: 'tight',
          bulletListMarker: '-',
          linkify: true,
          breaks: false,
          transformPastedText: true,
          transformCopiedText: true,
        }),

        // Stage 4: 斜杠命令
        SlashCommands.configure({
          suggestion: slashCommandsSuggestion,
        }),
      ],

      content,
      editable,
      autofocus,

      // Stage 2: onUpdate 时输出 Markdown
      onUpdate: ({ editor }) => {
        if (onChange) {
          const markdown = editor.storage.markdown.getMarkdown();
          onChange(markdown);
        }
      },

      onBlur: () => {
        onBlur?.();
      },

      // Stage 3: 粘贴拦截
      editorProps: {
        attributes: {
          class: `tiptap-markdown-editor ${className}`,
          spellcheck: 'false',
        },
        handlePaste: (view, event, slice) => {
          const text = event.clipboardData?.getData('text/plain');
          if (!text) return false;

          // 检测是否包含 Markdown 特征
          const hasMarkdownFeatures = detectMarkdownFeatures(text);

          if (hasMarkdownFeatures) {
            // 使用 Markdown 解析器处理粘贴内容
            const { state, dispatch } = view;
            const tr = state.tr;

            // 通过 editor 的 markdown 存储来解析
            if (editor) {
              editor.commands.insertContent(text, {
                parseOptions: {
                  preserveWhitespace: 'full',
                },
              });
              return true;
            }
          }

          return false;
        },
      },
    });

    // 暴露编辑器方法给父组件
    useImperativeHandle(ref, () => ({
      editor,
      getMarkdown: () => {
        if (!editor) return '';
        return editor.storage.markdown.getMarkdown();
      },
      setMarkdown: (markdown: string) => {
        if (!editor) return;
        editor.commands.setContent(markdown);
      },
      focus: () => {
        editor?.commands.focus();
      },
    }));

    // 当 content prop 变化时更新编辑器
    useEffect(() => {
      if (editor && content !== editor.storage.markdown.getMarkdown()) {
        editor.commands.setContent(content);
      }
    }, [editor, content]);

    if (!editor) {
      return <div className="p-4 text-gray-400">Loading editor...</div>;
    }

    return (
      <div className="tiptap-markdown-wrapper">
        <EditorContent editor={editor} />
      </div>
    );
  }
);

TiptapMarkdownEditor.displayName = 'TiptapMarkdownEditor';

/**
 * 检测文本是否包含 Markdown 特征
 */
function detectMarkdownFeatures(text: string): boolean {
  const markdownPatterns = [
    /^#{1,6}\s/m,           // 标题 # ## ###
    /^\s*[-*+]\s/m,         // 无序列表
    /^\s*\d+\.\s/m,         // 有序列表
    /^\s*>\s/m,             // 引用
    /^\s*```/m,             // 代码块
    /^\s*---+\s*$/m,        // 分割线
    /^\s*\*\*\*+\s*$/m,     // 分割线
    /\[.+\]\(.+\)/,         // 链接 [text](url)
    /!\[.*\]\(.+\)/,        // 图片 ![alt](url)
    /\*\*.+\*\*/,           // 粗体 **text**
    /\*.+\*/,               // 斜体 *text*
    /~~.+~~/,               // 删除线 ~~text~~
    /`.+`/,                 // 行内代码 `code`
    /\|.+\|.+\|/,           // 表格
  ];

  return markdownPatterns.some((pattern) => pattern.test(text));
}

export default TiptapMarkdownEditor;
