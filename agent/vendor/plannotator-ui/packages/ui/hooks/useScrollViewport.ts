import { createContext, useContext } from 'react';

/**
 * Provides the currently-active scroll viewport element to descendants.
 *
 * When the app is wrapped in <OverlayScrollArea>, the element that actually
 * scrolls is the library's internal viewport div — not <main>. Any code that
 * needs the scroll container (IntersectionObserver roots, scroll event
 * listeners, scrollTo / getBoundingClientRect offsets) must consume this
 * context instead of `document.querySelector('main')`.
 *
 * The value is `null` until the OverlayScrollbars instance has mounted and
 * initialized. Consumers should handle that transient state.
 */
export const ScrollViewportContext = createContext<HTMLElement | null>(null);

/** Returns the active scroll viewport element, or `null` before it mounts. */
export function useScrollViewport(): HTMLElement | null {
  return useContext(ScrollViewportContext);
}
