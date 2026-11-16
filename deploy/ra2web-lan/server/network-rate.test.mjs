import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkRateController } from './network-rate.mjs';

const samples = (rtts, now, jitterMs = 0) => ({ samples: rtts.map((rttMs, i) => ({ rttMs, at: now - rtts.length + i + 1 })), jitterMs });

test('unknown or stale paths keep a conservative window and cannot trigger a reduction', () => {
  const rate = new NetworkRateController([{}], { now: 100 });
  assert.equal(rate.currentMs, 133);
  assert.equal(rate.advance([{}], 1, 100000), undefined);
  assert.equal(rate.currentMs, 133);
  const slow = samples([350], 100001);
  assert.equal(rate.advance([slow], 2, 100001).rateMs, 200);
  assert.equal(rate.advance([{}], 3, 200000), undefined);
  assert.equal(rate.currentMs, 200);
});

test('the worst active path and jitter raise the two-turn budget within its bounds', () => {
  const rate = new NetworkRateController([samples([10, 12, 11], 100)], { now: 100 });
  assert.equal(rate.currentMs, 60);
  const paths = [samples([10, 12, 11], 1000), samples([90, 100, 125], 1000, 38)];
  const change = rate.advance(paths, 1, 1000);
  assert.equal(change.rateMs, 116);
  assert.ok(change.rateMs * 2 >= 125 + 2 * 38 + 30);
  assert.equal(rate.advance([samples([3000, 5000, 2000], 2000)], 2, 2000).rateMs, 200);
  assert.equal(rate.advance(paths, 2, 3000), undefined, 'cannot publish two changes for one turn');
});

test('recovery needs sustained fresh samples and falls by only one step at a time', () => {
  const rate = new NetworkRateController([samples([330, 340, 350], 100)], { now: 100, decreaseStableMs: 1000 });
  assert.equal(rate.currentMs, 200);
  assert.equal(rate.advance([samples([10, 11, 12], 1000)], 1, 1000), undefined);
  assert.equal(rate.advance([samples([10, 11, 12], 1999)], 2, 1999), undefined);
  assert.equal(rate.advance([samples([10, 11, 12], 2000)], 3, 2000).rateMs, 166);
  assert.equal(rate.advance([samples([10, 11, 12], 2001)], 4, 2001), undefined);
  assert.equal(rate.advance([samples([10, 11, 12], 3001)], 5, 3001).rateMs, 133);
  assert.equal(rate.advance([{}], 6, 60000), undefined);
});

test('invalid operator policy fails before creating a game', () => {
  assert.throws(() => new NetworkRateController([], { now: 0, minMs: 201, maxMs: 200 }), RangeError);
  assert.throws(() => new NetworkRateController([], { now: 0, maxMs: 9999 }), RangeError);
});
