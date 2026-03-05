import { useEditor, EditorContent, Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import { MathExtension } from '@aarkue/tiptap-math-extension';
import { Markdown } from 'tiptap-markdown';
import { useEffect, useRef, useState, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react';
import { SlashCommands, slashCommandsSuggestion } from './SlashCommands';
import { InlineMathEnterFix } from './extensions/InlineMathEnterFix';
import { InlineMathMarkdownStorage } from './extensions/InlineMathMarkdownStorage';
import { MathSyntaxBridge } from './extensions/MathSyntaxBridge';

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
  availableSessions?: { id: string; name: string }[];
  defaultSessionId?: string;
  sourceFile?: { id: string; name: string };
  onAddReferenceToSession?: (
    sessionId: string,
    reference: {
      sourceFileId: string;
      sourceFileName: string;
      markdown: string;
      plainText: string;
    }
  ) => void;
  onRunSelectionAction?: (params: {
    action: 'fix' | 'check';
    targetSessionId: string;
    markdown: string;
    plainText: string;
    sourceFileId: string;
    sourceFileName: string;
  }) => Promise<void> | void;
  onViewportChange?: (payload: {
    scrollTop: number;
    scrollHeight: number;
    visibleUnit: 'line';
    visibleStart: number;
    visibleEnd: number;
  }) => void;
}

export interface TiptapMarkdownEditorRef {
  editor: Editor | null;
  getMarkdown: () => string;
  setMarkdown: (markdown: string) => void;
  focus: () => void;
}

interface EditorSelectionPayload {
  markdown: string;
  plainText: string;
  from: number;
  to: number;
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
      availableSessions = [],
      defaultSessionId,
      sourceFile,
      onAddReferenceToSession,
      onRunSelectionAction,
      onViewportChange,
    },
    ref
  ) => {
    const localEchoFingerprintsRef = useRef<string[]>([]);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const [contextMenu, setContextMenu] = useState<{
      x: number;
      y: number;
      selection: EditorSelectionPayload;
    } | null>(null);
    const [tempDialog, setTempDialog] = useState<{
      selection: EditorSelectionPayload;
      targetSessionId: string;
      status: string;
      running: boolean;
    } | null>(null);

    const getMarkdown = (instance: Editor | null): string => {
      if (!instance) return '';
      const markdownStorage = (instance.storage as any)?.markdown;
      if (markdownStorage?.getMarkdown) {
        return markdownStorage.getMarkdown();
      }
      return instance.getText();
    };

    const sessionTargets = useMemo(
      () =>
        availableSessions.map((item) => ({
          id: item.id,
          name: item.name,
        })),
      [availableSessions]
    );

    const extractSelectionPayload = useCallback(
      (instance: Editor | null): EditorSelectionPayload | null => {
        if (!instance) return null;
        const { state } = instance;
        const { selection } = state;
        if (selection.empty) return null;

        const markdownStorage = (instance.storage as any)?.markdown;
        const serializer = markdownStorage?.serializer;
        const markdown = serializer?.serialize
          ? serializer.serialize(selection.content().content)
          : state.doc.textBetween(selection.from, selection.to, '\n\n');
        const plainText = state.doc.textBetween(selection.from, selection.to, '\n\n');

        const normalizedMarkdown = normalizeCopiedSelectionMarkdown(String(markdown || '').trimEnd());
        if (!normalizedMarkdown.trim()) return null;

        return {
          markdown: normalizedMarkdown,
          plainText: plainText.trim() || normalizedMarkdown,
          from: selection.from,
          to: selection.to,
        };
      },
      []
    );

    const writeMarkdownToClipboard = useCallback(async (markdown: string) => {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdown);
      }
    }, []);

    const rememberLocalEcho = useCallback((markdown: string) => {
      const fingerprint = contentFingerprint(markdown);
      const next = localEchoFingerprintsRef.current.filter((item) => item !== fingerprint);
      next.push(fingerprint);
      if (next.length > 24) {
        next.splice(0, next.length - 24);
      }
      localEchoFingerprintsRef.current = next;
    }, []);

    const isKnownLocalEcho = useCallback((markdown: string) => {
      const fingerprint = contentFingerprint(markdown);
      return localEchoFingerprintsRef.current.includes(fingerprint);
    }, []);

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
        }),
        Image.configure({
          inline: false,
          allowBase64: true,
          HTMLAttributes: {
            class: 'tiptap-image-node',
            loading: 'lazy',
          },
        }),

        // 数学公式支持（手动输入 $...$ 和 $$...$$）
        MathExtension.configure({
          evaluation: false,
          delimiters: {
            inlineRegex: String.raw`(?<!\$)\$([^$\n]+?)\$`,
            blockRegex: String.raw`a^`,
            inlineStart: '$',
            inlineEnd: '$',
            blockStart: '$$',
            blockEnd: '$$',
          },
          katexOptions: {
            throwOnError: false,
            errorColor: '#dc2626',
          },
        }),
        InlineMathEnterFix,

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
        InlineMathMarkdownStorage,
        MathSyntaxBridge,

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
        const markdown = getMarkdown(editor);
        rememberLocalEcho(markdown);
        onChange?.(markdown);
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
        handleDOMEvents: {
          copy: (_view, event) => {
            const e = event as ClipboardEvent;
            if (!e.clipboardData) return false;
            const selection = extractSelectionPayload(editor);
            if (!selection) return false;

            e.preventDefault();
            e.clipboardData.clearData();
            e.clipboardData.setData('text/plain', selection.markdown);
            e.clipboardData.setData('text/markdown', selection.markdown);
            return true;
          },
          cut: (_view, event) => {
            const e = event as ClipboardEvent;
            if (!e.clipboardData || !editor) return false;
            const selection = extractSelectionPayload(editor);
            if (!selection) return false;

            e.preventDefault();
            e.clipboardData.clearData();
            e.clipboardData.setData('text/plain', selection.markdown);
            e.clipboardData.setData('text/markdown', selection.markdown);
            editor.chain().focus().deleteSelection().run();
            return true;
          },
          contextmenu: (_view, event) => {
            if (!editable) return false;
            const e = event as MouseEvent;
            const selection = extractSelectionPayload(editor);
            if (!selection) return false;

            e.preventDefault();
            setContextMenu({
              x: e.clientX,
              y: e.clientY,
              selection,
            });
            return true;
          },
        },
        handlePaste: (_view, event, _slice) => {
          const text = event.clipboardData?.getData('text/plain');
          if (!text) return false;

          // 检测是否包含 Markdown 特征
          const hasMarkdownFeatures = detectMarkdownFeatures(text);

          if (hasMarkdownFeatures) {
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
        return getMarkdown(editor);
      },
      setMarkdown: (markdown: string) => {
        if (!editor) return;
        editor.commands.setContent(markdown, { emitUpdate: false });
      },
      focus: () => {
        editor?.commands.focus();
      },
    }));

    // 当 content prop 变化时更新编辑器
    useEffect(() => {
      if (!editor) return;
      const incoming = content || '';
      const current = getMarkdown(editor);
      if (incoming === current) return;

      // Ignore out-of-order echoes from parent state updates to avoid
      // cursor jumps / newline rollback during fast local editing.
      if (isKnownLocalEcho(incoming)) return;

      editor.commands.setContent(incoming, { emitUpdate: false });
    }, [editor, content, isKnownLocalEcho]);

    useEffect(() => {
      if (!editor || !wrapperRef.current || !onViewportChange) return;

      const wrapper = wrapperRef.current;
      const emitViewport = () => {
        const scrollTop = wrapper.scrollTop || 0;
        const scrollHeight = Math.max(wrapper.scrollHeight, wrapper.clientHeight, 1);
        const totalLines = Math.max(1, getMarkdown(editor).split('\n').length);
        const maxScrollable = Math.max(1, scrollHeight - wrapper.clientHeight);
        const startRatio = Math.max(0, Math.min(1, scrollTop / maxScrollable));
        const visibleRatio = Math.max(0.02, Math.min(1, wrapper.clientHeight / scrollHeight));
        const estimatedStart = Math.max(1, Math.floor(startRatio * totalLines));
        const estimatedSpan = Math.max(1, Math.ceil(visibleRatio * totalLines));
        const estimatedEnd = Math.min(totalLines, estimatedStart + estimatedSpan);
        onViewportChange({
          scrollTop,
          scrollHeight,
          visibleUnit: 'line',
          visibleStart: estimatedStart,
          visibleEnd: estimatedEnd,
        });
      };

      emitViewport();
      wrapper.addEventListener('scroll', emitViewport, { passive: true });
      window.addEventListener('resize', emitViewport);
      return () => {
        wrapper.removeEventListener('scroll', emitViewport);
        window.removeEventListener('resize', emitViewport);
      };
    }, [editor, onViewportChange, content]);

    useEffect(() => {
      if (!contextMenu) return;

      const close = () => setContextMenu(null);
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          setContextMenu(null);
        }
      };

      window.addEventListener('click', close);
      window.addEventListener('keydown', handleKeyDown);
      window.addEventListener('scroll', close, true);
      return () => {
        window.removeEventListener('click', close);
        window.removeEventListener('keydown', handleKeyDown);
        window.removeEventListener('scroll', close, true);
      };
    }, [contextMenu]);

    const resolvedSourceFile = sourceFile || {
      id: 'unknown-file',
      name: 'Current Document',
    };
    const initialTargetSessionId =
      defaultSessionId || sessionTargets[0]?.id || '';

    const handleCopyMarkdown = useCallback(async () => {
      if (!contextMenu) return;
      try {
        await writeMarkdownToClipboard(contextMenu.selection.markdown);
      } catch {
        // Ignore clipboard permission errors; copy/cut keyboard path still writes via clipboardData.
      }
      setContextMenu(null);
    }, [contextMenu, writeMarkdownToClipboard]);

    const handleCutMarkdown = useCallback(async () => {
      if (!contextMenu || !editor) return;
      try {
        await writeMarkdownToClipboard(contextMenu.selection.markdown);
      } catch {
        // Ignore clipboard permission errors; cut still removes selected content.
      }
      editor.chain().focus().deleteSelection().run();
      setContextMenu(null);
    }, [contextMenu, editor, writeMarkdownToClipboard]);

    const handleReferenceImport = useCallback(
      (targetSessionId: string, selection: EditorSelectionPayload) => {
        if (!targetSessionId || !onAddReferenceToSession) return;
        onAddReferenceToSession(targetSessionId, {
          sourceFileId: resolvedSourceFile.id,
          sourceFileName: resolvedSourceFile.name,
          markdown: selection.markdown,
          plainText: selection.plainText,
        });
      },
      [onAddReferenceToSession, resolvedSourceFile.id, resolvedSourceFile.name]
    );

    const openTempDialog = useCallback(() => {
      if (!contextMenu) return;
      setTempDialog({
        selection: contextMenu.selection,
        targetSessionId: initialTargetSessionId,
        status: '',
        running: false,
      });
      setContextMenu(null);
    }, [contextMenu, initialTargetSessionId]);

    const runTempDialogAction = useCallback(
      async (action: 'fix' | 'check') => {
        if (!tempDialog) return;
        if (!tempDialog.targetSessionId) {
          setTempDialog((prev) =>
            prev
              ? {
                  ...prev,
                  status: 'No open session. Open at least one session tab first.',
                }
              : prev
          );
          return;
        }
        if (!onRunSelectionAction) {
          setTempDialog((prev) =>
            prev
              ? {
                  ...prev,
                  status: 'Action handler is unavailable.',
                }
              : prev
          );
          return;
        }

        setTempDialog((prev) => (prev ? { ...prev, running: true, status: '' } : prev));
        handleReferenceImport(tempDialog.targetSessionId, tempDialog.selection);

        try {
          await onRunSelectionAction({
            action,
            targetSessionId: tempDialog.targetSessionId,
            markdown: tempDialog.selection.markdown,
            plainText: tempDialog.selection.plainText,
            sourceFileId: resolvedSourceFile.id,
            sourceFileName: resolvedSourceFile.name,
          });
          setTempDialog((prev) =>
            prev
              ? {
                  ...prev,
                  running: false,
                  status: `Sent to session "${sessionTargets.find((s) => s.id === prev.targetSessionId)?.name || prev.targetSessionId}".`,
                }
              : prev
          );
        } catch (error) {
          setTempDialog((prev) =>
            prev
              ? {
                  ...prev,
                  running: false,
                  status: error instanceof Error ? error.message : 'Failed to run action.',
                }
              : prev
          );
        }
      },
      [tempDialog, onRunSelectionAction, handleReferenceImport, resolvedSourceFile.id, resolvedSourceFile.name, sessionTargets]
    );

    if (!editor) {
      return <div className="p-4 text-gray-400">Loading editor...</div>;
    }

    return (
      <div ref={wrapperRef} className="tiptap-markdown-wrapper relative">
        <EditorContent editor={editor} />

        {contextMenu && (
          <div
            className="fixed z-[90] min-w-[260px] rounded-lg border border-theme-border/30 bg-theme-bg shadow-[0_12px_32px_rgba(0,0,0,0.18)] p-1"
            style={{
              left: Math.min(contextMenu.x, window.innerWidth - 280),
              top: Math.min(contextMenu.y, window.innerHeight - 320),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="w-full rounded px-2.5 py-2 text-left text-xs text-theme-text/80 hover:bg-theme-text/10"
              onClick={() => {
                void handleCopyMarkdown();
              }}
            >
              Copy Selection as Markdown
            </button>
            <button
              className="w-full rounded px-2.5 py-2 text-left text-xs text-theme-text/80 hover:bg-theme-text/10"
              onClick={() => {
                void handleCutMarkdown();
              }}
            >
              Cut Selection as Markdown
            </button>

            <div className="my-1 h-px bg-theme-border/20" />
            <div className="px-2.5 py-1 text-[11px] text-theme-text/55 uppercase tracking-[0.06em]">
              Import As Reference
            </div>
            {sessionTargets.length === 0 ? (
              <div className="px-2.5 py-1.5 text-[11px] text-theme-text/45">
                No open sessions.
              </div>
            ) : (
              sessionTargets.map((session) => (
                <button
                  key={session.id}
                  className="w-full rounded px-2.5 py-2 text-left text-xs text-theme-text/80 hover:bg-theme-text/10 truncate"
                  onClick={() => {
                    handleReferenceImport(session.id, contextMenu.selection);
                    setContextMenu(null);
                  }}
                >
                  {session.name}
                </button>
              ))
            )}

            <div className="my-1 h-px bg-theme-border/20" />
            <button
              className="w-full rounded px-2.5 py-2 text-left text-xs text-theme-text/80 hover:bg-theme-text/10"
              onClick={openTempDialog}
            >
              Open Temporary Dialog (Fix / Check)
            </button>
          </div>
        )}

        {tempDialog && (
          <div
            className="fixed inset-0 z-[85] bg-black/20 flex items-center justify-center p-4"
            onClick={() => setTempDialog(null)}
          >
            <div
              className="w-full max-w-2xl rounded-xl border border-theme-border/25 bg-theme-bg shadow-[0_16px_40px_rgba(0,0,0,0.2)]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 border-b border-theme-border/20 text-sm font-semibold text-theme-text/85">
                Temporary Document Dialog
              </div>

              <div className="px-4 py-3 space-y-3">
                <div className="text-xs text-theme-text/60">
                  Source: {resolvedSourceFile.name}
                </div>
                <div className="text-xs text-theme-text/60">
                  Target Session:
                </div>
                <select
                  value={tempDialog.targetSessionId}
                  onChange={(e) =>
                    setTempDialog((prev) =>
                      prev
                        ? {
                            ...prev,
                            targetSessionId: e.target.value,
                          }
                        : prev
                    )
                  }
                  className="w-full rounded border border-theme-border/25 bg-theme-bg px-2 py-1.5 text-sm text-theme-text"
                >
                  {sessionTargets.length === 0 ? (
                    <option value="">No open sessions</option>
                  ) : (
                    sessionTargets.map((session) => (
                      <option key={session.id} value={session.id}>
                        {session.name}
                      </option>
                    ))
                  )}
                </select>

                <div className="text-xs text-theme-text/60">Selected Markdown:</div>
                <pre className="max-h-56 overflow-auto rounded border border-theme-border/20 bg-theme-surface/50 p-2 text-[12px] text-theme-text/80 whitespace-pre-wrap break-words">
                  {tempDialog.selection.markdown}
                </pre>

                {tempDialog.status && (
                  <div className="rounded border border-theme-border/20 bg-theme-surface/40 px-2 py-1.5 text-xs text-theme-text/75">
                    {tempDialog.status}
                  </div>
                )}
              </div>

              <div className="px-4 py-3 border-t border-theme-border/20 flex items-center justify-between gap-2">
                <button
                  className="px-3 py-1.5 rounded border border-theme-border/25 text-xs hover:bg-theme-text/10"
                  onClick={() => setTempDialog(null)}
                >
                  Close
                </button>
                <div className="flex items-center gap-2">
                  <button
                    className="px-3 py-1.5 rounded border border-theme-border/25 text-xs hover:bg-theme-text/10 disabled:opacity-50"
                    disabled={tempDialog.running}
                    onClick={() => runTempDialogAction('check')}
                  >
                    Check Selection
                  </button>
                  <button
                    className="px-3 py-1.5 rounded border border-theme-border/25 text-xs hover:bg-theme-text/10 disabled:opacity-50"
                    disabled={tempDialog.running}
                    onClick={() => runTempDialogAction('fix')}
                  >
                    Fix Selection
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
);

TiptapMarkdownEditor.displayName = 'TiptapMarkdownEditor';

/**
 * 检测文本是否包含 Markdown 特征
 */
export function detectMarkdownFeatures(text: string): boolean {
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

export function normalizeCopiedSelectionMarkdown(markdown: string): string {
  let normalized = markdown;

  normalized = normalized.replace(
    /<span\b([^>]*\bdata-type=(["'])inlineMath\2[^>]*)>([\s\S]*?)<\/span>/gi,
    (_match, attrs: string, _quote: string, inner: string) => {
      const formula = readMathFormula(attrs, inner);
      const display = readDisplayMode(attrs, false);
      return renderMathMarkdown(formula, display);
    }
  );

  normalized = normalized.replace(
    /<span\b([^>]*\bdata-type=(["'])inlineMath\2[^>]*)\/>/gi,
    (_match, attrs: string) => {
      const formula = readMathFormula(attrs, '');
      const display = readDisplayMode(attrs, false);
      return renderMathMarkdown(formula, display);
    }
  );

  normalized = normalized.replace(
    /<math-inline\b([^>]*)>([\s\S]*?)<\/math-inline>/gi,
    (_match, attrs: string, inner: string) => renderMathMarkdown(readMathFormula(attrs, inner), false)
  );
  normalized = normalized.replace(
    /<math-block\b([^>]*)>([\s\S]*?)<\/math-block>/gi,
    (_match, attrs: string, inner: string) => renderMathMarkdown(readMathFormula(attrs, inner), true)
  );

  return normalized;
}

export function renderMathMarkdown(formula: string, displayMode: boolean): string {
  const normalized = formula.trim();
  if (!normalized) return '';
  if (displayMode) {
    return normalized.includes('\n') ? `$$\n${normalized}\n$$` : `$$${normalized}$$`;
  }
  return `$${normalized}$`;
}

export function readMathFormula(attrs: string, inner: string): string {
  const attrFormula = readHtmlAttr(attrs, 'data-latex') || readHtmlAttr(attrs, 'formula');
  if (attrFormula) return attrFormula;
  return stripMathDelimiters(inner);
}

export function readDisplayMode(attrs: string, fallback: boolean): boolean {
  const value = (readHtmlAttr(attrs, 'data-display') || readHtmlAttr(attrs, 'display') || '').toLowerCase();
  if (!value) return fallback;
  return value === 'yes' || value === 'true' || value === '1';
}

export function readHtmlAttr(attrs: string, attrName: string): string | undefined {
  const escapedAttr = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b${escapedAttr}=(["'])([\\s\\S]*?)\\1`, 'i');
  const match = attrs.match(pattern);
  if (!match) return undefined;
  return decodeHtmlEntities(match[2]);
}

export function stripMathDelimiters(content: string): string {
  const raw = decodeHtmlEntities(content).trim();
  const withoutTags = raw.replace(/<[^>]+>/g, '').trim();
  const blockMatch = withoutTags.match(/^\$\$([\s\S]*?)\$\$$/);
  if (blockMatch) return blockMatch[1].trim();
  const inlineMatch = withoutTags.match(/^\$([\s\S]*?)\$$/);
  if (inlineMatch) return inlineMatch[1].trim();
  return withoutTags;
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function contentFingerprint(markdown: string): string {
  const head = markdown.slice(0, 120);
  const tail = markdown.slice(-120);
  return `${markdown.length}:${head}|${tail}`;
}
