import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULTS, NSE_HOLIDAYS, evaluate, nextExpiry, calendarDays, tradingDaysLeft, deliveryMarginFactor,
} from "./calc.js";

// Live INDmoney MCP snapshot, 18-Nov-2026 (cash LTP ~15:59 IST, Nov-23 future ~15:40 IST).
// Lot sizes are ESTIMATES — verify on NSE before trading (lot affects fixed costs).
const SNAPSHOT = {
  asOf: "2026-11-18 cash 15:59 / fut 15:40 IST (INDmoney MCP)",
  rows: [
    { sym: "RELIANCE", cash: 1363, fut: 1361.3, futBid: 1361.3, futAsk: 1362, lot: 500 },
    { sym: "HDFCBANK", cash: 808.15, fut: 806.4, futBid: 806.15, futAsk: 806.8, lot: 1100 },
    { sym: "ICICIBANK", cash: 1601.3, fut: 1599.1, futBid: 1598.1, futAsk: 1599.4, lot: 700 },
    { sym: "INFY", cash: 1108.8, fut: 1110.7, futBid: 1109.5, futAsk: 1110.8, lot: 400 },
    { sym: "TCS", cash: 2379.5, fut: 2384.5, futBid: 2384, futAsk: 2384.6, lot: 175 },
    { sym: "SBIN", cash: 1135, fut: 1134.1, futBid: 1134, futAsk: 1134.5, lot: 750 },
    { sym: "AXISBANK", cash: 1360, fut: 1359.2, futBid: 1358.8, futAsk: 1360, lot: 625 },
    { sym: "ITC", cash: 296.6, fut: 296.9, futBid: 296.65, futAsk: 296.9, lot: 1600 },
    { sym: "BHARTIARTL", cash: 2132, fut: 2133, futBid: 2131.6, futAsk: 2132, lot: 475 },
    { sym: "LT", cash: 4159, fut: 4152.2, futBid: 4150.1, futAsk: 4154, lot: 175 },
  ],
};

const inr = (n) => (n < 0 ? "-₹" : "₹") + Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const pct = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) + "%" : "–");
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

// Accepts: [{sym,cash,fut,lot,...}], OR raw get_indian_stocks_details output (object keyed by ind_key).
export function parseInput(text, prevRows = []) {
  let data = JSON.parse(text);
  if (data && typeof data.result === "string") data = JSON.parse(data.result);
  if (Array.isArray(data)) return data.map((r) => ({ ...r, sym: String(r.sym || r.symbol).toUpperCase(), cash: +r.cash, fut: +r.fut, lot: +r.lot || 1 }));
  const byKey = {}, out = {};
  for (const [k, v] of Object.entries(data)) byKey[k] = v;
  for (const v of Object.values(byKey)) {
    const b = v.entity_basic || {}, s = v.entity_stats || {};
    if (b.segment === "fno" && b.underlying_parent_ind_key) {
      const parent = byKey[b.underlying_parent_ind_key];
      const sym = parent?.entity_basic?.symbol || (b.name || "").split(" ")[0];
      out[sym] = { ...(out[sym] || {}), sym, fut: s.live_price, futBid: s.bid_price, futAsk: s.ask_price, futTs: s.price_updated_at_ist,
        lot: v.segment_meta_data?.lot_size || out[sym]?.lot };
    } else if (b.symbol) {
      out[b.symbol] = { ...(out[b.symbol] || {}), sym: b.symbol, cash: s.live_price, cashTs: s.price_updated_at_ist };
    }
  }
  const prevLot = Object.fromEntries(prevRows.map((r) => [r.sym, r.lot]));
  return Object.values(out).filter((r) => r.cash && r.fut).map((r) => ({ ...r, lot: r.lot || prevLot[r.sym] || 1 }));
}

export function parseCSV(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(",").map((c) => c.trim().toLowerCase());
  return lines.map((l) => {
    const v = l.split(","); const o = {};
    cols.forEach((c, i) => (o[c] = c === "sym" || c === "symbol" ? (v[i] || "").trim().toUpperCase() : +v[i]));
    return { sym: o.sym || o.symbol, cash: o.cash, fut: o.fut, lot: o.lot || 1, cashAsk: o.cashask, futBid: o.futbid };
  }).filter((r) => r.sym && r.cash && r.fut);
}

