import { useState, useRef } from 'react';
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

  function onDocumentLoadSuccess({ numPages }: { numPages: number }) {
    setNumPages(numPages);
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

  const handleScroll = () => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    scrollTimeoutRef.current = setTimeout(() => {
      if (containerRef.current && onScrollChange) {
        const scrollTop = containerRef.current.scrollTop;
        const scrollHeight = containerRef.current.scrollHeight;

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

      // Scroll to the page
      setTimeout(() => {
        if (containerRef.current) {
          const pageElement = containerRef.current.querySelector(`[data-page-number="${clamped}"]`) as HTMLElement;
          if (pageElement) {
            pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
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
      if (containerRef.current) {
        const pageElement = containerRef.current.querySelector(`[data-page-number="${clamped}"]`) as HTMLElement;
        if (pageElement) {
          pageElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    }, 50);
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <p>Failed to load PDF</p>
        <p className="text-sm mt-2">{error}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-100">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200">
        <div className="flex items-center gap-2">
          <button
            onClick={() => changePage(-1)}
            disabled={pageNumber <= 1}
            className="p-1.5 hover:bg-gray-100 rounded disabled:opacity-40 disabled:cursor-not-allowed"
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
              className="w-16 text-center text-sm border border-gray-300 rounded px-1 py-1"
            />
            <span className="text-sm text-gray-500">/ {numPages}</span>
          </div>

          <button
            onClick={() => changePage(1)}
            disabled={pageNumber >= numPages}
            className="p-1.5 hover:bg-gray-100 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Next page"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={zoomOut}
            disabled={scale <= 0.5}
            className="p-1.5 hover:bg-gray-100 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Zoom out"
          >
            <ZoomOut size={16} />
          </button>
          <span className="text-sm text-gray-500 min-w-[50px] text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={zoomIn}
            disabled={scale >= 3}
            className="p-1.5 hover:bg-gray-100 rounded disabled:opacity-40 disabled:cursor-not-allowed"
            title="Zoom in"
          >
            <ZoomIn size={16} />
          </button>
          <button
            onClick={rotate}
            className="p-1.5 hover:bg-gray-100 rounded"
            title="Rotate"
          >
            <RotateCw size={16} />
          </button>
        </div>
      </div>

      {/* PDF Container */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto flex justify-center bg-gray-500"
        style={{ scrollBehavior: 'smooth' }}
      >
        {loading && (
          <div className="flex items-center justify-center h-full">
            <div className="text-white">Loading PDF...</div>
          </div>
        )}

        <Document
          file={filePath}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={(error) => {
            setError(error.message);
            setLoading(false);
          }}
          className="mt-4"
        >
          {Array.from({ length: numPages }, (_, i) => (
            <div
              key={i}
              data-page-number={i + 1}
              className="mb-4 bg-white shadow-lg"
              style={{ transform: `rotate(${rotation}deg)`, transformOrigin: 'center center' }}
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
