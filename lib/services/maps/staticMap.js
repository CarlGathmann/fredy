/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import logger from '../logger.js';

/**
 * A small map picture of where a listing is, for notifications.
 *
 * A push notification can carry an address, but "Burgstraße 32, Hamm" means nothing to somebody new
 * to the city. A picture with a pin on it, and the user's own saved places next to it, answers
 * "where is that" at a glance and without opening anything.
 *
 * Rendered from raster tiles composited with sharp, so it needs no browser and no map API key. The
 * picture is drawn at twice its logical size from high-density tiles, so it stays sharp on a phone.
 *
 * Tiles come from OpenStreetMap, whose usage policy asks for a real User-Agent, modest volume and
 * attribution: a notification is a handful of tiles at most, tiles are cached in memory, and
 * adapters showing the picture must print {@link mapAttribution} next to it.
 * `FREDY_MAP_TILE_URL` points the renderer at another server instead (with `{z}`, `{x}`, `{y}`, and
 * optionally `{r}`, replaced by `@2x`).
 */

/**
 * @typedef {Object} TileSource
 * @property {string} url Template with `{z}`, `{x}`, `{y}` and optionally `{r}`.
 * @property {number} scale Pixel density of the tiles: 2 for `@2x` tiles of 512px.
 * @property {string} attribution
 */

/**
 * OpenStreetMap's standard tiles: keyless, and muted here (see {@link BASEMAP_MUTE}).
 * @type {TileSource}
 */
const DEFAULT_SOURCE = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  scale: 1,
  attribution: '© OpenStreetMap contributors',
};

/**
 * How much the basemap is toned down. OpenStreetMap's standard style is made to be read on its own
 * and is loud next to a pin: softened, the roads and districts stay legible and the pins and labels
 * are what the eye lands on.
 */
const BASEMAP_MUTE = { saturation: 0.35, brightness: 1.08 };

/** Logical size of the picture. The rendered JPEG is {@link OUTPUT_SCALE} times as large. */
const WIDTH = 640;
const HEIGHT = 400;
/** Pixel density of the rendered picture. */
export const OUTPUT_SCALE = 2;
const TILE_SIZE = 256;
/** Room kept free around the outermost pin, so no pin or label sits on the edge of the picture. */
const PADDING = 64;
const MIN_ZOOM = 9;
const MAX_ZOOM = 15;
const TILE_TIMEOUT_MS = 8000;
const TILE_CACHE_MAX = 300;
const USER_AGENT = 'Fredy/self-hosted (+https://github.com/orangecoding/fredy) static notification map';
const FONT = "'Liberation Sans', 'DejaVu Sans', Arial, Helvetica, sans-serif";

/** @type {Map<string, Buffer>} Insertion-ordered, so the first key is the least recently used. */
const tileCache = new Map();

/**
 * @typedef {Object} MapPoint
 * @property {number} lat
 * @property {number} lng
 * @property {'listing'|'place'} kind The listing gets a pin, a saved place a dot.
 * @property {string} [label] Short text shown next to the point.
 */

/**
 * Whether a value is a usable coordinate pair. `-1/-1` is what a failed geocode stores.
 *
 * @param {unknown} lat
 * @param {unknown} lng
 * @returns {boolean}
 */
export function isUsableCoordinate(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  if (lat == null || lng == null || !Number.isFinite(la) || !Number.isFinite(ln)) return false;
  if (la === -1 && ln === -1) return false;
  return Math.abs(la) <= 85 && Math.abs(ln) <= 180;
}

/**
 * Web Mercator world pixel coordinates at a zoom level, in logical (256px tile) pixels.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {number} zoom
 * @returns {{x: number, y: number}}
 */
