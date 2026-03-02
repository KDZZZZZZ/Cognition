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
  Page: ({ pageNumber, onLoad }: { pageNumber: number; onLoad?: () => void }) => {
    useEffect(() => {
      onLoad?.();
    }, [onLoad]);
    return <div>Page {pageNumber}</div>;
  },
}));

describe('PDFViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    documentCalls.length = 0;
    HTMLElement.prototype.scrollTo = vi.fn();
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
    documentCalls[0]?.onLoadSuccess?.({ numPages: 3 });

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
    documentCalls[0]?.onLoadError?.(new Error('broken pdf'));

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
});
