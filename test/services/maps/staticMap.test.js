/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  clearTileCache,
  mapAttribution,
  computeViewport,
  fitZoom,
  isUsableCoordinate,
  project,
  renderListingMap,
} from '../../../lib/services/maps/staticMap.js';

const ALTONA = { lat: 53.5440176, lng: 9.9436589 };
const HAMM = { lat: 53.5537, lng: 10.0436 };

/** One plain 256px tile, as a tile server would answer. */
async function tileResponse() {
  const png = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#aaccee' } })
    .png()
    .toBuffer();
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length),
  };
}

describe('staticMap', () => {
  describe('isUsableCoordinate', () => {
    it('accepts a real coordinate', () => {
      expect(isUsableCoordinate(ALTONA.lat, ALTONA.lng)).toBe(true);
    });

    it('refuses what a failed geocode or a missing value leaves behind', () => {
      expect(isUsableCoordinate(-1, -1)).toBe(false);
      expect(isUsableCoordinate(null, 10)).toBe(false);
      expect(isUsableCoordinate(undefined, undefined)).toBe(false);
      expect(isUsableCoordinate('abc', 10)).toBe(false);
      expect(isUsableCoordinate(91, 10)).toBe(false);
    });
  });

  describe('project', () => {
    it('puts 0/0 in the middle of the world', () => {
      expect(project(0, 0, 0)).toEqual({ x: 128, y: 128 });
      expect(project(0, 0, 1)).toEqual({ x: 256, y: 256 });
    });
  });

  describe('fitZoom', () => {
    it('shows a lone listing at street level', () => {
      expect(fitZoom([{ ...ALTONA, kind: 'listing' }])).toBe(14);
    });

    it('zooms out until the listing and a saved place both fit', () => {
      const zoom = fitZoom([
        { ...HAMM, kind: 'listing' },
        { ...ALTONA, kind: 'place' },
      ]);
      expect(zoom).toBeGreaterThanOrEqual(11);
      expect(zoom).toBeLessThan(14);
    });

    it('stops zooming out at a level where the pins are still readable', () => {
      expect(
        fitZoom([
          { lat: 53.55, lng: 10, kind: 'listing' },
          { lat: 48.13, lng: 11.58, kind: 'place' },
        ]),
      ).toBe(9);
    });
  });

  describe('computeViewport', () => {
    it('keeps the listing inside the picture when the places are too far away to fit', () => {
      const listing = { lat: 53.55, lng: 10, kind: 'listing' };
      const { zoom, left, top } = computeViewport([listing, { lat: 48.13, lng: 11.58, kind: 'place' }]);
      const p = project(listing.lat, listing.lng, zoom);
      expect(p.x - left).toBeCloseTo(320, 0);
      // Nudged down 14px so the pin, which points down at its spot, sits in the visual middle.
      expect(p.y - top).toBeCloseTo(214, 0);
    });
  });

  describe('renderListingMap', () => {
    let fetchMock;

    beforeEach(() => {
      clearTileCache();
      fetchMock = vi.fn(() => tileResponse());
      vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('renders a JPEG of the listing and the saved place', async () => {
      const jpeg = await renderListingMap(HAMM, [ALTONA]);
      const meta = await sharp(jpeg).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(1280);
      expect(meta.height).toBe(800);
      expect(fetchMock).toHaveBeenCalled();
      expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
      expect(mapAttribution()).toBe('© OpenStreetMap contributors');
      expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toMatch(/Fredy/);
    });

    it('asks the tile server only once for tiles it has already seen', async () => {
      await renderListingMap(HAMM, [ALTONA]);
      const first = fetchMock.mock.calls.length;
      await renderListingMap(HAMM, [ALTONA]);
      expect(fetchMock.mock.calls.length).toBe(first);
    });

    it('refuses a listing without coordinates', async () => {
      await expect(renderListingMap({ lat: -1, lng: -1 })).rejects.toThrow(/coordinates/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('uses a tile server named in FREDY_MAP_TILE_URL, high-density when it says so', async () => {
      vi.stubEnv('FREDY_MAP_TILE_URL', 'https://tiles.example.com/{z}/{x}/{y}{r}.png');
      try {
        const jpeg = await renderListingMap(HAMM);
        expect((await sharp(jpeg).metadata()).width).toBe(1280);
        expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/tiles\.example\.com\/\d+\/\d+\/\d+@2x\.png$/);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('fails when no tile server answers, so the caller can send without the map', async () => {
      fetchMock.mockImplementation(async () => ({ ok: false, status: 429 }));
      await expect(renderListingMap(HAMM)).rejects.toThrow(/429/);
    });

    it('draws labels with characters that would break the SVG', async () => {
      const jpeg = await renderListingMap({ ...HAMM, label: '<1.100 € & more>' }, [{ ...ALTONA, label: 'A "B"' }]);
      expect((await sharp(jpeg).metadata()).format).toBe('jpeg');
    });
  });
});
