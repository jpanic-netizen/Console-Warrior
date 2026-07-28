import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeviceProfile, describeEmulation, listDeviceProfiles, DEVICE_PROFILES, CUSTOM_DEVICE_KEY, isPortrait } from '../src/engine/deviceProfiles.js';

test('resolveDeviceProfile: desktop is 1440x900, no mobile emulation, DPR 1', () => {
  const p = resolveDeviceProfile({ deviceKey: 'desktop' });
  assert.deepEqual(p.viewport, { width: 1440, height: 900 });
  assert.equal(p.deviceScaleFactor, 1);
  assert.equal(p.isMobile, false);
  assert.equal(p.hasTouch, false);
  assert.equal(p.emulationLabel, 'Desktop viewport');
});

test('resolveDeviceProfile: iPhone 17e is 390x844, DPR 3, mobile+touch, portrait', () => {
  const p = resolveDeviceProfile({ deviceKey: 'iphone-17e' });
  assert.deepEqual(p.viewport, { width: 390, height: 844 });
  assert.equal(p.deviceScaleFactor, 3);
  assert.equal(p.isMobile, true);
  assert.equal(p.hasTouch, true);
  assert.equal(p.isPortrait, true);
});

test('resolveDeviceProfile: iPhone Air is 420x912, DPR 3, mobile+touch', () => {
  const p = resolveDeviceProfile({ deviceKey: 'iphone-air' });
  assert.deepEqual(p.viewport, { width: 420, height: 912 });
  assert.equal(p.deviceScaleFactor, 3);
  assert.equal(p.isMobile, true);
  assert.equal(p.hasTouch, true);
});

test('resolveDeviceProfile: iPhone 17 Pro Max is 440x956, DPR 3, mobile+touch', () => {
  const p = resolveDeviceProfile({ deviceKey: 'iphone-17-pro-max' });
  assert.deepEqual(p.viewport, { width: 440, height: 956 });
  assert.equal(p.deviceScaleFactor, 3);
  assert.equal(p.isMobile, true);
  assert.equal(p.hasTouch, true);
});

test('resolveDeviceProfile: every built-in iPhone profile is portrait (height > width)', () => {
  for (const key of ['iphone-17e', 'iphone-air', 'iphone-17-pro-max']) {
    const p = resolveDeviceProfile({ deviceKey: key });
    assert.ok(p.viewport.height > p.viewport.width, `${key} must be portrait`);
    assert.equal(p.isPortrait, true);
  }
});

test('resolveDeviceProfile: custom uses the given width/height, desktop-like emulation flags', () => {
  const p = resolveDeviceProfile({ deviceKey: 'custom', width: 800, height: 600 });
  assert.deepEqual(p.viewport, { width: 800, height: 600 });
  assert.equal(p.deviceScaleFactor, 1);
  assert.equal(p.isMobile, false);
  assert.equal(p.hasTouch, false);
  assert.equal(p.isPortrait, false); // 800x600 is landscape
});

test('resolveDeviceProfile: an unrecognized/missing device key falls back to desktop, never crashes', () => {
  const p1 = resolveDeviceProfile({ deviceKey: 'nonexistent-device' });
  assert.equal(p1.deviceKey, 'desktop');
  const p2 = resolveDeviceProfile({});
  assert.equal(p2.deviceKey, 'desktop');
  const p3 = resolveDeviceProfile();
  assert.equal(p3.deviceKey, 'desktop');
});

test('resolveDeviceProfile: custom with missing/invalid width or height falls back to a sane default rather than NaN', () => {
  const p = resolveDeviceProfile({ deviceKey: 'custom', width: 'not-a-number', height: undefined });
  assert.equal(Number.isFinite(p.viewport.width), true);
  assert.equal(Number.isFinite(p.viewport.height), true);
});

// ---------- honest emulation labeling (never claim real Safari/iPhone) ----------

test('describeEmulation: iPhone profiles under Chromium are labeled "Chromium mobile emulation"', () => {
  assert.equal(describeEmulation('iphone-17e', 'chromium'), 'Chromium mobile emulation');
  assert.equal(describeEmulation('iphone-air', 'chromium'), 'Chromium mobile emulation');
  assert.equal(describeEmulation('iphone-17-pro-max', 'chromium'), 'Chromium mobile emulation');
});

test('describeEmulation: iPhone profiles under WebKit are labeled "WebKit Safari-like emulation", never "Safari"', () => {
  const label = describeEmulation('iphone-17e', 'webkit');
  assert.equal(label, 'WebKit Safari-like emulation');
  assert.doesNotMatch(label, /\bSafari\b(?!-like)/, 'must not claim to be actual Safari');
  assert.doesNotMatch(label, /real iPhone|actual iPhone/i);
});

test('describeEmulation: desktop is never described as an emulation of anything', () => {
  assert.equal(describeEmulation('desktop', 'chromium'), 'Desktop viewport');
  assert.equal(describeEmulation('desktop', 'webkit'), 'Desktop viewport');
});

test('describeEmulation: custom dimensions disclose the underlying engine honestly', () => {
  assert.equal(describeEmulation(CUSTOM_DEVICE_KEY, 'chromium'), 'Custom viewport (Chromium mobile emulation)');
  assert.equal(describeEmulation(CUSTOM_DEVICE_KEY, 'webkit'), 'Custom viewport (WebKit Safari-like emulation)');
});

test('resolveDeviceProfile: the emulationLabel on the resolved object matches describeEmulation for the same engine', () => {
  const chromium = resolveDeviceProfile({ deviceKey: 'iphone-air', engine: 'chromium' });
  assert.equal(chromium.emulationLabel, describeEmulation('iphone-air', 'chromium'));
  const webkit = resolveDeviceProfile({ deviceKey: 'iphone-air', engine: 'webkit' });
  assert.equal(webkit.emulationLabel, describeEmulation('iphone-air', 'webkit'));
});

// ---------- listing for the dashboard <select> ----------

test('listDeviceProfiles: lists every built-in profile plus Custom, in a stable order', () => {
  const list = listDeviceProfiles();
  assert.deepEqual(
    list.map((p) => p.key),
    ['desktop', 'iphone-17e', 'iphone-air', 'iphone-17-pro-max', 'custom']
  );
  assert.equal(list.find((p) => p.key === 'custom').viewport, null);
  assert.deepEqual(list.find((p) => p.key === 'desktop').viewport, { width: 1440, height: 900 });
});

test('DEVICE_PROFILES: exactly the 4 named built-in profiles exist, no more, no less', () => {
  assert.deepEqual(Object.keys(DEVICE_PROFILES).sort(), ['desktop', 'iphone-17-pro-max', 'iphone-17e', 'iphone-air'].sort());
});

test('isPortrait: taller-than-wide is portrait, wider-than-tall is not', () => {
  assert.equal(isPortrait({ width: 390, height: 844 }), true);
  assert.equal(isPortrait({ width: 1440, height: 900 }), false);
  assert.equal(isPortrait({ width: 500, height: 500 }), true); // square counts as portrait (height >= width)
});
