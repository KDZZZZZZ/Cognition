import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFViewer } from '../PDFViewer';

const documentCalls: Array<{ onLoadSuccess?: (data: { numPages: number }) => void; onLoadError?: (err: Error) => void }> = [];

vi.mock('react-pdf', () => ({
  pdfjs: { version: '4.0.0', GlobalWorkerOptions: { workerSrc: '' } },
  Document: ({ children, onLoadSuccess, onLoadError }: any) => {
    documentCalls.push({ onLoadSuccess, onLoadError });
    return <div data-testid="mock-document">{children}</div>;
  },
  Page: ({ pageNumber, onLoad, width }: { pageNumber: number; onLoad?: () => void; width?: number }) => {
    useEffect(() => {
      onLoad?.();
    }, [onLoad]);
    return <div data-testid={`mock-page-${pageNumber}`} data-width={width}>Page {pageNumber}</div>;
  },
}));

function mockPageRects(container: HTMLElement, activePage: number) {
  const pages = Array.from(container.querySelectorAll<HTMLElement>('[data-page-number]'));
  pages.forEach((page) => {
    const pageNumber = Number(page.dataset.pageNumber);
    const offset = (pageNumber - activePage) * 500;
    Object.defineProperty(page, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          top: offset,
          bottom: offset + 400,
          left: 0,
          right: 300,
          width: 300,
          height: 400,
          x: 0,
          y: offset,
          toJSON: () => ({}),
        }) as DOMRect,
    });
  });
  Object.defineProperty(container, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        top: 0,
        bottom: 600,
        left: 0,
        right: 400,
        width: 400,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  });
}

