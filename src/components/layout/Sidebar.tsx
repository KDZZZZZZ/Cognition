import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { FileTree } from '../filetree/FileTree';
import { Timeline } from '../timeline/Timeline';

const SIDEBAR_WIDTH_KEY = 'cognition.sidebar.width';
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 760;
const SIDEBAR_DEFAULT_WIDTH = 320;

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

export function Sidebar() {
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
    const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
  });
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    }
  }, [width]);

  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const startResize = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left || 0;
    const setWidthFromClientX = (clientX: number) => {
      setWidth(clampSidebarWidth(clientX - sidebarLeft));
    };

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    setResizing(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      setWidthFromClientX(moveEvent.clientX);
    };

    const stopResize = () => {
      setResizing(false);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopResize);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', stopResize);
    setWidthFromClientX(event.clientX);
  };

  return (
    <div
      ref={sidebarRef}
      className="relative h-full flex-shrink-0 border-r border-theme-border/30 paper-divider-dashed surface-panel flex flex-col overflow-hidden transition-colors duration-300 shadow-[4px_0_24px_rgba(16,16,16,0.06)]"
      style={{ width: `${width}px` }}
    >
      <FileTree />
      <Timeline />
      <button
        type="button"
        aria-label="Resize sidebar"
        onMouseDown={startResize}
        className="group absolute top-0 right-0 z-20 h-full w-3 cursor-col-resize touch-none bg-transparent hover:bg-theme-text/5"
      >
        <span
          className={`absolute left-1/2 top-0 h-full -translate-x-1/2 rounded-full transition-colors ${
            resizing ? 'w-[2px] bg-theme-text/40' : 'w-px bg-theme-border/30 group-hover:bg-theme-text/45'
          }`}
        />
      </button>
    </div>
  );
}
