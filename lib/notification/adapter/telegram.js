/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { readAdapterReadme } from '../../services/markdown.js';
import { getJob } from '../../services/storage/jobStorage.js';
import fetch from 'node-fetch';
import pThrottle from 'p-throttle';
import { normalizeImageUrl } from '../../utils.js';
import logger from '../../services/logger.js';
import { shouldUseMultipart, buildPhotoFormData } from './telegramPhotoUploader.js';
import { toPriceChangeListing } from '../priceChangeMessage.js';
import { isLinkableBaseUrl, portalHost } from '../fredyLink.js';
import { fetchListingPicture } from '../../services/listings/listingPictures.js';
import { isUsableCoordinate, mapAttribution, renderListingMap } from '../../services/maps/staticMap.js';

const DEFAULT_API_URL = 'https://api.telegram.org';
const RATE_LIMIT_INTERVAL = 1000;
const THROTTLE_MAX_IDLE_MS = RATE_LIMIT_INTERVAL + 2000;
const chatThrottleMap = new Map();

/**
 * Removes stale throttled call entries to keep memory bounded.
 * An entry is stale when no API call has fired for longer than THROTTLE_MAX_IDLE_MS.
 */
function cleanupOldThrottles() {
  const now = Date.now();
  for (const [chatId, chatThrottle] of chatThrottleMap.entries()) {
    if (now - chatThrottle.lastUsedAt > THROTTLE_MAX_IDLE_MS) chatThrottleMap.delete(chatId);
  }
}

/**
 * Return a throttled wrapper for a chatId to limit Telegram API calls.
 * Uses p-throttle with 1 request per RATE_LIMIT_INTERVAL per chat.
 * `lastUsedAt` is refreshed on every actual API call so that the idle window
 * starts from the last fired call, not from when send() was invoked.
 *
 * @param {string|number} chatId
 * @param {Function} call - async function (endpoint: string, body: any) => Promise<Response>
 * @returns {Function}
 */
function getThrottled(chatId, call) {
  cleanupOldThrottles();
  const existing = chatThrottleMap.get(chatId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing.throttled;
  }
  const entry = { lastUsedAt: Date.now(), throttled: null };
  chatThrottleMap.set(chatId, entry);
  entry.throttled = pThrottle({ limit: 1, interval: RATE_LIMIT_INTERVAL })(async (endpoint, body) => {
    const e = chatThrottleMap.get(chatId);
    if (e) e.lastUsedAt = Date.now();
    return call(endpoint, body);
  });
  return entry.throttled;
}

/**
 * Shorten a string to a maximum length with an ellipsis suffix.
 * @param {string} str
 * @param {number} [len=90]
 * @returns {string}
 */
function shorten(str, len = 90) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len).trim() + '...' : str;
}

/**
 * Escape basic HTML entities for Telegram HTML parse mode.
 * @param {string} [s='']
 * @returns {string}
 */