export function project(lat, lng, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

/**
 * The closest zoom at which every point fits inside the picture, padding included.
 *
 * A lone listing gets {@link MAX_ZOOM} less one, which shows the street and the neighbourhood around
 * it. A listing far from the user's places is allowed down to {@link MIN_ZOOM}; past that the pins
 * would be specks, and the picture centres on the listing instead (see {@link computeViewport}).
 *
 * @param {MapPoint[]} points
 * @returns {number}
 */
export function fitZoom(points) {
  if (points.length <= 1) return MAX_ZOOM - 1;
  for (let zoom = MAX_ZOOM; zoom >= MIN_ZOOM; zoom--) {
    if (fits(points, zoom)) return zoom;
  }
  return MIN_ZOOM;
}

/**
 * @param {MapPoint[]} points
 * @param {number} zoom
 * @returns {boolean}
 */
function fits(points, zoom) {
  const projected = points.map((p) => project(p.lat, p.lng, zoom));
  const xs = projected.map((p) => p.x);
  const ys = projected.map((p) => p.y);
  return (
    Math.max(...xs) - Math.min(...xs) <= WIDTH - 2 * PADDING &&
    Math.max(...ys) - Math.min(...ys) <= HEIGHT - 2 * PADDING
  );
}

/**
 * Where the picture sits in the world: zoom, and the world pixel of its top-left corner.
 *
 * Centred on the middle of all points when they fit, otherwise on the listing alone, since the
 * listing is what the notification is about and a place cut off at the edge costs less than the pin.
 * The pin points down at its spot, so the centre is nudged down a little to keep the pin's head
 * from being the thing closest to the top edge.
 *
 * @param {MapPoint[]} points The listing first.
 * @returns {{zoom: number, left: number, top: number}} In logical pixels.
 */
export function computeViewport(points) {
  const zoom = fitZoom(points);
  const projected = points.map((p) => project(p.lat, p.lng, zoom));
  const xs = projected.map((p) => p.x);
  const ys = projected.map((p) => p.y);
  const all = fits(points, zoom);
  const cx = all ? (Math.max(...xs) + Math.min(...xs)) / 2 : projected[0].x;
  const cy = (all ? (Math.max(...ys) + Math.min(...ys)) / 2 : projected[0].y) - 14;
  return { zoom, left: Math.round(cx - WIDTH / 2), top: Math.round(cy - HEIGHT / 2) };
}

/**
 * The tile server to draw from: `FREDY_MAP_TILE_URL` when set, OpenStreetMap otherwise.
 *
 * @returns {TileSource}
 */
function tileSource() {
  const fromEnv = process.env.FREDY_MAP_TILE_URL;
  if (typeof fromEnv === 'string' && fromEnv.includes('{z}')) {
    return { url: fromEnv, scale: fromEnv.includes('{r}') ? 2 : 1, attribution: DEFAULT_SOURCE.attribution };
  }
  return DEFAULT_SOURCE;
}

/**
 * The credit an adapter must print next to the picture.
 *
 * @returns {string}
 */
export function mapAttribution() {
  return tileSource().attribution;
}

/**
 * One tile's bytes, from the cache or the tile server.
 *
 * @param {TileSource} source
 * @param {number} zoom
 * @param {number} x Already wrapped into the world.
 * @param {number} y
 * @returns {Promise<Buffer>}
 */
async function fetchTile(source, zoom, x, y) {
  const url = source.url
    .replace('{z}', String(zoom))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{r}', source.scale === 2 ? '@2x' : '');
  const cached = tileCache.get(url);
  if (cached) {
    tileCache.delete(url);
    tileCache.set(url, cached);
    return cached;
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
    headers: { 'User-Agent': USER_AGENT, Accept: 'image/png,image/*;q=0.8' },
  });
  if (!response.ok) {
    throw new Error(`Map tile returned HTTP ${response.status}: ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  tileCache.set(url, buffer);
  if (tileCache.size > TILE_CACHE_MAX) {
    tileCache.delete(tileCache.keys().next().value);
  }
  return buffer;
}

/**
 * Escape text for use inside SVG.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A rough width for a label, since there is no text measurement here. Errs wide: a pill with a
 * little too much room reads fine, one that clips its text does not.
 *
 * @param {string} text
 * @param {number} fontSize
 * @returns {number}
 */
function textWidth(text, fontSize) {
  return Math.ceil([...text].length * fontSize * 0.58);
}

/**
 * A rounded label with a soft shadow.
 *
 * @param {Object} args
 * @param {string} args.text
 * @param {number} args.x Anchor, in logical pixels.
 * @param {number} args.y Vertical centre, in logical pixels.
 * @param {'left'|'center'} args.align Whether the label starts at `x` or is centred on it.
 * @param {string} args.fill
 * @param {string} args.color
 * @returns {string}
 */
function pill({ text, x, y, align, fill, color }) {
  const fontSize = 13;
  const w = textWidth(text, fontSize) + 18;
  const h = 24;
  const left = Math.round(align === 'center' ? x - w / 2 : x);
  const clamped = Math.max(6, Math.min(WIDTH - w - 6, left));
  return (
    `<g filter="url(#shadow)">` +
    `<rect x="${clamped}" y="${y - h / 2}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>` +
    `</g>` +
    `<text x="${clamped + w / 2}" y="${y + 4.5}" text-anchor="middle" font-family="${FONT}" font-size="${fontSize}" font-weight="700" fill="${color}">${escapeXml(text)}</text>`
  );
}

/**
 * The pins and their labels, as an SVG laid over the tiles. Drawn in logical pixels and scaled by
 * {@link OUTPUT_SCALE}.
 *
 * @param {Array<{x: number, y: number, kind: string, label?: string}>} pins In logical picture pixels.
 * @returns {Buffer}
 */
function markerOverlay(pins) {
  const places = pins.filter((p) => p.kind === 'place');
  const listings = pins.filter((p) => p.kind === 'listing');

  const placeShapes = places.map(
    (p) =>
      `<g filter="url(#shadow)"><circle cx="${p.x}" cy="${p.y}" r="10" fill="#ffffff"/></g>` +
      `<circle cx="${p.x}" cy="${p.y}" r="7" fill="#2563eb"/>` +
      (p.label ? pill({ text: p.label, x: p.x + 16, y: p.y, align: 'left', fill: '#ffffff', color: '#1e3a8a' }) : ''),
  );

  // A teardrop whose tip touches the exact spot, drawn last so it is never hidden under a place.
  const listingShapes = listings.map(
    (p) =>
      `<ellipse cx="${p.x}" cy="${p.y}" rx="7" ry="2.5" fill="#000000" opacity="0.25"/>` +
      `<g filter="url(#shadow)" transform="translate(${p.x} ${p.y})">` +
      `<path d="M0 0 C -5 -11 -16 -18 -16 -30 A 16 16 0 1 1 16 -30 C 16 -18 5 -11 0 0 Z" fill="#e0453a" stroke="#ffffff" stroke-width="2.5"/>` +
      `</g>` +
      `<circle cx="${p.x}" cy="${p.y - 30}" r="6" fill="#ffffff"/>` +
      (p.label ? pill({ text: p.label, x: p.x, y: p.y - 62, align: 'center', fill: '#e0453a', color: '#ffffff' }) : ''),
  );

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH * OUTPUT_SCALE}" height="${HEIGHT * OUTPUT_SCALE}" viewBox="0 0 ${WIDTH} ${HEIGHT}">` +
      `<defs><filter id="shadow" x="-30%" y="-30%" width="160%" height="180%">` +
      `<feGaussianBlur in="SourceAlpha" stdDeviation="2"/><feOffset dy="1.5" result="b"/>` +
      `<feComponentTransfer><feFuncA type="linear" slope="0.35"/></feComponentTransfer>` +
      `<feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
      `${placeShapes.join('')}${listingShapes.join('')}</svg>`,
  );
}

/**
 * The tiles of the viewport from one source, positioned on the output canvas.
 *
 * @param {TileSource} source
 * @param {{zoom: number, left: number, top: number}} viewport
 * @returns {Promise<{tiles: Array<{input: Buffer, left: number, top: number}>, offsetX: number, offsetY: number, mosaicWidth: number, mosaicHeight: number}>}
 */
async function loadTiles(source, { zoom, left, top }) {
  const worldTiles = 2 ** zoom;
  const firstX = Math.floor(left / TILE_SIZE);
  const firstY = Math.floor(top / TILE_SIZE);
  const lastX = Math.floor((left + WIDTH - 1) / TILE_SIZE);
  const lastY = Math.floor((top + HEIGHT - 1) / TILE_SIZE);
  const tilePx = TILE_SIZE * OUTPUT_SCALE;

  const { default: sharp } = await import('sharp');
  const jobs = [];
  for (let ty = firstY; ty <= lastY; ty++) {
    for (let tx = firstX; tx <= lastX; tx++) {
      if (ty < 0 || ty >= worldTiles) continue;
      const wrappedX = ((tx % worldTiles) + worldTiles) % worldTiles;
      jobs.push(
        fetchTile(source, zoom, wrappedX, ty).then(async (bytes) => ({
          // A 256px tile on a 2x canvas is scaled up; a 512px one is placed as it is.
          input:
            source.scale === OUTPUT_SCALE
              ? bytes
              : await sharp(bytes).resize(tilePx, tilePx, { kernel: 'lanczos3' }).png().toBuffer(),
          left: (tx - firstX) * tilePx,
          top: (ty - firstY) * tilePx,
        })),
      );
    }
  }
  return {
    tiles: await Promise.all(jobs),
    offsetX: (left - firstX * TILE_SIZE) * OUTPUT_SCALE,
    offsetY: (top - firstY * TILE_SIZE) * OUTPUT_SCALE,
    mosaicWidth: (lastX - firstX + 1) * tilePx,
    mosaicHeight: (lastY - firstY + 1) * tilePx,
  };
}

/**
 * Render the map picture for one listing.
 *
 * @param {{lat: number, lng: number, label?: string}} listing Where the listing is, and an optional
 *   short label for its pin (the price, say).
 * @param {Array<{lat: number, lng: number, label?: string}>} [places] The user's saved places worth
 *   showing next to it, each with an optional label ("Work · 40 min").
 * @returns {Promise<Buffer>} A JPEG, {@link WIDTH}×{@link HEIGHT} at {@link OUTPUT_SCALE}x.
 * @throws {Error} When the coordinates are unusable, sharp is missing or a tile cannot be loaded.
 *   Callers send their notification without the map in that case.
 */
export async function renderListingMap(listing, places = []) {
  if (!isUsableCoordinate(listing?.lat, listing?.lng)) {
    throw new Error('Listing has no usable coordinates for a map');
  }
  /** @type {MapPoint[]} */
  const points = [
    { lat: Number(listing.lat), lng: Number(listing.lng), kind: 'listing', label: listing.label },
    ...places
      .filter((p) => isUsableCoordinate(p?.lat, p?.lng))
      .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), kind: /** @type {'place'} */ ('place'), label: p.label })),
  ];
  const viewport = computeViewport(points);

  const loaded = await loadTiles(tileSource(), viewport);

  const { default: sharp } = await import('sharp');
  const mosaic = await sharp({
    create: { width: loaded.mosaicWidth, height: loaded.mosaicHeight, channels: 3, background: '#f2efe9' },
  })
    .composite(loaded.tiles)
    .png()
    .toBuffer();

  const pins = points.map((p) => {
    const world = project(p.lat, p.lng, viewport.zoom);
    return {
      x: Math.round(world.x - viewport.left),
      y: Math.round(world.y - viewport.top),
      kind: p.kind,
      label: typeof p.label === 'string' && p.label.trim() !== '' ? p.label.trim() : undefined,
    };
  });

  const image = await sharp(mosaic)
    .extract({
      left: loaded.offsetX,
      top: loaded.offsetY,
      width: WIDTH * OUTPUT_SCALE,
      height: HEIGHT * OUTPUT_SCALE,
    })
    // Here and not on the mosaic: sharp runs `composite` last in a pipeline, so muting the mosaic's
    // own pipeline would mute the blank canvas before the tiles land on it. Here the tiles are
    // already flattened into the input, and the pins composited after it keep their colours.
    .modulate(BASEMAP_MUTE)
    .composite([{ input: markerOverlay(pins), left: 0, top: 0 }])
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  logger.debug(`Rendered notification map at zoom ${viewport.zoom} from ${loaded.tiles.length} tile(s)`);
  return image;
}

/** Forget every cached tile. For tests. */
export function clearTileCache() {
  tileCache.clear();
}
