import { useEffect, useState, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCw } from 'lucide-react';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Set up PDF.js worker - use CDN for reliable loading
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface PDFViewerProps {
  fileId: string;
  filePath: string;
  onPageChange?: (pageNumber: number) => void;
  onScrollChange?: (scrollTop: number, scrollHeight: number) => void;
}

export function PDFViewer({ filePath, onPageChange, onScrollChange }: PDFViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [rotation, setRotation] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setLoading(true);
    setError(null);
    setNumPages(0);
    setPageNumber(1);
  }, [filePath]);

  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
    setPageNumber((prev) => Math.min(Math.max(prev, 1), numPages));
    setLoading(false);
  }

  function onPageLoaded() {
    // Report scroll position after page loads
    setTimeout(() => {
      if (containerRef.current && onScrollChange) {
        onScrollChange(
          containerRef.current.scrollTop,
          containerRef.current.scrollHeight
        );
      }
    }, 100);
  }

  const scrollToPage = (targetPage: number, behavior: ScrollBehavior = 'smooth') => {
    const container = containerRef.current;
    if (!container) return;

    const pageElement = container.querySelector(`[data-page-number="${targetPage}"]`) as HTMLElement | null;
    if (!pageElement) return;

    // Keep scrolling scoped to the PDF container to avoid page-level jump.
    const containerRect = container.getBoundingClientRect();
    const pageRect = pageElement.getBoundingClientRect();
    const rawTop = container.scrollTop + (pageRect.top - containerRect.top) - 8;
    const maxScrollTop = Math.max(container.scrollHeight - container.clientHeight, 0);
    const targetTop = Math.max(0, Math.min(rawTop, maxScrollTop));

    container.scrollTo({ top: targetTop, behavior });
  };

  const handleScroll = () => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    scrollTimeoutRef.current = setTimeout(() => {
      if (containerRef.current && onScrollChange) {
        const scrollTop = containerRef.current.scrollTop;
        const scrollHeight = containerRef.current.scrollHeight;
        if (numPages <= 0) return;

        // Calculate which page is visible
        const pageHeight = scrollHeight / numPages;
        const currentPage = Math.min(
          Math.ceil(scrollTop / pageHeight) + 1,
          numPages
        );

        if (currentPage !== pageNumber) {
          setPageNumber(currentPage);
          onPageChange?.(currentPage);
        }

        onScrollChange(scrollTop, scrollHeight);
      }
    }, 100);
  };

  const changePage = (offset: number) => {
    setPageNumber((prevPageNumber) => {
      const newPage = prevPageNumber + offset;
      const clamped = Math.max(1, Math.min(newPage, numPages));
      onPageChange?.(clamped);

      setTimeout(() => {
        scrollToPage(clamped, 'smooth');
      }, 50);

      return clamped;
    });
  };

  const zoomIn = () => setScale((prev) => Math.min(prev + 0.25, 3));
  const zoomOut = () => setScale((prev) => Math.max(prev - 0.25, 0.5));
  const rotate = () => setRotation((prev) => (prev + 90) % 360);

  const changePageDirect = (page: number) => {
    const clamped = Math.max(1, Math.min(page, numPages));
    setPageNumber(clamped);
    onPageChange?.(clamped);

    setTimeout(() => {
      scrollToPage(clamped, 'smooth');
    }, 50);
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-theme-text/55">
        <p>Failed to load PDF</p>
        <p className="text-sm mt-2">{error}</p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full min-h-0"
      style={{ backgroundColor: 'var(--theme-surface-muted)' }}
    >
      {/* Toolbar */}
      <div
        data-testid="pdf-toolbar"
        className="flex items-center justify-between px-4 py-2 border-b border-theme-border/30 paper-divider-dashed"
        style={{ backgroundColor: 'var(--theme-surface)' }}
      >
        <div className="flex items-center gap-2">
          <button
            onClick={() => changePage(-1)}
            disabled={pageNumber <= 1}
            className="p-1.5 hover:bg-theme-text/10 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Previous page"
          >
            <ChevronLeft size={16} />
          </button>

          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={numPages}
              value={pageNumber}
              onChange={(e) => changePageDirect(parseInt(e.target.value) || 1)}
              className="w-16 text-center text-sm border border-theme-border/35 paper-divider rounded px-1 py-1 bg-theme-bg text-theme-text"
            />
            <span className="text-sm text-theme-text/55">/ {numPages}</span>
          </div>

          <button
            onClick={() => changePage(1)}
            disabled={pageNumber >= numPages}
            className="p-1.5 hover:bg-theme-text/10 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Next page"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={zoomOut}
            disabled={scale <= 0.5}
            className="p-1.5 hover:bg-theme-text/10 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Zoom out"
          >
            <ZoomOut size={16} />
          </button>
          <span className="text-sm text-theme-text/55 min-w-[50px] text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={zoomIn}
            disabled={scale >= 3}
            className="p-1.5 hover:bg-theme-text/10 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Zoom in"
          >
            <ZoomIn size={16} />
          </button>
          <button
            onClick={rotate}
            className="p-1.5 hover:bg-theme-text/10 rounded"
            title="Rotate"
          >
            <RotateCw size={16} />
          </button>
        </div>
      </div>

      {/* PDF Container */}
      <div
        ref={containerRef}
        data-testid="pdf-scroll-container"
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-auto flex justify-center bg-theme-text/10"
        style={{ overscrollBehaviorY: 'contain' }}
      >
        {loading && (
          <div className="flex items-center justify-center h-full">
            <div className="text-theme-text/65">Loading PDF...</div>
          </div>
        )}

        <Document
          key={filePath}
          file={filePath}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={(error) => {
            setError(error.message);
            setLoading(false);
          }}
          className="w-full flex flex-col items-center pt-3 pb-0"
        >
          {Array.from({ length: numPages }, (_, i) => (
            <div
              key={i}
              data-page-number={i + 1}
              className="mb-3 last:mb-0 bg-theme-bg border border-theme-border/20 paper-divider shadow-[0_3px_12px_rgba(16,16,16,0.12)]"
              style={{ scrollMarginTop: '8px', transform: `rotate(${rotation}deg)`, transformOrigin: 'center center' }}
            >
              <Page
                pageNumber={i + 1}
                scale={scale}
                onLoad={onPageLoaded}
                renderTextLayer={true}
                renderAnnotationLayer={true}
              />
            </div>
          ))}
        </Document>
      </div>
    </div>
  );
}
