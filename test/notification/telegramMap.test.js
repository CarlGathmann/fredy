/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('p-throttle', () => ({ default: () => (fn) => fn }));
vi.mock('../../lib/services/storage/jobStorage.js', () => ({
  getJob: (jobKey) => ({ id: jobKey, name: jobKey }),
}));
vi.mock('../../lib/services/markdown.js', () => ({ readAdapterReadme: () => '' }));
vi.mock('../../lib/services/maps/staticMap.js', async (importOriginal) => ({
  ...(await importOriginal()),
  renderListingMap: vi.fn(),
}));
vi.mock('../../lib/services/listings/listingPictures.js', () => ({ fetchListingPicture: vi.fn() }));

const jsonOk = () => ({ ok: true, status: 200, text: async () => '{"ok":true}' });
const jsonErr = (status) => ({ ok: false, status, text: async () => '{"ok":false}' });

const baseConfig = { id: 'telegram', fields: { token: 'TKN', chatId: '999' } };

/** A Kleinanzeigen listing as the pipeline hands it over: formatted, located and with a commute. */
const listing = {
  id: 'abc',
  title: 'Sonnige Zweizimmerwohnung',
  link: 'https://www.kleinanzeigen.de/s-anzeige/sonnige-zweizimmerwohnung/3564230013-203-9425',
  address: 'Burgstraße 32, 20535 Hamburg',
  price: '1.100 €',
  size: '53 m²',
  commute: 'Work: 40 min transit (1 change)',
  latitude: 53.5537,
  longitude: 10.0436,
  image: 'https://img.kleinanzeigen.de/api/v1/prod-ads/images/69/691e3acf?rule=$_1.AUTO',
};

let mockNodeFetch;
let renderListingMap;
let fetchListingPicture;
let send;
let jpeg;

beforeEach(async () => {
  vi.resetModules();
  mockNodeFetch = (await import('node-fetch')).default;
  mockNodeFetch.mockReset();
  vi.stubGlobal('fetch', vi.fn());
  ({ renderListingMap } = await import('../../lib/services/maps/staticMap.js'));
  ({ fetchListingPicture } = await import('../../lib/services/listings/listingPictures.js'));
  renderListingMap.mockReset();
  fetchListingPicture.mockReset();
  jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } })
    .jpeg()
    .toBuffer();
  ({ send } = await import('../../lib/notification/adapter/telegram.js'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('telegram send() - map album', () => {
  it('sends the photo and the map together as one album', async () => {
    renderListingMap.mockResolvedValue(jpeg);
    fetchListingPicture.mockResolvedValue({ buffer: jpeg, mimeType: 'image/jpeg', url: listing.image });
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({ serviceName: 'kleinanzeigen', newListings: [listing], notificationConfig: [baseConfig], jobKey: 'J' });

    expect(mockNodeFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockNodeFetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTKN/sendMediaGroup');
    const media = JSON.parse(opts.body.get('media'));
    expect(media.map((m) => m.media)).toEqual(['attach://photo', 'attach://map']);
    expect(media[0].parse_mode).toBe('HTML');
    expect(media[0].caption).toContain('🚆 Work: 40 min transit (1 change)');
    expect(media[0].caption).toContain(`<a href='${listing.link}'>Open on kleinanzeigen.de</a>`);
    expect(media[0].caption).toContain('Map © OpenStreetMap contributors');
    expect(opts.body.get('photo').size).toBeGreaterThan(0);
    expect(opts.body.get('map').size).toBeGreaterThan(0);
    expect(renderListingMap).toHaveBeenCalledWith(
      { lat: listing.latitude, lng: listing.longitude, label: '1.100 €' },
      [],
    );
  });

  it('sends the map alone with the caption when the photo cannot be had', async () => {
    renderListingMap.mockResolvedValue(jpeg);
    fetchListingPicture.mockRejectedValue(new Error('gone'));
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({ serviceName: 'kleinanzeigen', newListings: [listing], notificationConfig: [baseConfig], jobKey: 'J' });

    const [url, opts] = mockNodeFetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTKN/sendPhoto');
    expect(opts.body.get('photo').name).toBe('map.jpg');
    expect(opts.body.get('caption')).toContain('Open on kleinanzeigen.de');
  });

  it('sends the listing the usual way when the map cannot be rendered', async () => {
    renderListingMap.mockRejectedValue(new Error('tile server down'));
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({ serviceName: 'kleinanzeigen', newListings: [listing], notificationConfig: [baseConfig], jobKey: 'J' });

    expect(mockNodeFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockNodeFetch.mock.calls[0];
    expect(url).toBe('https://api.telegram.org/botTKN/sendPhoto');
    expect(JSON.parse(opts.body).photo).toBe(listing.image);
  });

  it('attaches no map when the channel says so', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'kleinanzeigen',
      newListings: [listing],
      notificationConfig: [{ id: 'telegram', fields: { ...baseConfig.fields, hideMap: true } }],
      jobKey: 'J',
    });

    expect(renderListingMap).not.toHaveBeenCalled();
    expect(mockNodeFetch.mock.calls[0][0]).toBe('https://api.telegram.org/botTKN/sendPhoto');
  });

  it('attaches no map to a listing without a location', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'wgGesucht',
      newListings: [{ ...listing, latitude: null, longitude: null }],
      notificationConfig: [baseConfig],
      jobKey: 'J',
    });

    expect(renderListingMap).not.toHaveBeenCalled();
  });
});