const POLLER_HINT = `# Local 1-second scanner (runs on YOUR machine, not in the artifact)
# 1. Get an INDstocks API token (valid ~24h).
# 2. Fill in the adapter in tools/indstocks_poller.mjs against the official docs
#    (endpoint path, instrument-id format, response field names).
# 3. node tools/indstocks_poller.mjs --symbols symbols.csv --expiry 2026-11-23
#    It prints the ranked table every second and writes snapshot.json,
#    which you can paste into this dashboard.`;

export default function ArbDashboard() {
  const [p, setP] = useState({ ...DEFAULTS });
  const [today] = useState(todayIST());
  const [expiry, setExpiry] = useState(() => nextExpiry(todayIST()));
  const [rows, setRows] = useState(SNAPSHOT.rows);
  const [source, setSource] = useState(SNAPSHOT.asOf);
  const [running, setRunning] = useState(false);
  const [updated, setUpdated] = useState(null);
  const [filterMode, setFilterMode] = useState("roce"); // roce | flat | none
  const [hideReverse, setHideReverse] = useState(true);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(null);
  const [paste, setPaste] = useState("");
  const [msg, setMsg] = useState("");
  const [showPoller, setShowPoller] = useState(false);
  const base = useRef(SNAPSHOT.rows);

  const days = calendarDays(today, expiry);
  const eN = tradingDaysLeft(today, expiry, NSE_HOLIDAYS);
  const ctx = { days, eN };

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setRows(base.current.map((r) => {
        const j = 1 + (Math.random() - 0.5) * 0.002, b = (Math.random() - 0.45) * 0.004;
        const cash = +(r.cash * j).toFixed(2), fut = +(cash * (1 + (r.fut - r.cash) / r.cash + b)).toFixed(2);
        return { ...r, cash, fut, futBid: undefined, futAsk: undefined };
      }));
      setUpdated(new Date().toLocaleTimeString("en-IN", { hour12: false }));
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  const evald = useMemo(() => rows.map((r) => evaluate(r, ctx, p)), [rows, days, eN, p]);
  const visible = useMemo(() => evald
    .filter((r) => !q || r.sym.includes(q.toUpperCase()))
    .filter((r) => !(hideReverse && r.reverse))
    .sort((a, b) => b.roce - a.roce), [evald, q, hideReverse]);
  const passes = (r) => filterMode === "none" ? r.net > 0
    : filterMode === "roce" ? r.roce >= p.targetRoce && r.net > 0
    : (r.net / r.notional) * 100 >= p.targetRoce;
  const top = visible.filter(passes);
  const selected = sel && evald.find((r) => r.sym === sel);
  const reqExample = evaluate({ sym: "X", cash: 1600, fut: 1600, lot: 1000 }, ctx, { ...p, useBidAsk: false }).requiredPct;

  const set = (k) => (e) => setP({ ...p, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.type === "number" ? +e.target.value : e.target.value });
  const load = (newRows, label) => { base.current = newRows; setRows(newRows); setSource(label); setRunning(false); setMsg(`Loaded ${newRows.length} rows`); };
  const onPaste = () => { try { load(parseInput(paste, rows), "Pasted MCP/JSON " + new Date().toLocaleTimeString("en-IN", { hour12: false })); } catch (e) { setMsg("Parse error: " + e.message); } };
  const onFile = (e) => { const f = e.target.files[0]; if (!f) return; f.text().then((t) => {
    try { load(f.name.endsWith(".csv") ? parseCSV(t) : parseInput(t, rows), "File: " + f.name); } catch (err) { setMsg("Parse error: " + err.message); } }); };
  const setLot = (sym, lot) => { const upd = (rs) => rs.map((r) => r.sym === sym ? { ...r, lot: +lot || 1 } : r); base.current = upd(base.current); setRows(upd); };

  const deliveryBadge = eN <= 4 ? `E-${eN} DELIVERY MARGIN +${Math.round(deliveryMarginFactor(eN) * 100)}%` : null;

  return (
    <div className="arb">
      <style>{CSS}</style>
      <header>
        <h1>Cash-Future Arbitrage · Net ROCE Scanner</h1>
        <div className="sub">NSE stock F&O · post-1-Apr-2026 STT (0.10% + 0.10% eq, 0.05% fut sell) · expiry {expiry} · {days} calendar days · E-{eN}
          {deliveryBadge && <span className="badge red">{deliveryBadge}</span>}</div>
        <div className="sub">Data: {source}{updated && running ? ` · simulated, last tick ${updated}` : ""}</div>
      </header>

      <section className="controls">
        <button className={running ? "pause" : "go"} onClick={() => setRunning(!running)}>{running ? "Pause simulation" : "Start 1-s simulation"}</button>
        <label>Target net ROCE %/30d<input type="number" step="0.1" value={p.targetRoce} onChange={set("targetRoce")} /></label>
        <label>Brokerage<select value={p.plan} onChange={set("plan")}><option value="INDMONEY">INDmoney Std (₹20)</option><option value="API">INDstocks API (₹10)</option></select></label>
        <label>Slippage %<input type="number" step="0.01" value={p.slippagePct} onChange={set("slippagePct")} /></label>
        <label>Fut margin %<input type="number" step="1" value={p.futMarginPct} onChange={set("futMarginPct")} /></label>
        <label>Expiry<input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></label>
        <label className="chk"><input type="checkbox" checked={p.pledge} onChange={set("pledge")} />Pledge cash shares (50:50)</label>
        <label className="chk"><input type="checkbox" checked={p.includeDeliveryMargin} onChange={set("includeDeliveryMargin")} />Add E-4..E-1 margin to capital</label>
        <label className="chk"><input type="checkbox" checked={p.useBidAsk} onChange={set("useBidAsk")} />Price at bid/ask (executable)</label>
      </section>
      <section className="controls">
        <label>Filter<select value={filterMode} onChange={(e) => setFilterMode(e.target.value)}>
          <option value="roce">Net monthly ROCE ≥ target</option><option value="flat">Flat net spread ≥ target</option><option value="none">Any net-positive</option></select></label>
        <label className="chk"><input type="checkbox" checked={hideReverse} onChange={(e) => setHideReverse(e.target.checked)} />Hide reverse arb (fut &lt; cash)</label>
        <input className="search" placeholder="Search symbol" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="hint">Capital = {(evald[0]?.capFactor * 100 || 0).toFixed(1)}% of notional · gross needed today for {p.targetRoce}% net: <b>{pct(reqExample)}</b></span>
      </section>

      <section>
        <h2>Top arbitrage opportunities ({top.length})</h2>
        {top.length === 0 && <div className="empty">No stock clears the cost hurdle at {days} day(s) to expiry. Near expiry the spread needs to be ≥ {pct(reqExample)} — doing nothing is the correct trade.</div>}
        <div className="cards">{top.map((r) => (
          <div key={r.sym} className="card" onClick={() => setSel(r.sym)}>
            <div className="ch"><b>{r.sym}</b><span className="roce">{pct(r.roce)}</span></div>
            <div>Cash {r.cashUsed} · Fut {r.futUsed} · lot {r.lot}</div>
            <div>Gross {pct(r.diffPct, 3)} vs breakeven {pct(r.costPct, 3)}</div>
            <div>Net {inr(r.net)} on {inr(r.capital)}</div>
            {deliveryBadge && <span className="badge red">Delivery margin alert</span>}
          </div>))}</div>
      </section>

      <section>
        <h2>All instruments</h2>
        <table><thead><tr><th>Stock</th><th>Lot</th><th>Cash</th><th>Future</th><th>Priced</th><th>Gross %</th><th>All-in cost %</th><th>Needed %</th><th>Days</th><th>Net ₹</th><th>Net ROCE %/30d</th><th>Old prompt %</th><th>Status</th></tr></thead>
          <tbody>{visible.map((r) => (
            <tr key={r.sym} onClick={() => setSel(r.sym)} className={passes(r) ? "ok" : ""}>
              <td><b>{r.sym}</b></td>
              <td><input className="lot" type="number" value={r.lot} onClick={(e) => e.stopPropagation()} onChange={(e) => setLot(r.sym, e.target.value)} /></td>
              <td>{r.cashUsed}</td><td>{r.futUsed}</td><td className="dim">{r.priced}</td>
              <td className={r.diffPct < 0 ? "neg" : ""}>{pct(r.diffPct, 3)}</td><td>{pct(r.costPct, 3)}</td><td>{pct(r.requiredPct, 3)}</td>
              <td>{days}</td><td className={r.net < 0 ? "neg" : "pos"}>{inr(r.net)}</td>
              <td className={r.roce < 0 ? "neg" : "pos"}><b>{pct(r.roce)}</b></td>
              <td className="dim">{pct(r.legacyPinnedPct)}</td>
              <td>{r.reverse ? <span className="badge grey">Reverse · SLBM</span> : passes(r) ? <span className="badge green">TRADE</span> : <span className="badge grey">Below hurdle</span>}
                {deliveryBadge && <span className="badge red">E-{eN}</span>}</td>
            </tr>))}</tbody></table>
        <div className="hint">“Old prompt %” = gross spread scaled to 30 days without costs — the number the original prompt would have pinned.</div>
      </section>

      <section className="data">
        <h2>Data in</h2>
        <p>Paste either an array <code>[{"{"}"sym","cash","fut","lot"{"}"}]</code> or the raw output of INDmoney MCP <code>get_indian_stocks_details</code> (spot + future keys together). CSV columns: <code>sym,cash,fut,lot[,cashAsk,futBid]</code>.</p>
        <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste JSON here" />
        <div className="row"><button onClick={onPaste}>Load pasted data</button><input type="file" accept=".csv,.json" onChange={onFile} />
          <button onClick={() => load(SNAPSHOT.rows, SNAPSHOT.asOf)}>Reset to 18-Nov snapshot</button>
          <button onClick={() => setShowPoller(!showPoller)}>Local live poller…</button><span className="hint">{msg}</span></div>
        {showPoller && <pre>{POLLER_HINT}</pre>}
      </section>

      {selected && (
        <aside className="drawer">
          <button className="x" onClick={() => setSel(null)}>×</button>
          <h2>{selected.sym} · agent risk check</h2>
          <p><b>Strategy:</b> {selected.reverse
            ? "Future below cash → reverse arb needs SLBM borrowing. Retail: avoid."
            : "Buy cash (delivery/CNC) + sell near-month future (NRML), same lot quantity, together. Use limit orders at the touch; check depth on both legs first."}</p>
          <table className="mini"><tbody>
            <tr><td>Notional</td><td>{inr(selected.notional)}</td></tr>
            <tr><td>Gross profit</td><td>{inr(selected.gross)}</td></tr>
            <tr><td>STT</td><td>{inr(selected.costs.stt)}</td></tr>
            <tr><td>Brokerage + exch + SEBI + stamp + DP/pledge + GST</td><td>{inr(selected.costs.statutory - selected.costs.stt)}</td></tr>
            <tr><td>Slippage ({p.slippagePct}%)</td><td>{inr(selected.costs.slippage)}</td></tr>
            <tr><td><b>Net profit</b></td><td><b>{inr(selected.net)}</b></td></tr>
            <tr><td>Capital deployed</td><td>{inr(selected.capital)}</td></tr>
            <tr><td>Net ROCE per 30 days / CAGR</td><td>{pct(selected.roce)} / {pct(selected.cagr)}</td></tr>
            <tr><td>Gross spread needed for {p.targetRoce}%</td><td>{pct(selected.requiredPct, 3)} (have {pct(selected.diffPct, 3)})</td></tr>
          </tbody></table>
          <h3>Confirm before entry</h3>
          <ul className="check">
            <li><input type="checkbox" /> Not in F&O ban (FutEq OI &lt; 95% of MWPL). In ban, new OI-increasing short futures can draw a penalty — don't enter.</li>
            <li><input type="checkbox" /> No ex-date before expiry. Ordinary dividend (&lt;2% of price) is <i>not</i> adjusted → the future trades at a discount and the spread is fake. Also check bonus/split/rights/merger.</li>
            <li><input type="checkbox" /> Cash and future quotes are from the same moment (here: {source}).</li>
            <li><input type="checkbox" /> Enough free cash for E-4…E-1 delivery margin ({deliveryBadge || "not yet in window"}).</li>
            <li><input type="checkbox" /> Both legs fill inside the price band; never leave one leg open.</li>
            <li><input type="checkbox" /> Exit plan: square off both legs together on E-1 or expiry day before the closing auction, or let it settle physically against the shares you hold.</li>
          </ul>
        </aside>)}
    </div>
  );
}

