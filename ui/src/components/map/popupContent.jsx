/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../services/i18n/i18n.jsx';

/**
 * Renders a React node into a MapLibre popup.
 *
 * Popup content lives outside the app's React tree, so it gets no context from it - the translation
 * provider has to be re-established here, which is why the caller passes the active language.
 *
 * @param {HTMLElement} container - The element inside the popup to render into.
 * @param {React.ReactNode} node
 * @param {string} language - Active language code, e.g. `de`.
 * @returns {() => void} Unmounts the tree again. Safe to call from a MapLibre event handler: the
 * unmount is deferred, because React refuses to tear a root down while it is rendering.
 */
export function mountPopupNode(container, node, language) {
  const root = createRoot(container);
  root.render(<I18nProvider language={language}>{node}</I18nProvider>);

  return () => {
    setTimeout(() => root.unmount(), 0);
  };
}

// Lives in its own module so it can be tested without React; re-exported for the existing imports.
export { keepPopupInView } from './popupFit.js';
