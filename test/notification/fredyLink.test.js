/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, expect, it } from 'vitest';
import { isLinkableBaseUrl, portalHost } from '../../lib/notification/fredyLink.js';

describe('isLinkableBaseUrl', () => {
  it.each(['http://172.17.0.1:9998', 'http://localhost:9998', 'http://127.0.0.1:9998', 'http://169.254.1.1'])(
    'leaves out %s, which a phone cannot open',
    (url) => {
      expect(isLinkableBaseUrl(url)).toBe(false);
    },
  );

  it.each(['https://fredy.example.com', 'http://192.168.1.20:9998', 'http://10.0.0.5:9998', 'http://nas.local:9998'])(
    'keeps %s',
    (url) => {
      expect(isLinkableBaseUrl(url)).toBe(true);
    },
  );

  it('has nothing to link without a base url', () => {
    expect(isLinkableBaseUrl('')).toBe(false);
    expect(isLinkableBaseUrl(undefined)).toBe(false);
    expect(isLinkableBaseUrl('not a url')).toBe(false);
  });
});

describe('portalHost', () => {
  it('names the portal without www', () => {
    expect(portalHost('https://www.kleinanzeigen.de/s-anzeige/x/1')).toBe('kleinanzeigen.de');
  });

  it('is null for something that is not a url', () => {
    expect(portalHost('l')).toBeNull();
  });
});
