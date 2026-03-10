import { useEffect, useId, useRef, useState } from 'react';

interface MermaidDiagramProps {
  chart: string;
  className?: string;
  title?: string | null;
}

interface MermaidRenderState {
  svg: string;
  error: string | null;
}

let mermaidModulePromise: Promise<any> | null = null;

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        fontFamily: 'inherit',
        suppressErrorRendering: true,
      });
      return mermaid;
    });
  }
  return mermaidModulePromise;
}

function sanitizeMermaidId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function readErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return 'Unable to render Mermaid diagram.';
}

export function MermaidDiagram({ chart, className = '', title = null }: MermaidDiagramProps) {
  const reactId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<MermaidRenderState>({ svg: '', error: null });

  useEffect(() => {
    let cancelled = false;
    const trimmedChart = chart.trim();

    if (!trimmedChart) {
      setState({ svg: '', error: 'Mermaid source is empty.' });
      return () => {
        cancelled = true;
      };
    }

    const render = async () => {
      try {
        const mermaid = await loadMermaid();
        const renderId = sanitizeMermaidId(`mermaid-${reactId}`);
        const { svg, bindFunctions } = await mermaid.render(renderId, trimmedChart);
        if (cancelled) return;
        setState({ svg, error: null });
        queueMicrotask(() => {
          if (cancelled || !containerRef.current || !bindFunctions) return;
          bindFunctions(containerRef.current);
        });
      } catch (error) {
        if (cancelled) return;
        setState({ svg: '', error: readErrorMessage(error) });
      }
    };

    void render();

    return () => {
      cancelled = true;
    };
  }, [chart, reactId]);

  return (
    <div
      data-testid="mermaid-diagram"
      className={`overflow-hidden rounded-xl border border-theme-border/16 bg-theme-surface/8 ${className}`.trim()}
    >
      {title ? (
        <div className="border-b border-theme-border/12 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-theme-text/46">
          {title}
        </div>
      ) : null}
      {state.error ? (
        <div className="space-y-2 px-3 py-3">
          <div data-testid="mermaid-diagram-error" className="text-xs text-rose-700">
            {state.error}
          </div>
          <pre className="overflow-x-auto rounded-lg bg-theme-bg/80 px-3 py-2 text-[12px] text-theme-text/72">
            <code>{chart}</code>
          </pre>
        </div>
      ) : (
        <div
          ref={containerRef}
          className="overflow-x-auto px-3 py-3 text-theme-text [&_svg]:mx-auto [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}
    </div>
  );
}