const CSS = `
.arb{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1d2330;background:#f6f7f9;padding:16px;font-size:14px;min-height:100vh}
.arb h1{font-size:20px;margin:0 0 4px}.arb h2{font-size:16px;margin:18px 0 8px}.arb h3{font-size:14px;margin:12px 0 6px}
.arb .sub{color:#5a6372;margin:2px 0}
.arb .controls{display:flex;flex-wrap:wrap;gap:10px;align-items:end;background:#fff;border:1px solid #e3e6eb;border-radius:8px;padding:10px;margin-top:10px}
.arb label{display:flex;flex-direction:column;font-size:12px;color:#5a6372;gap:3px}
.arb label.chk{flex-direction:row;align-items:center;gap:6px;color:#1d2330;font-size:13px}
.arb input,.arb select{font:inherit;padding:4px 6px;border:1px solid #cfd4dc;border-radius:5px;background:#fff}
.arb input[type=number]{width:80px}.arb .lot{width:70px}.arb .search{width:150px}
.arb button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #cfd4dc;background:#fff;cursor:pointer}
.arb button.go{background:#1f6f43;color:#fff;border-color:#1f6f43}.arb button.pause{background:#b3261e;color:#fff;border-color:#b3261e}
.arb .hint{color:#5a6372;font-size:12px}
.arb .cards{display:flex;flex-wrap:wrap;gap:10px}
.arb .card{background:#fff;border:1px solid #9cd3b0;border-left:4px solid #1f6f43;border-radius:8px;padding:10px;min-width:220px;cursor:pointer;line-height:1.6}
.arb .ch{display:flex;justify-content:space-between}.arb .roce{color:#1f6f43;font-weight:700}
.arb .empty{background:#fff8e6;border:1px solid #f0d58c;padding:10px;border-radius:8px}
.arb table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e6eb;border-radius:8px;overflow:hidden}
.arb th,.arb td{padding:6px 8px;border-bottom:1px solid #eef0f3;text-align:right;white-space:nowrap}
.arb th:first-child,.arb td:first-child{text-align:left}.arb th{background:#f0f2f5;font-size:12px;color:#5a6372}
.arb tbody tr{cursor:pointer}.arb tbody tr:hover{background:#f7f9fc}.arb tr.ok{background:#eefaf2}
.arb .neg{color:#b3261e}.arb .pos{color:#1f6f43}.arb .dim{color:#8a93a3}
.arb .badge{display:inline-block;font-size:11px;padding:2px 6px;border-radius:10px;margin-left:6px;font-weight:600}
.arb .badge.red{background:#fde7e5;color:#b3261e}.arb .badge.green{background:#dff3e6;color:#1f6f43}.arb .badge.grey{background:#eceff3;color:#5a6372}
.arb .data textarea{width:100%;height:90px;font-family:ui-monospace,monospace;font-size:12px}
.arb .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}
.arb pre{background:#1d2330;color:#e6e9ef;padding:10px;border-radius:6px;white-space:pre-wrap}
.arb .drawer{position:fixed;top:0;right:0;width:min(460px,100%);height:100%;overflow:auto;background:#fff;box-shadow:-4px 0 16px rgba(0,0,0,.15);padding:16px;z-index:10}
.arb .drawer .x{position:absolute;right:12px;top:10px;font-size:18px;padding:0 8px}
.arb .mini td{text-align:left}.arb .mini td:last-child{text-align:right}
.arb .check{padding-left:0;list-style:none}.arb .check li{margin:6px 0;line-height:1.4}
`;
