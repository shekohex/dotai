import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from 'react';
import {
  OverlayScrollbarsComponent,
  type OverlayScrollbarsComponentRef,
} from 'overlayscrollbars-react';
import {
  OverlayScrollbars,
  ClickScrollPlugin,
  type EventListeners,
  type PartialOptions,
} from 'overlayscrollbars';
import 'overlayscrollbars/overlayscrollbars.css';

// Register the ClickScrollPlugin once. Without it, `clickScroll: true`
// silently does nothing — only `'instant'` works out of the box.
OverlayScrollbars.plugin(ClickScrollPlugin);

/**
 * Zed/VS Code-style overlay scrollbar wrapper around `overlayscrollbars-react`.
 *
 * - Wide (10px rest, 14px hover), translucent, full-length track
 * - Click anywhere on the track to page-animate toward the click
 * - Always visible when there's overflow (no auto-hide, no fade) —
 *   matches the persistent-scrollbar pattern used by every editor-class
 *   technical app (VS Code, Zed, JetBrains, Xcode, Sublime)
 * - Auto-recomputes scrollbar visibility when the content box size
 *   changes (via a ResizeObserver on the viewport's first child).
 *   Catches growth caused by DOM mutations inside a shadow root —
 *   e.g. @pierre/diffs expanding context lines — which the library's
 *   own observers miss.
 * - No layout shift (overlay, not classic scrollbar)
 * - Hidden in print via `print.css`
 *
 * `prefers-reduced-motion` is honored via a CSS media query in `theme.css`
 * that disables the hover color + width/height transitions on the track
 * and handle. The browser evaluates that rule independently — there's no
 * React-level branch on motion preference inside this component.
 *
 * Exposes the library's internal *viewport* element (the node that actually
 * scrolls) via the `onViewportReady` callback (preferred) or an imperative
 * ref handle. Downstream code that needs a scroll container — `IntersectionObserver`
 * roots, scroll event listeners, `scrollTo` / offset math — should consume
 * the viewport from this handle or from `ScrollViewportContext`, never from
 * `document.querySelector('main')`.
 */
export interface OverlayScrollAreaHandle {
  /** The DOM element that actually scrolls, or null before init. */
  getViewport(): HTMLElement | null;
}

export interface OverlayScrollAreaProps
  extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  /** Root element tag (default 'div'). Use 'main' for the primary plan viewport. */
  element?: ElementType;
  children?: ReactNode;
  /**
   * Called when the library's internal viewport element becomes available,
   * and again with `null` when it's torn down. This is the only correct way
   * to get a reference to the scrolling element — it fires from the library's
   * own `initialized` / `destroyed` events, which handle the deferred init
   * timing that ref callbacks cannot observe.
   */
  onViewportReady?: (viewport: HTMLElement | null) => void;
  /** Horizontal overflow behavior (default 'hidden'). */
  overflowX?: 'hidden' | 'scroll' | 'visible';
  /** Vertical overflow behavior (default 'scroll'). */
  overflowY?: 'hidden' | 'scroll' | 'visible';
}

export const OverlayScrollArea = forwardRef<
  OverlayScrollAreaHandle,
  OverlayScrollAreaProps
>(function OverlayScrollArea(
  {
    element = 'div',
    children,
    onViewportReady,
    overflowX = 'hidden',
    overflowY = 'scroll',
    ...rest
  },
  ref,
) {
  const osRef = useRef<OverlayScrollbarsComponentRef<ElementType> | null>(null);
  const lastViewportRef = useRef<HTMLElement | null>(null);
  const [instance, setInstance] = useState<OverlayScrollbars | null>(null);

  const getViewport = useCallback((): HTMLElement | null => {
    // Prefer our tracked viewport (delivered via `initialized` event) over
    // asking the imperative handle, which can return null if the consumer
    // reads before the library has finished its deferred init.
    return (
      lastViewportRef.current ??
      osRef.current?.osInstance()?.elements().viewport ??
      null
    );
  }, []);

  useImperativeHandle(ref, () => ({ getViewport }), [getViewport]);

  const options = useMemo<PartialOptions>(
    () => ({
      scrollbars: {
        theme: 'os-theme-plannotator',
        // Always visible — Zed / VS Code / JetBrains pattern. Overlay
        // scrollbars cost zero layout space, so persistent visibility
        // has no downside for a technical doc / code review app where
        // users rely on the scrollbar as both a position indicator and
        // a targeting surface. No surprise disappearances on trackpad
        // scroll while the pointer is outside the viewport.
        autoHide: 'never',
        // `true` = animate one page-step toward the click (website-style,
        // requires ClickScrollPlugin registered above). `'instant'` would
        // jump straight to the clicked spot.
        clickScroll: true,
        dragScroll: true,
      },
      overflow: {
        x: overflowX,
        y: overflowY,
      },
    }),
    [overflowX, overflowY],
  );

  // CRITICAL: deliver the viewport element via the library's own
  // `initialized` / `destroyed` events, NOT via the React ref callback.
  //
  // Why: `OverlayScrollbarsComponent` uses `useImperativeHandle` to expose
  // `{ osInstance, getElement }`. That handle is set during commit, at which
  // point the library's own setup effect has not yet run — so `osInstance()`
  // returns `null`. With `defer: true` it's even worse (setup is queued in
  // `requestIdleCallback`). There is no mechanism to retrigger a React ref
  // callback after the instance finishes initializing.
  //
  // The `events.initialized` handler fires exactly when elements are ready,
  // and `events.destroyed` fires on unmount/teardown. Together they give us
  // the full lifecycle the ref callback can't observe.
  const events = useMemo<EventListeners>(
    () => ({
      initialized: (osInstance) => {
        const viewport = osInstance.elements().viewport;
        if (viewport === lastViewportRef.current) return;
        lastViewportRef.current = viewport;
        setInstance(osInstance);
        onViewportReady?.(viewport);
      },
      destroyed: () => {
        if (lastViewportRef.current === null) return;
        lastViewportRef.current = null;
        setInstance(null);
        onViewportReady?.(null);
      },
    }),
    [onViewportReady],
  );

  // Force an OverlayScrollbars recompute whenever the content element's
  // box size changes. The library's own size observation is keyed off the
  // host/viewport element, which has a fixed layout size (flex-1) and
  // doesn't grow when content does. Observing the viewport's first child
  // instead catches content-driven growth — including growth caused by
  // DOM mutations inside a shadow root (e.g. @pierre/diffs expanding
  // context lines), because layout propagates from shadow tree to host.
  //
  // rAF defers the update() call one frame, giving the browser time to
  // commit layout after the mutation that triggered the resize.
  useEffect(() => {
    if (!instance) return;
    const viewport = instance.elements().viewport;
    const content = viewport.firstElementChild;
    if (!content) return;

    let rafId = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => instance.update(true));
    });
    observer.observe(content);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [instance]);

  const handleOsRef = useCallback(
    (node: OverlayScrollbarsComponentRef<ElementType> | null) => {
      osRef.current = node;
    },
    [],
  );

  return (
    <OverlayScrollbarsComponent
      ref={handleOsRef as React.RefCallback<OverlayScrollbarsComponentRef<'div'>>}
      element={element as 'div'}
      options={options}
      events={events}
      defer
      {...rest}
    >
      {children}
    </OverlayScrollbarsComponent>
  );
});
