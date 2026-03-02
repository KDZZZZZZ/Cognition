import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!('ResizeObserver' in window)) {
  // jsdom lacks this API by default.
  // @ts-expect-error runtime polyfill for tests.
  window.ResizeObserver = ResizeObserverMock;
}

const memoryStorage = (() => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
  };
})();

if (
  typeof window.localStorage === 'undefined' ||
  typeof window.localStorage.setItem !== 'function'
) {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: memoryStorage,
  });
}
