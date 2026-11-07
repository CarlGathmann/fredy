/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

/**
 * Whether a notification should carry an "Open in Fredy" link for this base url.
 *
 * Notifications are read on a phone. A base url that only resolves on the machine running Fredy -
 * loopback, link-local, or one of Docker's bridge networks (172.16.0.0/12, where the default
 * `172.17.0.1` lives) - produces a link that cannot open there, and next to the portal link it is
 * the one that looks like the way in. Home-network ranges (10/8, 192.168/16) and every hostname are
 * kept, because a phone on the same Wi-Fi or a VPN can reach those.
 *
 * @param {string|null|undefined} baseUrl Fredy's configured base url.
 * @returns {boolean}
 */
export function isLinkableBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return false;
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1') return false;
  const octets = host.split('.').map(Number);
  if (octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = octets;
    if (a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
  }
  return true;
}

/**
 * The portal's host name without a leading `www.`, for a link that says where it goes.
 *
 * @param {string|null|undefined} link
 * @returns {string|null}
 */
export function portalHost(link) {
  try {
    return new URL(String(link)).hostname.replace(/^www\./i, '');
  } catch {
    return null;
  }
}