describe('labelPlaces', () => {
  it('names each place with the travel time from the listing', async () => {
    const { labelPlaces } = await import('../../lib/notification/adapter/telegram.js');
    const places = [
      { lat: 1, lng: 2, name: 'Work', mode: 'transit' },
      { lat: 3, lng: 4, name: 'Gym', mode: 'bike' },
    ];
    const travelTimes = [{ label: 'Work', mode: 'transit', transit: { minutes: 40, transfers: 1 } }];
    expect(labelPlaces(places, travelTimes)).toEqual([
      { lat: 1, lng: 2, label: 'Work · 40 min' },
      { lat: 3, lng: 4, label: 'Gym' },
    ]);
  });
});

describe('telegram send() - links', () => {
  it('leaves out the Fredy link when Fredy is only reachable inside Docker', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'kleinanzeigen',
      newListings: [{ ...listing, image: null }],
      notificationConfig: [{ id: 'telegram', fields: { ...baseConfig.fields, hideMap: true } }],
      jobKey: 'J',
      baseUrl: 'http://172.17.0.1:9998',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.text).not.toContain('172.17.0.1');
    expect(body.text).toContain('Open on kleinanzeigen.de');
  });

  it('keeps the Fredy link for a base url a phone can open', async () => {
    mockNodeFetch.mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'kleinanzeigen',
      newListings: [{ ...listing, image: null }],
      notificationConfig: [{ id: 'telegram', fields: { ...baseConfig.fields, hideMap: true } }],
      jobKey: 'J',
      baseUrl: 'https://fredy.example.com',
    });

    const body = JSON.parse(mockNodeFetch.mock.calls[0][1].body);
    expect(body.text).toContain("<a href='https://fredy.example.com/#/listings/listing/abc'>Open in Fredy</a>");
  });

  it('uploads the photo itself when Telegram cannot fetch it by url', async () => {
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.length),
    });
    mockNodeFetch.mockResolvedValueOnce(jsonErr(400)).mockResolvedValueOnce(jsonOk());

    await send({
      serviceName: 'kleinanzeigen',
      newListings: [listing],
      notificationConfig: [{ id: 'telegram', fields: { ...baseConfig.fields, hideMap: true } }],
      jobKey: 'J',
    });

    expect(mockNodeFetch).toHaveBeenCalledTimes(2);
    expect(mockNodeFetch.mock.calls[1][0]).toBe('https://api.telegram.org/botTKN/sendPhoto');
    expect(mockNodeFetch.mock.calls[1][1].body).toBeInstanceOf(FormData);
  });
});