function escapeHtml(s = '') {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The text of the link to the advert itself, naming where it goes ("Open on kleinanzeigen.de").
 *
 * @param {Object} o - Listing object
 * @returns {string}
 */
function listingLinkLabel(o) {
  const host = portalHost(o.link);
  return host ? `Open on ${host}` : 'Open listing';
}

/**
 * The Fredy detail url, or null when the configured base url cannot open on a phone.
 * See {@link isLinkableBaseUrl}.
 *
 * @param {Object} o - Listing object
 * @param {string} [baseUrl]
 * @returns {string|null}
 */
function fredyUrl(o, baseUrl) {
  return isLinkableBaseUrl(baseUrl) && o.id ? `${baseUrl}/#/listings/listing/${o.id}` : null;
}

/**
 * Build a Telegram HTML-formatted message body.
 * Suitable for both sendMessage (uncapped) and sendPhoto captions (caller must slice to 1024).
 *
 * The travel time has a line of its own, because it is the figure that decides whether a listing is
 * worth a second look, and squeezed between price and size it was easy to read past. The advert gets
 * an explicit link naming its portal: the linked title alone did not look like a link.
 *
 * @param {string} jobName
 * @param {string} serviceName
 * @param {Object} o - Listing object
 * @param {string} [baseUrl]
 * @param {{mapCredit?: string|null}} [options] - `mapCredit` is the map's attribution, appended when set.
 * @returns {string}
 */
function buildHtmlBody(jobName, serviceName, o, baseUrl, { mapCredit = null } = {}) {
  const title = shorten((o.title || '').replace(/\*/g, ''), 90);
  const meta = [o.address, o.price, o.size].filter(Boolean).join(' | ');
  const fredy = fredyUrl(o, baseUrl);
  const lines = [
    `<i>${escapeHtml(jobName)}</i> (${escapeHtml(serviceName)})`,
    `<a href='${escapeHtml(o.link || '')}'><b>${escapeHtml(title)}</b></a>`,
    escapeHtml(meta),
    o.commute ? `🚆 ${escapeHtml(o.commute)}` : null,
    o.link ? `\n🔗 <a href='${escapeHtml(o.link)}'>${escapeHtml(listingLinkLabel(o))}</a>` : null,
    fredy ? `<a href='${escapeHtml(fredy)}'>Open in Fredy</a>` : null,
    mapCredit ? `<i>Map ${escapeHtml(mapCredit)}</i>` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Build a plain-text Telegram photo caption (max 4096 characters).
 * Meta appears before the link so the most relevant info is visible within the cap.
 *
 * @param {string} jobName
 * @param {string} serviceName
 * @param {Object} o - Listing object
 * @param {string} [baseUrl]
 * @param {{mapCredit?: string|null}} [options]
 * @returns {string}
 */
function buildPlainCaption(jobName, serviceName, o, baseUrl, { mapCredit = null } = {}) {
  const title = shorten((o.title || '').replace(/\*/g, ''), 90);
  const meta = [o.address, o.price, o.size].filter(Boolean).join(' | ');
  const fredy = fredyUrl(o, baseUrl);
  const lines = [
    `${jobName} (${serviceName})`,
    title,
    meta,
    o.commute ? `🚆 ${o.commute}` : null,
    '',
    o.link || null,
    fredy ? `Open in Fredy: ${fredy}` : null,
    mapCredit ? `Map ${mapCredit}` : null,
  ];
  return lines
    .filter((line) => line != null)
    .join('\n')
    .slice(0, 4096);
}

/**
 * Build a plain-text Telegram message body.
 * Link appears early so it is tappable without scrolling.
 *
 * @param {string} jobName
 * @param {string} serviceName
 * @param {Object} o - Listing object
 * @param {string} [baseUrl]
 * @returns {string}
 */
function buildPlainText(jobName, serviceName, o, baseUrl) {
  const title = shorten((o.title || '').replace(/\*/g, ''), 90);
  const meta = [o.address, o.price, o.size].filter(Boolean).join(' | ');
  const fredy = fredyUrl(o, baseUrl);
  const lines = [
    `${jobName} (${serviceName})`,
    title,
    o.link || '',
    meta,
    o.commute ? `🚆 ${o.commute}` : null,
    fredy ? `Open in Fredy: ${fredy}` : null,
  ];
  return lines.filter((line) => line != null).join('\n');
}

/**
 * Resolve the Telegram API base url.
 * Anything missing, unparsable or not http(s) falls back to the official endpoint with a warning,
 * so a broken relay url can never take notifications down.
 *
 * @param {string} [apiUrl] - Optional user configured base url (e.g. a Telegram API relay).
 * @returns {string} Base url without trailing slashes.
 */
function resolveApiUrl(apiUrl) {
  const raw = typeof apiUrl === 'string' ? apiUrl.trim() : '';
  if (raw === '') return DEFAULT_API_URL;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (parsed == null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    logger.warn(`Telegram adapter: 'apiUrl' is invalid ('${apiUrl}'). Falling back to ${DEFAULT_API_URL}.`);
    return DEFAULT_API_URL;
  }
  return raw.replace(/\/+$/, '');
}

/**
 * Create the raw Telegram API caller for a given bot token.
 * Handles JSON and multipart (FormData) bodies.
 *
 * @param {string} token - Telegram bot token.
 * @param {string} jobName - Used in error messages.
 * @param {string} apiUrl - Telegram API base url, already resolved.
 * @returns {(endpoint: string, body: object|FormData) => Promise<Response>}
 */
function makeTelegramCaller(token, jobName, apiUrl) {
  return async function (endpoint, body) {
    const isFormData = body instanceof FormData;
    const opts = isFormData
      ? { method: 'post', body }
      : { method: 'post', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
    const res = await fetch(`${apiUrl}/bot${token}/${endpoint}`, opts);
    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`API error for '${jobName}'. '${endpoint}' returned ${errorBody}`);
    }
    return res;
  };
}

/**
 * Send a single listing to a single Telegram chat, with photo-then-text fallback.
 *
 * @param {Function} throttledCall - Throttled Telegram API caller for this chat.
 * @param {Object} listing - Listing object.
 * @param {string|number} chatId
 * @param {Object} opts
 * @param {string} opts.jobName
 * @param {string} opts.serviceName
 * @param {string} opts.baseUrl
 * @param {boolean} opts.plainText
 * @param {number|undefined} opts.message_thread_id
 * @returns {Promise<void>}
 */
async function sendListingToChat(
  throttledCall,
  listing,
  chatId,
  { jobName, serviceName, baseUrl, plainText, message_thread_id, places = [], withMap = false },
) {
  const img = normalizeImageUrl(listing.image);

  const textPayload = {
    chat_id: chatId,
    text: plainText
      ? buildPlainText(jobName, serviceName, listing, baseUrl)
      : buildHtmlBody(jobName, serviceName, listing, baseUrl),
    ...(plainText ? {} : { parse_mode: 'HTML' }),
    disable_web_page_preview: true,
    ...(message_thread_id ? { message_thread_id } : {}),
  };
  const parseMode = plainText ? undefined : 'HTML';

  if (withMap && isUsableCoordinate(listing.latitude, listing.longitude)) {
    // Built once the map is drawn, because the credit names the tile server that drew it.
    const mapCaption = (mapCredit) =>
      plainText
        ? buildPlainCaption(jobName, serviceName, listing, baseUrl, { mapCredit })
        : buildHtmlBody(jobName, serviceName, listing, baseUrl, { mapCredit }).slice(0, 1024);
    try {
      return await sendWithMap(throttledCall, listing, chatId, {
        img: listing.image,
        places,
        caption: mapCaption,
        parseMode,
        message_thread_id,
      });
    } catch (e) {
      // The map is an extra. Whatever went wrong with it, the listing still goes out the usual way.
      logger.warn(`Could not send the listing with a map to Telegram, sending it without: ${e.message}`);
    }
  }

  if (!img) {
    return throttledCall('sendMessage', textPayload).catch((e) => {
      logger.error(`Error sending message to Telegram: ${e.message}`);
    });
  }

  const caption = plainText
    ? buildPlainCaption(jobName, serviceName, listing, baseUrl)
    : buildHtmlBody(jobName, serviceName, listing, baseUrl).slice(0, 1024);

  const multipartCall = () =>
    buildPhotoFormData({ chatId, imageUrl: img, caption, parseMode, messageThreadId: message_thread_id }).then((fd) =>
      throttledCall('sendPhoto', fd),
    );

  // .webp URLs (Immowelt/Cloudimage) fail Telegram's URL-based sendPhoto with
  // "failed to get HTTP URL content". Upload the bytes via multipart instead.
  const photoCall = shouldUseMultipart(img)
    ? multipartCall()
    : throttledCall('sendPhoto', {
        chat_id: chatId,
        photo: img,
        caption,
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...(message_thread_id ? { message_thread_id } : {}),
      }).catch((e) => {
        // Telegram cannot fetch every CDN either (Kleinanzeigen's extension-less image urls fail the
        // same way). Fetching the bytes ourselves usually works where its fetcher did not.
        logger.debug(`Telegram could not fetch the photo by url, uploading it instead: ${e.message}`);
        return multipartCall();
      });

  return photoCall.catch(async (e) => {
    logger.warn(`Error sending photo to Telegram and use a fallback: ${e.message}`);
    return throttledCall('sendMessage', textPayload).catch((e) => {
      logger.error(`Error sending message to Telegram: ${e.message}`);
      throw e;
    });
  });
}

/**
 * The listing's photo as JPEG bytes, or null when it cannot be had.
 *
 * Downloaded through the same guarded fetch the stored previews use, then re-encoded, because an
 * album is uploaded as bytes and Telegram wants a photo it can decode as one.
 *
 * @param {string|null|undefined} imageUrl
 * @returns {Promise<Buffer|null>}
 */
async function listingPhotoJpeg(imageUrl) {
  const url = typeof imageUrl === 'string' && imageUrl.startsWith('https://') ? imageUrl : normalizeImageUrl(imageUrl);
  if (!url) return null;
  try {
    const { buffer } = await fetchListingPicture(url);
    const { default: sharp } = await import('sharp');
    return await sharp(buffer)
      .rotate()
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (e) {
    logger.debug(`Listing photo could not be prepared for Telegram: ${e.message}`);
    return null;
  }
}

/**
 * Send the listing as an album: its photo with the caption, and the map beside it. Without a photo
 * that can be had, the map alone carries the caption.
 *
 * @param {Function} throttledCall
 * @param {Object} listing
 * @param {string|number} chatId
 * @param {Object} opts
 * @param {string|null|undefined} opts.img - The listing's photo url.
 * @param {Array<{lat: number, lng: number, label?: string}>} opts.places - Saved places to show on the map.
 * @param {(attribution: string) => string} opts.caption - Called once the map is drawn, with its credit.
 * @param {string|undefined} opts.parseMode
 * @param {number|undefined} opts.message_thread_id
 * @returns {Promise<any>}
 * @throws {Error} When the map cannot be rendered or Telegram refuses the upload.
 */
async function sendWithMap(throttledCall, listing, chatId, { img, places, caption, parseMode, message_thread_id }) {
  const [map, photo] = await Promise.all([
    renderListingMap(
      { lat: listing.latitude, lng: listing.longitude, label: listing.price ?? undefined },
      labelPlaces(places, listing.travelTimes),
    ),
    listingPhotoJpeg(img),
  ]);

  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (message_thread_id) fd.append('message_thread_id', String(message_thread_id));
  const captioned = { caption: caption(mapAttribution()), ...(parseMode ? { parse_mode: parseMode } : {}) };

  if (photo == null) {
    Object.entries(captioned).forEach(([k, v]) => fd.append(k, v));
    fd.append('photo', new Blob([map], { type: 'image/jpeg' }), 'map.jpg');
    return throttledCall('sendPhoto', fd);
  }

  fd.append(
    'media',
    JSON.stringify([
      { type: 'photo', media: 'attach://photo', ...captioned },
      { type: 'photo', media: 'attach://map' },
    ]),
  );
  fd.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'photo.jpg');
  fd.append('map', new Blob([map], { type: 'image/jpeg' }), 'map.jpg');
  return throttledCall('sendMediaGroup', fd);
}

/**
 * The job owner's saved places that have one fixed location, for the map.
 * Place types ("nearest supermarket") have no single spot to pin, so they are left out.
 *
 * @param {string} jobKey
 * @returns {Promise<Array<{lat: number, lng: number, name: string, mode: string}>>}
 */
async function placesForJob(jobKey) {
  try {
    const userId = getJob(jobKey)?.userId;
    if (typeof userId !== 'string' || userId === '') return [];
    const { getAddresses, getUserSettings } = await import('../../services/storage/settingsStorage.js');
    return getAddresses(getUserSettings(userId))
      .filter((address) => isUsableCoordinate(address?.coords?.lat, address?.coords?.lng))
      .map((address) => ({
        lat: Number(address.coords.lat),
        lng: Number(address.coords.lng),
        name: typeof address.label === 'string' ? address.label : '',
        mode: typeof address.mode === 'string' ? address.mode : 'transit',
      }));
  } catch (e) {
    logger.debug(`Saved places could not be read for the notification map: ${e.message}`);
    return [];
  }
}

/**
 * Label each saved place for one listing: its name, and how long the trip from the listing takes
 * when that is known ("Work · 40 min").
 *
 * @param {Array<{lat: number, lng: number, name?: string, mode?: string}>} places
 * @param {Array<Object>|null|undefined} travelTimes - The listing's stored travel times.
 * @returns {Array<{lat: number, lng: number, label: string}>}
 */
export function labelPlaces(places, travelTimes) {
  const entries = Array.isArray(travelTimes) ? travelTimes : [];
  return places.map((place) => {
    const entry = entries.find((candidate) => candidate?.label === place.name);
    const mode = String(place.mode ?? entry?.mode ?? 'transit').toLowerCase();
    const minutes = entry?.[mode]?.minutes ?? entry?.transit?.minutes;
    const parts = [place.name, Number.isFinite(minutes) ? `${minutes} min` : null].filter(Boolean);
    return { lat: place.lat, lng: place.lng, label: parts.join(' · ') };
  });
}

/**
 * Send new listings to Telegram.
 * - Respects per-chat Telegram rate limits using a lightweight throttle cache.
 * - Falls back to sendMessage when sendPhoto fails or image is missing.
 *
 * @param {Object} params
 * @param {string} params.serviceName - Name of the crawler/service producing the listings.
 * @param {Array<Object>} params.newListings - Array of new listing objects.
 * @param {Array<Object>} params.notificationConfig - Notification adapters configuration array.
 * @param {string} params.jobKey - Storage job key to resolve the human readable job name.
 * @returns {Promise<Array<Response>>} Promise resolving when all send operations complete.
 */
export const send = ({ serviceName, newListings = [], notificationConfig, jobKey, baseUrl }) => {
  const adapterCfg = notificationConfig.find((adapter) => adapter.id === config.id);
  if (!adapterCfg || !adapterCfg.fields) {
    throw new Error(`Telegram adapter configuration missing for job '${jobKey || ''}'`);
  }
  const { token, chatId, messageThreadId, plainText, apiUrl, hideMap } = adapterCfg.fields;
  if (!token || !chatId) {
    throw new Error("Telegram 'token' and 'chatId' must be provided in notification config");
  }

  const chatIds = String(chatId)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // Optional Telegram topic/thread support (supergroups)
  let message_thread_id;
  if (messageThreadId !== undefined && messageThreadId !== null && `${messageThreadId}`.trim() !== '') {
    const n = Number(messageThreadId);
    if (Number.isInteger(n) && n > 0) {
      message_thread_id = n;
    } else {
      logger.warn(
        `Telegram adapter: 'messageThreadId' is invalid ('${messageThreadId}'). It must be a positive integer. Ignoring.`,
      );
    }
  }

  const job = getJob(jobKey);
  const jobName = job == null ? jobKey : job.name;

  if (!Array.isArray(newListings) || newListings.length === 0) return Promise.resolve([]);

  const withMap = hideMap !== true;
  const resolvedApiUrl = resolveApiUrl(apiUrl);
  const placesPromise = withMap ? placesForJob(jobKey) : Promise.resolve([]);
  return placesPromise.then((places) => {
    const allPromises = chatIds.flatMap((id) => {
      const caller = makeTelegramCaller(token, jobName, resolvedApiUrl);
      const throttledCall = getThrottled(id, caller);
      const opts = { jobName, serviceName, baseUrl, plainText, message_thread_id, places, withMap };
      return newListings.map((listing) => sendListingToChat(throttledCall, listing, id, opts));
    });
    return Promise.all(allPromises);
  });
};

/**
 * Telegram notification adapter configuration schema.
 * @type {{id:string,name:string,readme:string,description:string,fields:{token:{type:string,label:string,description:string},chatId:{type:string,label:string,description:string},messageThreadId?:{type:string,label:string,description:string}}}}
 */
/**
 * Sends price changes over the same throttled per-chat path as new listings.
 *
 * Reusing `sendListingToChat` matters more here than the wording does: Telegram rate-limits per
 * chat, and a second, unthrottled path would be the one that trips the limit and takes the new
 * listing notifications down with it.
 *
 * @param {{serviceName: string, priceChanges: any[], notificationConfig: any[], jobKey: string, baseUrl: string}} params
 * @returns {Promise<any>}
 */
export const sendPriceChange = ({ serviceName, priceChanges = [], notificationConfig, jobKey, baseUrl }) => {
  const adapterCfg = notificationConfig.find((adapter) => adapter.id === config.id);
  if (!adapterCfg || !adapterCfg.fields) {
    throw new Error(`Telegram adapter configuration missing for job '${jobKey || ''}'`);
  }
  const { token, chatId, messageThreadId, plainText, apiUrl } = adapterCfg.fields;
  if (!token || !chatId) {
    throw new Error("Telegram 'token' and 'chatId' must be provided in notification config");
  }
  if (!Array.isArray(priceChanges) || priceChanges.length === 0) return Promise.resolve([]);

  const chatIds = String(chatId)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let message_thread_id;
  if (messageThreadId !== undefined && messageThreadId !== null && `${messageThreadId}`.trim() !== '') {
    const n = Number(messageThreadId);
    if (Number.isInteger(n) && n > 0) {
      message_thread_id = n;
    }
  }

  const job = getJob(jobKey);
  const jobName = job == null ? jobKey : job.name;

  const resolvedApiUrl = resolveApiUrl(apiUrl);
  const allPromises = chatIds.flatMap((id) => {
    const caller = makeTelegramCaller(token, jobName, resolvedApiUrl);
    const throttledCall = getThrottled(id, caller);
    const opts = { jobName, serviceName, baseUrl, plainText, message_thread_id };
    return priceChanges.map((change) => sendListingToChat(throttledCall, toPriceChangeListing(change), id, opts));
  });

  return Promise.all(allPromises);
};

export const config = {
  id: 'telegram',
  name: 'Telegram',
  readme: readAdapterReadme('telegram.md'),
  description: 'Fredy will send new listings to your mobile, using Telegram.',
  fields: {
    token: {
      type: 'text',
      label: 'Token',
      description: 'The token needed to access this service.',
      // Never leaves the server for anyone who may not edit this channel.
      secret: true,
    },
    chatId: {
      type: 'chatId',
      label: 'Chat Id',
      description:
        'The chat ID to send messages to. Separate multiple IDs with commas to notify several recipients (e.g. 123456789, 987654321).',
      // Shown as the channel's destination in the UI.
      target: true,
    },
    messageThreadId: {
      type: 'text',
      optional: true,
      label: 'Message Thread Id (optional)',
      description:
        'Optional: The topic/thread id within a supergroup to post into (Telegram message_thread_id). Provide a positive integer.',
    },
    plainText: {
      type: 'boolean',
      optional: true,
      label: 'Send as plain text',
      description: 'Send messages as plain text instead of HTML formatted.',
    },
    hideMap: {
      type: 'boolean',
      optional: true,
      label: 'Do not attach a map',
      description:
        'By default a listing with a known location is sent together with a small map (from OpenStreetMap) showing it and your saved places. Tick this to send the photo only.',
    },
    apiUrl: {
      type: 'text',
      optional: true,
      label: 'API Url (optional)',
      description: `Optional: Base url of a Telegram API relay (e.g. https://telegram.example.com). Leave empty to use ${DEFAULT_API_URL}.`,
    },
  },
};
