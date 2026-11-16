// The two-turn wire protocol is verified against the original client. The
// estimator and hysteresis below are Winlife policy, not upstream server code.
export const NETWORK_POLICY = Object.freeze({
  minMs: 60, maxMs: 200, fallbackMs: 133,
  sampleWindowMs: 30000, freshSampleMs: 6000, minimumSamples: 3,
  schedulingMarginMs: 30, jitterMultiplier: 2,
  increaseCooldownMs: 500, decreaseStableMs: 30000,
});

export function quantile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export class NetworkRateController {
  constructor(players, { now, ...options } = {}) {
    this.policy = { ...NETWORK_POLICY, ...options };
    const p = this.policy;
    for (const [key, value] of Object.entries(p)) {
      if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid network policy: ${key}`);
    }
    if (p.minMs < 30 || p.maxMs > 500 || p.maxMs < p.minMs || p.fallbackMs < p.minMs || p.fallbackMs > p.maxMs || p.minimumSamples < 1 || p.sampleWindowMs < 1 || p.freshSampleMs < 1) throw new RangeError('Invalid network policy bounds');
    if (!Number.isFinite(now)) throw new RangeError('Network policy needs a monotonic clock');
    this.levels = [...new Set([p.minMs, 60, 83, 100, 116, 133, 166, 200, p.maxMs])].filter(n => n >= p.minMs && n <= p.maxMs).sort((a, b) => a - b);
    const estimate = this.estimate(players, now);
    this.currentMs = estimate.targetMs;
    this.changes = [{ turnNo: 0, rateMs: this.currentMs, reason: estimate.complete ? 'initial-measurement' : 'initial-fallback' }];
    this.lastChangeAt = now;
    this.lowerSince = undefined;
    this.lastEstimate = estimate;
  }

  estimate(players, now) {
    const p = this.policy;
    let worstBudgetMs = 0, complete = players.length > 0;
    for (const player of players) {
      const samples = (player.samples || []).filter(s => Number.isFinite(s.rttMs) && s.rttMs >= 0 && s.at <= now && now - s.at <= p.sampleWindowMs);
      const fresh = samples.length && now - samples.at(-1).at < p.freshSampleMs;
      if (!fresh) { complete = false; continue; }
      if (samples.length < p.minimumSamples) complete = false;
      const jitter = Number.isFinite(player.jitterMs) ? Math.max(0, player.jitterMs) : 0;
      worstBudgetMs = Math.max(worstBudgetMs, quantile(samples.map(s => s.rttMs), .95) + p.jitterMultiplier * jitter + p.schedulingMarginMs);
    }
    const requiredMs = Math.max(p.minMs, worstBudgetMs / 2, complete ? 0 : p.fallbackMs);
    const targetMs = this.levels.find(rate => rate >= requiredMs) ?? p.maxMs;
    return { targetMs, complete, worstBudgetMs: Math.round(worstBudgetMs) };
  }

  advance(players, turnNo, now) {
    const estimate = this.estimate(players, now);
    this.lastEstimate = estimate;
    const latest = this.changes.at(-1);
    // Exactly one announcement per origin turn. A client applies it at N+2.
    if (!Number.isInteger(turnNo) || turnNo <= latest.turnNo) return;
    let next, reason;
    if (estimate.targetMs > this.currentMs) {
      this.lowerSince = undefined;
      if (now - this.lastChangeAt >= this.policy.increaseCooldownMs) { next = estimate.targetMs; reason = 'network-worse'; }
    } else if (estimate.targetMs < this.currentMs && estimate.complete) {
      this.lowerSince ??= now;
      if (now - this.lowerSince >= this.policy.decreaseStableMs) {
        next = this.levels[this.levels.indexOf(this.currentMs) - 1];
        reason = 'stable-recovery';
      }
    } else this.lowerSince = undefined;
    if (next === undefined || next === this.currentMs) return;
    const change = { turnNo, rateMs: next, reason };
    this.currentMs = next;
    this.lastChangeAt = now;
    this.lowerSince = undefined;
    this.changes.push(change);
    return change;
  }
}
