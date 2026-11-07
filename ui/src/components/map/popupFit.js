/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/** Gap kept between a popup and the edge of the map. */
const POPUP_VIEWPORT_PADDING = 12;

/** When to check the fit again, in milliseconds after opening, for content that loads late. */
const REFIT_DELAYS = [120, 400, 1000, 2000];

/**
 * Pans the map until the popup fits into it.
 *
 * MapLibre places a popup relative to its marker and lets it hang off the map, which for the taller
 * listing popups means half of one is cut off at the bottom. The popup also grows after it opened -
 * the nearby stops arrive later - so this keeps watching its size for as long as it is open.
 *
 * Until the person moves the map themselves. From then on where the popup sits is their decision:
 * dragging it towards an edge flips MapLibre's anchor, which resizes the popup, and the departure
 * board re-renders every minute. Both fired the fit again, and the map snapped back under the hand
 * that was dragging it, so with a popup open the map could not be moved at all. Any move that comes
 * from an input event (drag, wheel, pinch, keyboard) ends the watching; the fit's own `panBy` has no
 * input event behind it and does not.
 *
 * @param {import('maplibre-gl').Map} map
 * @param {import('maplibre-gl').Popup} popup
 * @returns {() => void} Stops watching. Called automatically when the popup closes.
 */
export function keepPopupInView(map, popup) {
  let stopped = false;
  const fit = () => {
    if (stopped) return;
    const element = popup.getElement();
    if (!element || !map.getContainer()) return;

    const view = map.getContainer().getBoundingClientRect();
    const box = element.getBoundingClientRect();

    // Positive values move the map content the other way, which is what panBy expects.
    let x = 0;
    let y = 0;
    if (box.bottom > view.bottom - POPUP_VIEWPORT_PADDING) y = box.bottom - (view.bottom - POPUP_VIEWPORT_PADDING);
    if (box.top - y < view.top + POPUP_VIEWPORT_PADDING) y = box.top - (view.top + POPUP_VIEWPORT_PADDING);
    if (box.right > view.right - POPUP_VIEWPORT_PADDING) x = box.right - (view.right - POPUP_VIEWPORT_PADDING);
    if (box.left - x < view.left + POPUP_VIEWPORT_PADDING) x = box.left - (view.left + POPUP_VIEWPORT_PADDING);

    if (x !== 0 || y !== 0) {
      map.panBy([x, y], { duration: 200 });
    }
  };

  fit();

  // The popup grows after it opened: the departure board and the nearby stops are fetched. A
  // ResizeObserver is the obvious tool, but it is not delivered everywhere, so the fit is simply
  // repeated over the window in which that content can realistically arrive.
  const timers = REFIT_DELAYS.map((delay) => setTimeout(fit, delay));

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
  const element = popup.getElement();
  if (observer && element) {
    observer.observe(element);
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    timers.forEach(clearTimeout);
    observer?.disconnect();
    map.off('movestart', onMoveStart);
    popup.off?.('close', stop);
  };
  /** @param {{originalEvent?: Event}} event */
  function onMoveStart(event) {
    if (event?.originalEvent) stop();
  }
  map.on('movestart', onMoveStart);
  popup.on('close', stop);

  return stop;
}
