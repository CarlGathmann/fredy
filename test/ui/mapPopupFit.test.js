/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepPopupInView } from '../../ui/src/components/map/popupFit.js';

/** A tiny event emitter standing in for a MapLibre map or popup. */
function emitter(extra) {
  const handlers = new Map();
  return {
    ...extra,
    on(name, fn) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    off(name, fn) {
      handlers.set(
        name,
        (handlers.get(name) ?? []).filter((h) => h !== fn),
      );
    },
    fire(name, event = {}) {
      (handlers.get(name) ?? []).forEach((fn) => fn(event));
    },
  };
}

/** A popup hanging 100px off the bottom of a 500px map, so every fit wants to pan. */
function setup() {
  const map = emitter({
    panBy: vi.fn(),
    getContainer: () => ({ getBoundingClientRect: () => ({ top: 0, left: 0, right: 800, bottom: 500 }) }),
  });
  const popup = emitter({
    getElement: () => ({ getBoundingClientRect: () => ({ top: 300, left: 100, right: 400, bottom: 600 }) }),
  });
  return { map, popup };
}

describe('keepPopupInView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pans a popup that hangs off the map back into view, and again while its content loads', () => {
    const { map, popup } = setup();
    keepPopupInView(map, popup);
    expect(map.panBy).toHaveBeenCalledTimes(1);
    expect(map.panBy.mock.calls[0][0]).toEqual([0, 112]);
    vi.advanceTimersByTime(2000);
    expect(map.panBy).toHaveBeenCalledTimes(5);
  });

  it('stops pulling the map back once the person moves it themselves', () => {
    const { map, popup } = setup();
    keepPopupInView(map, popup);
    map.fire('movestart', { originalEvent: { type: 'mousedown' } });
    vi.advanceTimersByTime(2000);
    expect(map.panBy).toHaveBeenCalledTimes(1);
  });

  it('is not stopped by its own pan, which has no input event behind it', () => {
    const { map, popup } = setup();
    keepPopupInView(map, popup);
    map.fire('movestart', {});
    vi.advanceTimersByTime(2000);
    expect(map.panBy).toHaveBeenCalledTimes(5);
  });

  it('stops when the popup closes and lets go of the map', () => {
    const { map, popup } = setup();
    keepPopupInView(map, popup);
    popup.fire('close');
    vi.advanceTimersByTime(2000);
    expect(map.panBy).toHaveBeenCalledTimes(1);
  });
});
