// Cash-Future arbitrage cost & return engine (NSE, post 1-Apr-2026 STT).
// Pure functions only — shared by the React dashboard, the local poller and the tests.

export const DEFAULTS = {
  targetRoce: 2.0,          // % net per 30 days
  plan: "INDMONEY",         // "INDMONEY" | "API"
  pledge: true,             // true => SEBI 50:50, capital = notional * (1 + margin*cashShare)
  futMarginPct: 22,         // SPAN+ELM as % of notional (assumption — check broker)
  cashShareOfMargin: 0.5,   // 50:50 rule
  slippagePct: 0.04,        // all four orders together, % of notional
  includeDeliveryMargin: false, // add E-4..E-1 delivery margin to capital
  useBidAsk: true,          // executable spread (fut bid - cash ask) when quotes exist
};

export const RATES = {
  sttEqDelivery: 0.001,     // buy and sell
  sttFutSell: 0.0005,       // post 1-Apr-2026
  nseEq: 0.0000307,
  nseFut: 0.0000183,
  sebi: 0.000001,
  stampEqBuy: 0.00015,
  stampFutBuy: 0.00002,
  dp: 18.5,
  pledgePair: 40,           // pledge + unpledge
  gst: 0.18,
};

// NSE trading holidays. VERIFY against the NSE circular each year; edit in the UI.
export const NSE_HOLIDAYS = [
  "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03", "2026-04-14",
  "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14", "2026-10-02", "2026-10-20",
  "2026-11-10", "2026-11-24", "2026-12-25", "2027-01-26",
];

const iso = (d) => d.toISOString().slice(0, 10);
const utcDate = (s) => new Date(s + "T00:00:00Z");

export function isTradingDay(d, holidays = NSE_HOLIDAYS) {
  const wd = d.getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.includes(iso(d));
}

// Last Tuesday of the month; if a holiday, move to the PRECEDING trading day
// (e.g. 24-Nov-2026 holiday -> Mon 23-Nov; 26-Jan-2027 -> Mon 25-Jan).
export function monthlyExpiry(year, month0, holidays = NSE_HOLIDAYS) {
  const d = new Date(Date.UTC(year, month0 + 1, 0));
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() - 1);
  while (!isTradingDay(d, holidays)) d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}

export function nextExpiry(todayIso, holidays = NSE_HOLIDAYS) {
  const t = utcDate(todayIso);
  let e = monthlyExpiry(t.getUTCFullYear(), t.getUTCMonth(), holidays);
  if (e < todayIso) {
    const n = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1));
    e = monthlyExpiry(n.getUTCFullYear(), n.getUTCMonth(), holidays);
  }
  return e;
}

export function calendarDays(todayIso, expiryIso) {
  return Math.max(1, Math.round((utcDate(expiryIso) - utcDate(todayIso)) / 86400000));
}

// Trading days in (today, expiry]. Today is E-n with n = this count.
export function tradingDaysLeft(todayIso, expiryIso, holidays = NSE_HOLIDAYS) {
  const d = utcDate(todayIso), e = utcDate(expiryIso);
  let n = 0;
  while (d < e) { d.setUTCDate(d.getUTCDate() + 1); if (isTradingDay(d, holidays)) n++; }
  return n;
}

// Extra physical-delivery margin as a fraction of (VaR+ELM+adhoc), by E-n.
export function deliveryMarginFactor(eN) {
  return { 4: 0.10, 3: 0.25, 2: 0.45, 1: 0.70, 0: 0.70 }[eN] ?? 0;
}

export function costs({ cash, fut, lot }, p = DEFAULTS) {
  const C = cash * lot, F = fut * lot;
  // Exit assumed at convergence: sell cash at ~C, buy back future at ~C.
  const stt = Math.round(RATES.sttEqDelivery * C * 2 + RATES.sttFutSell * F);
  const eqBrk = Math.min(20, Math.max(2, 0.001 * C));
  const brokerage = p.plan === "API" ? 10 * 4 : eqBrk * 2 + 20 * 2;
  const exchange = RATES.nseEq * C * 2 + RATES.nseFut * (F + C);
  const sebi = RATES.sebi * (C * 3 + F);
  const stamp = RATES.stampEqBuy * C + RATES.stampFutBuy * C;
  const dpPledge = RATES.dp + (p.pledge ? RATES.pledgePair : 0);
  const gst = RATES.gst * (brokerage + exchange + sebi + dpPledge);
  const statutory = stt + brokerage + exchange + sebi + stamp + dpPledge + gst;
  const slippage = (p.slippagePct / 100) * C;
  return { stt, brokerage, exchange, sebi, stamp, dpPledge, gst, statutory, slippage, allIn: statutory + slippage };
}

export function capitalFactor(p = DEFAULTS, eN = 99) {
  const m = p.futMarginPct / 100;
  const extra = p.includeDeliveryMargin ? m * deliveryMarginFactor(eN) : 0;
  const marginCash = p.pledge ? (m + extra) * p.cashShareOfMargin : m + extra;
  return 1 + marginCash;
}

export function evaluate(row, ctx, p = DEFAULTS) {
  const { days, eN } = ctx;
  // Executable side: you BUY cash (pay ask) and SELL future (hit bid). Falls back to LTP per leg.
  const cash = p.useBidAsk && row.cashAsk > 0 ? row.cashAsk : row.cash;
  const fut = p.useBidAsk && row.futBid > 0 ? row.futBid : row.fut;
  const priced = `cash ${cash !== row.cash ? "ask" : "LTP"} / fut ${fut !== row.fut ? "bid" : "LTP"}`;
  const lot = row.lot;
  const notional = cash * lot;
  const gross = (fut - cash) * lot;
  const diffPct = ((fut - cash) / cash) * 100;
  const c = costs({ cash, fut, lot }, p);
  const net = gross - c.allIn;
  const capFactor = capitalFactor(p, eN);
  const capital = notional * capFactor;
  const netPeriodPct = (net / capital) * 100;
  const roce = (netPeriodPct / days) * 30;
  const costPct = (c.allIn / notional) * 100;
  const requiredPct = costPct + (p.targetRoce / 30) * days * capFactor;
  const legacyPinnedPct = (diffPct / days) * 30; // what the old gross-only prompt showed
  const cagr = (Math.pow(1 + netPeriodPct / 100, 365 / days) - 1) * 100;
  return {
    ...row, priced, cashUsed: cash, futUsed: fut,
    notional, gross, diffPct, costs: c, costPct, net, capital, capFactor,
    netPeriodPct, roce, cagr, requiredPct, legacyPinnedPct,
    reverse: fut < cash, meetsTarget: roce >= p.targetRoce,
  };
}
