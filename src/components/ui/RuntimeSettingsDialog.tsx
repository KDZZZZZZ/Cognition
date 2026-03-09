import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { RuntimeOverrides } from '../../config/runtime';

interface RuntimeSettingsDialogProps {
  isOpen: boolean;
  initialValue: RuntimeOverrides;
  onClose: () => void;
  onSave: (value: RuntimeOverrides) => void;
}

function createEmptyOverrides(): RuntimeOverrides {
  return {
    apiBaseUrl: '',
    primary: { apiKey: '', baseUrl: '', model: '' },
    ocr: { apiKey: '', baseUrl: '', model: '' },
    embedding: { apiKey: '', baseUrl: '', model: '' },
  };
}

export function RuntimeSettingsDialog({
  isOpen,
  initialValue,
  onClose,
  onSave,
}: RuntimeSettingsDialogProps) {
  const [draft, setDraft] = useState<RuntimeOverrides>(initialValue || createEmptyOverrides());
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setDraft(initialValue || createEmptyOverrides());
    window.setTimeout(() => firstInputRef.current?.focus(), 50);
  }, [initialValue, isOpen]);

  if (!isOpen) return null;

  const updateRootField = (field: 'apiBaseUrl', value: string) => {
    setDraft((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const updateProviderField = (
    provider: keyof Pick<RuntimeOverrides, 'primary' | 'ocr' | 'embedding'>,
    field: 'apiKey' | 'baseUrl' | 'model',
    value: string
  ) => {
    setDraft((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        [field]: value,
      },
    }));
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    onSave({
      apiBaseUrl: draft.apiBaseUrl.trim(),
      primary: {
        apiKey: draft.primary.apiKey.trim(),
        baseUrl: draft.primary.baseUrl.trim(),
        model: draft.primary.model.trim(),
      },
      ocr: {
        apiKey: draft.ocr.apiKey.trim(),
        baseUrl: draft.ocr.baseUrl.trim(),
        model: draft.ocr.model.trim(),
      },
      embedding: {
        apiKey: draft.embedding.apiKey.trim(),
        baseUrl: draft.embedding.baseUrl.trim(),
        model: draft.embedding.model.trim(),
      },
    });
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      onClose();
    }
  };

  const Section = ({
    title,
    provider,
    toneClass,
  }: {
    title: string;
    provider: 'primary' | 'ocr' | 'embedding';
    toneClass: string;
  }) => (
    <div className="rounded-2xl border border-theme-border/20 bg-theme-bg/80 p-4">
      <div className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${toneClass}`}>{title}</div>
      <div className="mt-3 grid gap-3">
        <label className="grid gap-1.5 text-xs text-theme-text/65">
          <span>Base URL</span>
          <input
            type="text"
            value={draft[provider].baseUrl}
            onChange={(event) => updateProviderField(provider, 'baseUrl', event.target.value)}
            className="w-full rounded-xl border border-theme-border/25 bg-theme-surface px-3 py-2 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-text/15"
            placeholder="https://api.example.com"
          />
        </label>
        <label className="grid gap-1.5 text-xs text-theme-text/65">
          <span>API Key</span>
          <input
            type="password"
            value={draft[provider].apiKey}
            onChange={(event) => updateProviderField(provider, 'apiKey', event.target.value)}
            className="w-full rounded-xl border border-theme-border/25 bg-theme-surface px-3 py-2 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-text/15"
            placeholder="sk-..."
          />
        </label>
        <label className="grid gap-1.5 text-xs text-theme-text/65">
          <span>模型名</span>
          <input
            type="text"
            value={draft[provider].model}
            onChange={(event) => updateProviderField(provider, 'model', event.target.value)}
            className="w-full rounded-xl border border-theme-border/25 bg-theme-surface px-3 py-2 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-text/15"
            placeholder={provider === 'primary' ? 'gpt-4o / kimi / deepseek-chat' : provider === 'ocr' ? 'DeepSeek-OCR' : 'text-embedding-3-large'}
          />
        </label>
      </div>
    </div>
  );

  return (
    <div data-testid="runtime-settings-backdrop" className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4">
      <form
        data-testid="runtime-settings-dialog"
        onSubmit={handleSubmit}
        onKeyDown={handleKeyDown}
        className="w-[min(92vw,820px)] max-h-[90vh] overflow-y-auto rounded-[28px] border border-theme-border/25 bg-[linear-gradient(180deg,rgba(255,251,245,0.98),rgba(247,242,233,0.96))] shadow-[0_28px_80px_rgba(22,22,22,0.18)]"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-theme-border/20 bg-[linear-gradient(180deg,rgba(255,251,245,0.96),rgba(255,251,245,0.84))] px-6 py-4 backdrop-blur-sm">
          <div>
            <h2 className="text-base font-semibold tracking-[0.04em] text-theme-text">接口与模型</h2>
            <p className="mt-1 text-xs text-theme-text/55">前端会立即切换 Base URL，并把这三组配置随请求头一起发给后端。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-theme-text/45 transition-colors hover:bg-theme-text/10 hover:text-theme-text/80"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <div className="grid gap-4 px-6 py-5">
          <div className="rounded-2xl border border-theme-border/20 bg-theme-bg/70 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-theme-text/55">工作区后端</div>
            <label className="mt-3 grid gap-1.5 text-xs text-theme-text/65">
              <span>API Base URL</span>
              <input
                ref={firstInputRef}
                type="text"
                value={draft.apiBaseUrl}
                onChange={(event) => updateRootField('apiBaseUrl', event.target.value)}
                className="w-full rounded-xl border border-theme-border/25 bg-theme-surface px-3 py-2 text-sm text-theme-text focus:outline-none focus:ring-2 focus:ring-theme-text/15"
                placeholder="留空则沿用当前部署地址"
              />
            </label>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Section title="主模型" provider="primary" toneClass="text-[#5c3b2a]" />
            <Section title="OCR" provider="ocr" toneClass="text-[#7a4c14]" />
            <Section title="Embedding" provider="embedding" toneClass="text-[#274c77]" />
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-theme-border/20 px-6 py-4">
          <p className="text-xs text-theme-text/50">后端若尚未读取这些请求头，OCR 和 Embedding 还需要再补一层服务端接入。</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-4 py-2 text-sm text-theme-text/70 transition-colors hover:bg-theme-text/8"
            >
              取消
            </button>
            <button
              type="submit"
              className="rounded-xl bg-[#4a2d1f] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              保存
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
