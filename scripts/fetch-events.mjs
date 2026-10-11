// Collects open hackathons from several sites and writes events.json.
// Run locally:  npm install && node scripts/fetch-events.mjs
// Each source is wrapped in try/catch: if one site breaks, the others still work,
// and the old events from the broken site are kept until it is fixed.

import { readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import {
  tagsFrom, stripHtml, parseRange, toISO, regionOk, normName,
  DATE_SEG, MODE_SEG, rangeInYear
} from "./lib.mjs";

const OUT = "events.json";
const MANUAL = "data/manual-events.json";
const UA = "Mozilla/5.0 (compatible; HackRadarBot/1.0)";
const now = Date.now();

async function getJSON(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(25000)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function getText(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: AbortSignal.timeout(25000)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

// ---------- Devpost (public JSON) ----------
async function devpost() {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const d = await getJSON(
      `https://devpost.com/api/hackathons?status[]=open&per_page=50&page=${page}`
    );
    const list = d.hackathons || [];
    for (const h of list) {
      const location = h.displayed_location?.location || "";
      const themes = (h.themes || []).map((t) => t.name);
      out.push({
        id: `devpost-${h.id}`,
        source: "Devpost",
        name: h.title,
        url: h.url,
        date: parseRange(h.submission_period_dates),
        location,
        online: /online/i.test(location),
        prize: stripHtml(h.prize_amount || ""),
        org: h.organization_name || "",
        tags: tagsFrom([h.title, ...themes].join(" "))
      });
    }
    if (list.length < 50) break;
  }
  return out;
}

// ---------- Unstop (public JSON, field names are guessed defensively) ----------
async function unstop() {
  const out = [];
  for (const kind of ["hackathons", "competitions"]) {
    const d = await getJSON(
      `https://unstop.com/api/public/opportunity/search-result?opportunity=${kind}&per_page=30&oppstatus=open`
    );
    const list = d?.data?.data || [];
    for (const o of list) {
      const link = o.public_url || "";
      const url = link.startsWith("http") ? link : `https://unstop.com/${link.replace(/^\//, "")}`;
      const date = toISO(o.regnRequirements?.end_regn_dt || o.end_regn_dt || o.end_date);
      const text = [o.title, o.organisation?.name].join(" ");
      out.push({
        id: `unstop-${o.id}`,
        source: "Unstop",
        name: o.title,
        url,
        date,
        location: o.region === "online" || o.region === "Online" ? "Online" : "",
        online: /online/i.test(String(o.region || "")),
        prize: "",
        org: o.organisation?.name || "",
        tags: tagsFrom(text)
      });
    }
  }
  return out;
}

// ---------- Helper: the visible text pieces inside one card ----------
function segmentsOf(el) {
  const segs = [];
  const walk = (n) => {
    if (n.type === "text") {
      const t = n.data.replace(/\s+/g, " ").trim();
      if (t) segs.push(t);
    } else if (n.children && n.name !== "script" && n.name !== "style") {
      n.children.forEach(walk);
    }
  };
  walk(el);
  return segs;
}

// ---------- MLH (reads the HTML page; mostly in-person events) ----------
async function mlh() {
  const d = new Date();
  const season = d.getUTCMonth() >= 7 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  const html = await getText(`https://www.mlh.com/seasons/${season}/events`);
  const $ = cheerio.load(html);
  const out = [];
  const samples = [];
  let year = d.getUTCFullYear();
  let stop = false;

  $("h2, h3, a").each((_, el) => {
    if (stop) return;
    const txt = $(el).text().replace(/\s+/g, " ").trim();
    if (el.name === "h2" && /past/i.test(txt)) { stop = true; return; }
    if (el.name === "h3" && /^\d{4}$/.test(txt)) { year = Number(txt); return; }
    if (el.name !== "a") return;

    const segs = segmentsOf(el);
    if (samples.length < 3 && segs.length > 3) samples.push(segs.join(" | "));
    const di = segs.findIndex((x) => DATE_SEG.test(x));
    const mode = segs.find((x) => MODE_SEG.test(x));
    const href = $(el).attr("href");
    if (di < 1 || !mode || !href) return;

    const name = segs[di - 1];
    const loc = segs[di + 1] && !MODE_SEG.test(segs[di + 1]) ? segs[di + 1] : "";
    out.push({
      id: `mlh-${normName(name).replace(/ /g, "-")}-${year}`,
      source: "MLH",
      name,
      url: href,
      date: rangeInYear(segs[di], year),
      location: loc,
      online: /digital|online/i.test(mode),
      prize: "",
      org: "Major League Hacking",
      tags: tagsFrom(name)
    });
  });

  if (!out.length) {
    console.log("MLH debug, sample cards:", samples);
    throw new Error("No events parsed (page layout may have changed)");
  }
  return out;
}

// ---------- Lablab.ai (reads the home page cards) ----------
async function lablab() {
  const html = await getText("https://lablab.ai");
  const $ = cheerio.load(html);
  const out = [];
  const samples = [];
  const seen = new Set();
  const thisYear = new Date().getUTCFullYear();

  $('a[href*="/ai-hackathons/"]').each((_, el) => {
    const href = $(el).attr("href") || "";
    const url = new URL(href, "https://lablab.ai").href;
    const slug = (url.split("/ai-hackathons/")[1] || "").split(/[/?#]/)[0];
    if (!slug || seen.has(slug)) return;

    const segs = segmentsOf(el);
    if (samples.length < 3 && segs.length > 3) samples.push(segs.join(" | "));
    if (segs.some((x) => /^finished$/i.test(x))) return;
    const di = segs.findIndex((x) => DATE_SEG.test(x));
    if (di < 0) return;
    const name = segs.slice(di + 1).find((x) => !/^\d+$/.test(x));
    if (!name) return;

    const mode = segs.find((x) => MODE_SEG.test(x)) || "Online";
    const inPerson = /in-?person|on-?site/i.test(mode);
    let date = rangeInYear(segs[di], thisYear);
    if (date && Date.parse(date) < now - 60 * 864e5) date = rangeInYear(segs[di], thisYear + 1);

    seen.add(slug);
    out.push({
      id: `lablab-${slug}`,
      source: "Lablab.ai",
      name,
      url,
      date,
      location: inPerson ? "On-site" : "Online",
      online: !inPerson,
      prize: "",
      org: "lablab.ai",
      tags: Array.from(new Set(["ai", ...tagsFrom(name)]))
    });
  });

  if (!out.length) {
    console.log("Lablab debug, sample cards:", samples);
    throw new Error("No upcoming events found (page layout may have changed)");
  }
  return out;
}

// ---------- Manual events you add by hand ----------
async function manual() {
  try {
    const list = JSON.parse(await readFile(MANUAL, "utf8"));
    return list.map((e, i) => ({
      id: e.id || `manual-${i}-${normName(e.name).replace(/ /g, "-")}`,
      source: e.source || "Manual",
      name: e.name,
      url: e.url || "",
      date: toISO(e.date),
      location: e.location || "",
      online: !!e.online,
      prize: e.prize || "",
      org: e.org || "",
      tags: e.tags && e.tags.length ? e.tags : tagsFrom(e.name)
    }));
  } catch {
    return [];
  }
}

// ---------- Run everything ----------
const SOURCES = { Devpost: devpost, Unstop: unstop, MLH: mlh, "Lablab.ai": lablab };

let old = { events: [] };
try { old = JSON.parse(await readFile(OUT, "utf8")); } catch { /* first run */ }

const status = {};
let all = [];

for (const [name, fn] of Object.entries(SOURCES)) {
  try {
    const list = (await fn()).filter((e) => e.name);
    status[name] = `ok (${list.length})`;
    all.push(...list);
    console.log(`✔ ${name}: ${list.length} events`);
  } catch (err) {
    // Keep the previous results from this source so the site is not empty.
    const kept = (old.events || []).filter((e) => e.source === name);
    status[name] = `failed: ${err.message} (kept ${kept.length} old)`;
    all.push(...kept);
    console.warn(`✖ ${name} failed: ${err.message}`);
  }
}

all.push(...(await manual()));

// Keep: not ended, in the right region. Remove duplicates by name.
const seen = new Set();
const events = all
  .filter((e) => !e.date || Date.parse(e.date) >= now)
  .filter(regionOk)
  .filter((e) => {
    const key = normName(e.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })
  .sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return Date.parse(a.date) - Date.parse(b.date);
  });

// Do not overwrite a good file with an empty one when everything failed.
if (!events.length && (old.events || []).length) {
  console.warn("No events collected; keeping the previous events.json");
  process.exit(0);
}

const same = JSON.stringify(old.events) === JSON.stringify(events) &&
             JSON.stringify(old.sources) === JSON.stringify(status);
if (same) {
  console.log("No changes.");
} else {
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), sources: status, events }, null, 2));
  console.log(`Wrote ${events.length} events to ${OUT}`);
}