describe('PDFViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    documentCalls.length = 0;
    HTMLElement.prototype.scrollTo = vi.fn();
    vi.stubGlobal('ResizeObserver', undefined);
  });

  it('loads document and supports page/zoom/rotate interactions', async () => {
    const onPageChange = vi.fn();
    const onScrollChange = vi.fn();

    render(
      <PDFViewer
        fileId="f1"
        filePath="/uploads/test.pdf"
        onPageChange={onPageChange}
        onScrollChange={onScrollChange}
      />
    );

    expect(screen.getByText('Loading PDF...')).toBeInTheDocument();
    act(() => {
      documentCalls[0]?.onLoadSuccess?.({ numPages: 3 });
    });

    await waitFor(() => {
      expect(screen.getByText('/ 3')).toBeInTheDocument();
      expect(screen.getByText('Page 1')).toBeInTheDocument();
      expect(screen.getByText('Page 2')).toBeInTheDocument();
      expect(screen.getByText('Page 3')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Next page'));
    fireEvent.click(screen.getByTitle('Zoom in'));
    fireEvent.click(screen.getByTitle('Zoom out'));
    fireEvent.click(screen.getByTitle('Rotate'));

    const pageInput = screen.getByRole('spinbutton');
    fireEvent.change(pageInput, { target: { value: '3' } });

    const scrollContainer = screen.getByTestId('pdf-scroll-container');
    mockPageRects(scrollContainer, 2);
    Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(scrollContainer, 'scrollTop', { configurable: true, value: 600 });
    fireEvent.scroll(scrollContainer);

    await waitFor(() => {
      expect(onPageChange).toHaveBeenCalled();
      expect(onScrollChange).toHaveBeenCalled();
    });
  });

  it('renders error state when document loading fails', async () => {
    render(<PDFViewer fileId="f2" filePath="/uploads/error.pdf" />);
    act(() => {
      documentCalls[0]?.onLoadError?.(new Error('broken pdf'));
    });

    await waitFor(() => {
      expect(screen.getByText('Failed to load PDF')).toBeInTheDocument();
      expect(screen.getByText('broken pdf')).toBeInTheDocument();
    });
  });

  it('covers scroll guards, timeout cleanup, and missing page element branches', async () => {
    vi.useFakeTimers();
    const onPageChange = vi.fn();
    const onScrollChange = vi.fn();

    const { unmount } = render(
      <PDFViewer
        fileId="f3"
        filePath="/uploads/branch.pdf"
        onPageChange={onPageChange}
        onScrollChange={onScrollChange}
      />
    );

    const scrollContainer = screen.getByTestId('pdf-scroll-container');
    Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(scrollContainer, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(scrollContainer, 'scrollTop', { configurable: true, value: 10 });

    // numPages is 0 before load success; should early-return inside debounced handler
    fireEvent.scroll(scrollContainer);
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onScrollChange).not.toHaveBeenCalled();

    act(() => {
      documentCalls[0]?.onLoadSuccess?.({ numPages: 2 });
    });
    expect(screen.getByText('/ 2')).toBeInTheDocument();
    mockPageRects(scrollContainer, 1);

    // same page should not trigger onPageChange branch
    onPageChange.mockClear();
    Object.defineProperty(scrollContainer, 'scrollTop', { configurable: true, value: 0 });
    fireEvent.scroll(scrollContainer);
    fireEvent.scroll(scrollContainer);
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onPageChange).not.toHaveBeenCalled();

    // move to a later page via scroll
    mockPageRects(scrollContainer, 2);
    Object.defineProperty(scrollContainer, 'scrollTop', { configurable: true, value: 900 });
    fireEvent.scroll(scrollContainer);
    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(onPageChange).toHaveBeenCalled();

    const querySpy = vi.spyOn(scrollContainer, 'querySelector').mockReturnValueOnce(null);
    fireEvent.click(screen.getByTitle('Previous page'));
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(querySpy).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle('Next page'));
    unmount();
    act(() => {
      vi.advanceTimersByTime(60);
    });

    vi.useRealTimers();
  });

  it('window-renders large PDFs instead of mounting every page at once', async () => {
    render(<PDFViewer fileId="f4" filePath="/uploads/large.pdf" />);
    act(() => {
      documentCalls[0]?.onLoadSuccess?.({ numPages: 8 });
    });

    await waitFor(() => {
      expect(screen.getByText('Page 1')).toBeInTheDocument();
      expect(screen.getByText('Page 2')).toBeInTheDocument();
    });
    expect(screen.queryByText('Page 4')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } });

    await waitFor(() => {
      expect(screen.getByText('Page 5')).toBeInTheDocument();
    });
    expect(screen.queryByText('Page 1')).not.toBeInTheDocument();
  });

  it('fits rendered pages to the viewer width', async () => {
    vi.useFakeTimers();
    try {
      render(<PDFViewer fileId="f5" filePath="/uploads/fit.pdf" />);
      const scrollContainer = screen.getByTestId('pdf-scroll-container');
      Object.defineProperty(scrollContainer, 'clientWidth', { configurable: true, value: 480 });

      act(() => {
        documentCalls[0]?.onLoadSuccess?.({ numPages: 1 });
        window.dispatchEvent(new Event('resize'));
      });

      act(() => {
        vi.advanceTimersByTime(180);
      });

      expect(screen.getByTestId('mock-page-1')).toHaveAttribute('data-width', '448');

      Object.defineProperty(scrollContainer, 'clientWidth', { configurable: true, value: 600 });
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });

      expect(screen.getByTestId('mock-page-1')).toHaveAttribute('data-width', '448');

      act(() => {
        vi.advanceTimersByTime(180);
      });

      expect(screen.getByTestId('mock-page-1')).toHaveAttribute('data-width', '568');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports virtual scroll height against the full PDF length', async () => {
    const onScrollChange = vi.fn();

    render(
      <PDFViewer
        fileId="f6"
        filePath="/uploads/virtual-scroll.pdf"
        onScrollChange={onScrollChange}
      />
    );

    act(() => {
      documentCalls[0]?.onLoadSuccess?.({ numPages: 8 });
    });

    await waitFor(() => {
      expect(screen.getByText('/ 8')).toBeInTheDocument();
      expect(screen.getByText('Page 1')).toBeInTheDocument();
      expect(screen.getByText('Page 2')).toBeInTheDocument();
      expect(screen.getByText('Page 3')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '5' } });

    await waitFor(() => {
      expect(screen.getByText('Page 5')).toBeInTheDocument();
    });

    onScrollChange.mockClear();

    const scrollContainer = screen.getByTestId('pdf-scroll-container');
    mockPageRects(scrollContainer, 5);
    Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 1200 });
    Object.defineProperty(scrollContainer, 'clientHeight', { configurable: true, value: 600 });
    Object.defineProperty(scrollContainer, 'scrollTop', { configurable: true, value: 200 });

    fireEvent.scroll(scrollContainer);

    await waitFor(() => {
      expect(onScrollChange).toHaveBeenCalled();
    });

    const virtualMetricsCall = onScrollChange.mock.calls.find(([, scrollHeight]) => scrollHeight === 3200);
    expect(virtualMetricsCall).toBeTruthy();
    expect(virtualMetricsCall?.[0]).toBeGreaterThan(1200);
  });
});
