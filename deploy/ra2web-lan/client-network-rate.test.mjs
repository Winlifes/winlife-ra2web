// Exercise methods extracted from the actual prepared browser bundle. This
// catches replay queue regressions that a second implementation would miss.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const file = process.env.RA2_CLIENT_BUNDLE;
if (!file) throw new Error('Set RA2_CLIENT_BUNDLE to the prepared js/app.js');
const bundle = fs.readFileSync(file, 'utf8');
const section = (start, end) => {
  const i = bundle.indexOf(start), j = bundle.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `Bundle method boundaries: ${start}`);
  return bundle.slice(i, j);
};
const rounding = bundle.match(/function zCe\([^)]*\)\{[^}]*\}/)?.[0];
assert.ok(rounding, 'Use actual upstream whole-logic-step rounding');
const Methods = vm.runInNewContext(`
  const zw={PREFERRED_HASH_CHECK_MILLIS:1000},ak={Ended:'ended'};
  ${rounding}
  (class {
    ${section('canAdvanceNetworkTurn(){', 'setErrorState(){')}
    ${section('setRate(e){', 'setPassiveMode(e){')}
    ${section('doGameTurn(e){', 'handleCommsLag(e,t){')}
  })
`);
const make = () => Object.assign(new Methods(), {
  currentNetworkTurn: 0, currentSubTurn: 0, queuedRateChanges: [],
  gameTurnMillis: 1000 / 60, receivedActions: new Map(),
  game: { status: 'playing' }, debug() {}, handleCommsLag() {},
});

test('initial timing rounds up without changing the 60 Hz logic clock', () => {
  const client = make();
  client.setRate({ rate: 60, turnNo: 0 });
  assert.ok(Math.abs(client.networkTurnMillis - 1000 / 15) < 1e-8);
  assert.equal(client.gameTurnMillis, 1000 / 60);
  client.setRate({ rate: 60, turnNo: 0 });
  assert.equal(client.queuedRateChanges.length, 0);
  assert.throws(() => client.setRate({ rate: 100, turnNo: 0 }), /Conflicting/);
});

test('rate N applies only at N+2 and replay cannot block later changes', () => {
  const client = make();
  client.setRate({ rate: 60, turnNo: 0 });
  client.currentNetworkTurn = 2;
  client.setRate({ rate: 100, turnNo: 2 });
  client.setRate({ rate: 100, turnNo: 2 });
  assert.equal(client.queuedRateChanges.length, 1);
  assert.throws(() => client.setRate({ rate: 133, turnNo: 2 }), /Conflicting/);
  client.currentNetworkTurn = 3;
  assert.equal(client.doGameTurn(100), false, 'missing batch still blocks advancement');
  assert.equal(client.lastAppliedNetworkRate.turnNo, 0);
  client.currentNetworkTurn = 4;
  assert.equal(client.doGameTurn(200), false);
  assert.equal(client.lastAppliedNetworkRate.turnNo, 2);
  assert.equal(client.queuedRateChanges.length, 0);
  client.setRate({ rate: 100, turnNo: 2 });
  client.setRate({ rate: 60, turnNo: 0 });
  assert.equal(client.queuedRateChanges.length, 0, 'applied replay is idempotent');
  client.setRate({ rate: 133, turnNo: 3 });
  client.currentNetworkTurn = 5;
  assert.equal(client.doGameTurn(300), false);
  assert.equal(client.lastAppliedNetworkRate.rate, 133);
  assert.equal(client.queuedRateChanges.length, 0);
  assert.ok(Math.abs(client.networkTurnMillis - 8 * 1000 / 60) < 1e-8);
});

test('malformed and conflicting applied notifications are rejected', () => {
  const client = make();
  for (const change of [{ rate: 0, turnNo: 0 }, { rate: 100, turnNo: -1 }, { rate: NaN, turnNo: 1 }]) {
    assert.throws(() => client.setRate(change), /Invalid/);
  }
  client.setRate({ rate: 100, turnNo: 0 });
  client.currentNetworkTurn = 4;
  assert.throws(() => client.setRate({ rate: 133, turnNo: 0 }), /Conflicting/);
  assert.throws(() => client.setRate({ rate: 133, turnNo: 1 }), /past/);
});
