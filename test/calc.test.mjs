import assert from "node:assert/strict";
import { evaluate, costs, nextExpiry, tradingDaysLeft, calendarDays, monthlyExpiry, DEFAULTS } from "../src/calc.js";

// Calendar
assert.equal(nextExpiry("2026-11-18"), "2026-11-23");
assert.equal(monthlyExpiry(2026, 11), "2026-12-29");
assert.equal(monthlyExpiry(2027, 0), "2027-01-25");   // matches INDmoney "25 Jan Fut"
assert.equal(calendarDays("2026-11-18", "2026-11-23"), 5);
assert.equal(tradingDaysLeft("2026-11-18", "2026-11-23"), 3); // today = E-3
assert.equal(tradingDaysLeft("2026-11-17", "2026-11-23"), 4); // E-4
assert.equal(nextExpiry("2026-11-24"), "2026-12-29");

// Audit model: 16L notional (C=1600, lot=1000), pledge on, 4bps slippage
const P = { ...DEFAULTS, useBidAsk: false };
const rows = [[30, 2.0], [15, 1.0], [15, 1.5], [5, 0.34], [1, 0.10]];
console.log("days spread  STT  statutory  allIn%   net      ROCE%  oldPin%  required%");
for (const [days, s] of rows) {
  const r = evaluate({ sym: "X", cash: 1600, fut: 1600 * (1 + s / 100), lot: 1000 }, { days, eN: 99 }, P);
  console.log(days, s, r.costs.stt, r.costs.statutory.toFixed(2), r.costPct.toFixed(4), r.net.toFixed(2),
    r.roce.toFixed(2), r.legacyPinnedPct.toFixed(2), r.requiredPct.toFixed(3));
}
const one = evaluate({ cash: 1600, fut: 1601.6, lot: 1000 }, { days: 1, eN: 1 }, P);
assert.ok(one.net < 0 && one.legacyPinnedPct > 2.9);
console.log("all calc tests passed");
