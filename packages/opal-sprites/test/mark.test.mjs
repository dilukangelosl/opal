import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opalBanner, OPAL_FP } from '../src/mark.js';

test('banner names the commercial license when one is declared', () => {
  assert.equal(opalBanner('OPAL-COM-2026-002 Fox Reel Studio'), `Opal video sprites (${OPAL_FP}) · commercial license OPAL-COM-2026-002 Fox Reel Studio`);
  assert.match(opalBanner(''), /PolyForm Noncommercial/);
});
