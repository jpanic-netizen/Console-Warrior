/**
 * Device profiles the dashboard/CLI can audit under. These are CSS viewport
 * dimensions (what the page's own responsive layout reacts to), not physical
 * screen resolution — deviceScaleFactor is the separate, correct place for
 * pixel density.
 *
 * The iPhone profiles are Chromium (or WebKit) *emulating* a phone-shaped
 * viewport/touch/DPR — real estate, touch events, and scale factor are
 * genuine, but this is not the manufacturer's real browser or hardware.
 * Every label this module produces says so explicitly; nothing here may be
 * presented as "real Mobile Safari" or "real iPhone" testing.
 */

export const DEVICE_PROFILES = {
  desktop: {
    key: 'desktop',
    label: 'Desktop',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  'iphone-17e': {
    key: 'iphone-17e',
    label: 'iPhone 17e',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iphone-air': {
    key: 'iphone-air',
    label: 'iPhone Air',
    viewport: { width: 420, height: 912 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iphone-17-pro-max': {
    key: 'iphone-17-pro-max',
    label: 'iPhone 17 Pro Max',
    viewport: { width: 440, height: 956 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
};

export const CUSTOM_DEVICE_KEY = 'custom';
export const DEVICE_PROFILE_KEYS = [...Object.keys(DEVICE_PROFILES), CUSTOM_DEVICE_KEY];

/** Every DEVICE_PROFILES entry is portrait (height > width) already — Playwright has
 * no separate "orientation" context option; orientation is simply which of
 * width/height is larger, so these dimensions being portrait *is* the setting. */
export function isPortrait(viewport) {
  return viewport.height >= viewport.width;
}

/**
 * How this device+engine combination should be described to a reader —
 * SOP-style honesty: never let a report imply this was a real device or a
 * real vendor browser.
 */
export function describeEmulation(deviceKey, engine = 'chromium') {
  if (deviceKey === 'desktop') return 'Desktop viewport';
  const engineLabel = engine === 'webkit' ? 'WebKit Safari-like emulation' : 'Chromium mobile emulation';
  if (deviceKey === CUSTOM_DEVICE_KEY) return `Custom viewport (${engineLabel})`;
  return engineLabel;
}

/**
 * Resolves a request (a known profile key, or 'custom' + explicit width/
 * height) into the full, concrete emulation settings a browser context
 * needs — the single place that turns "which device was selected" into
 * Playwright context options, so job metadata/results/reports all read the
 * same resolved shape instead of re-deriving it.
 */
export function resolveDeviceProfile({ deviceKey, width, height, engine = 'chromium' } = {}) {
  const key = deviceKey && DEVICE_PROFILES[deviceKey] ? deviceKey : deviceKey === CUSTOM_DEVICE_KEY ? CUSTOM_DEVICE_KEY : 'desktop';

  if (key === CUSTOM_DEVICE_KEY) {
    const w = Number(width) || 1440;
    const h = Number(height) || 900;
    return {
      deviceKey: CUSTOM_DEVICE_KEY,
      label: 'Custom',
      viewport: { width: w, height: h },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      isPortrait: isPortrait({ width: w, height: h }),
      emulationLabel: describeEmulation(CUSTOM_DEVICE_KEY, engine),
    };
  }

  const profile = DEVICE_PROFILES[key];
  return {
    deviceKey: profile.key,
    label: profile.label,
    viewport: { ...profile.viewport },
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: profile.isMobile,
    hasTouch: profile.hasTouch,
    isPortrait: isPortrait(profile.viewport),
    emulationLabel: describeEmulation(profile.key, engine),
  };
}

/** Plain list for populating a dashboard <select>, in display order. */
export function listDeviceProfiles() {
  return [
    ...Object.values(DEVICE_PROFILES).map((p) => ({ key: p.key, label: p.label, viewport: p.viewport })),
    { key: CUSTOM_DEVICE_KEY, label: 'Custom dimensions', viewport: null },
  ];
}
