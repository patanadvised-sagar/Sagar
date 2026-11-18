#!/usr/bin/env node
// Local 1-second cash-future scanner. Runs on YOUR machine (Claude artifacts cannot open sockets).
//
//   node tools/indstocks_poller.mjs --file snapshot.json          # replay a saved JSON (no API needed)
//   INDSTOCKS_TOKEN=... node tools/indstocks_poller.mjs --symbols symbols.csv
//
// symbols.csv: sym,cashId,futId,lot   (instrument ids in whatever format your broker API uses)
//
// !! fetchQuotes() below is an ADAPTER STUB. The INDstocks docs were not reachable when this was
// written, so the endpoint path, id format and response fields are NOT verified. Fill them in from
// the official INDstocks API docs before use. Everything else (costs, ROCE, ranking) is tested.
import fs from "node:fs";
import { evaluate, nextExpiry, calendarDays, tradingDaysLeft, DEFAULTS } from "../src/calc.js";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const expiry = arg("expiry", nextExpiry(today));
const target = +arg("target", DEFAULTS.targetRoce);
const p = { ...DEFAULTS, targetRoce: target, plan: arg("plan", "API") };
const ctx = { days: calendarDays(today, expiry), eN: tradingDaysLeft(today, expiry) };

async function fetchQuotes(universe) {
  const token = process.env.INDSTOCKS_TOKEN;
  if (!token) throw new Error("set INDSTOCKS_TOKEN or use --file");
  // ---- ADAPTER: replace URL, auth header, id format and field mapping with the documented ones ----
  const ids = universe.flatMap((u) => [u.cashId, u.futId]).join(",");
  const res = await fetch(`https://api.indstocks.com/market/quotes/full?scrip-codes=${encodeURIComponent(ids)}`,
    { headers: { Authorization: token } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const q = body.data || body;          // VERIFY
  return universe.map((u) => ({
    sym: u.sym, lot: u.lot,
    cash: q[u.cashId]?.live_price, cashAsk: q[u.cashId]?.ask_price,   // VERIFY field names
    fut: q[u.futId]?.live_price, futBid: q[u.futId]?.bid_price,
  })).filter((r) => r.cash && r.fut);
  // ---------------------------------------------------------------------------------------------
}

function loadUniverse() {
  const [, ...lines] = fs.readFileSync(arg("symbols"), "utf8").trim().split(/\r?\n/);
  return lines.map((l) => { const [sym, cashId, futId, lot] = l.split(",").map((s) => s.trim()); return { sym, cashId, futId, lot: +lot }; });
}

async function tick() {
  const rows = arg("file") ? JSON.parse(fs.readFileSync(arg("file"), "utf8")) : await fetchQuotes(loadUniverse());
  const out = rows.map((r) => evaluate(r, ctx, p)).filter((r) => !r.reverse).sort((a, b) => b.roce - a.roce);
  console.clear();
  console.log(`${new Date().toLocaleTimeString("en-IN", { hour12: false })}  expiry ${expiry}  days ${ctx.days}  E-${ctx.eN}  target ${target}%`);
  console.table(out.slice(0, 25).map((r) => ({
    sym: r.sym, gross: r.diffPct.toFixed(3) + "%", need: r.requiredPct.toFixed(3) + "%",
    net: Math.round(r.net), roce: r.roce.toFixed(2) + "%", trade: r.meetsTarget && r.net > 0 ? "YES" : "",
  })));
  fs.writeFileSync("snapshot.json", JSON.stringify(rows));
}

const loop = async () => { try { await tick(); } catch (e) { console.error(e.message); } setTimeout(loop, 1000); };
loop();
