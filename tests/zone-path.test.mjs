import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualAt, zoneAt } from '../site/zone-path.js';

const zone = { keys: [{ t: 1, x: 0, y: 0, w: 0.1, h: 0.1 }, { t: 3, x: 0.4, y: 0.2, w: 0.3, h: 0.1 }], end: null };

test('absente avant la première position', () => {
  assert.equal(zoneAt(zone, 0.5), null);
});

test('glisse en ligne droite entre deux positions', () => {
  const p = zoneAt(zone, 2);
  assert.ok(Math.abs(p.x - 0.2) < 1e-9 && Math.abs(p.y - 0.1) < 1e-9 && Math.abs(p.w - 0.2) < 1e-9);
});

test('reste en place après la dernière position, jusqu\'à la fin choisie', () => {
  assert.deepEqual(zoneAt(zone, 10), zone.keys[1]);
  assert.equal(zoneAt({ ...zone, end: 5 }, 6), null);
});

test('manualAt : conversion en pixels', () => {
  assert.deepEqual(manualAt([zone], 1, 1000, 500), [{ x: 0, y: 0, w: 100, h: 50 }]);
});
