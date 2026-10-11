// Collects open hackathons from several sites and writes events.json.
// Run locally:  npm install && node scripts/fetch-events.mjs
// Each source is wrapped in try/catch: if one site breaks, the others still work,
// and the old events from the broken site are kept until it is fixed.

import { readFile, writeFile } from "node:fs/promises";
import * as cheerio from "cheerio";
import {
  tagsFrom, stripHtml, parseRange, toISO, regionOk, findEvents, normName
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

// ---------- MLH (reads the HTML page) ----------
async function mlh() {
  const d = new Date();
  const season = d.getUTCMonth() >= 7 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
  const html = await getText(`https://mlh.io/seasons/${season}/events`);
  const $ = cheerio.load(html);
  const out = [];
  $(".event").each((_, el) => {
    const $e = $(el);
    const name = $e.find(".event-name, [itemprop=name]").first().text().trim();
    const url = $e.find("a.event-link").attr("href") || $e.find("a").first().attr("href");
    const end = $e.find("meta[itemprop=endDate]").attr("content");
    const text = $e.text().replace(/\s+/g, " ").trim();
    if (!name || !url) return;
    out.push({
      id: `mlh-${normName(name).replace(/ /g, "-")}`,
      source: "MLH",
      name,
      url,
      date: toISO(end),
      location: $e.find(".event-location").text().replace(/\s+/g, " ").trim(),
      online: /digital|online/i.test(text),
      prize: "",
      org: "Major League Hacking",
      tags: tagsFrom(name)
    });
  });
  return out;
}

// ---------- Lablab.ai (reads data embedded in the page) ----------
async function lablab() {
  const html = await getText("https://lablab.ai/event");
  const $ = cheerio.load(html);
  const raw = $("#__NEXT_DATA__").text();
  if (!raw) throw new Error("No embedded data found on lablab.ai");
  const found = findEvents(JSON.parse(raw));
  const seen = new Set();
  const out = [];
  for (const e of found) {
    if (seen.has(e.slug)) continue;
    seen.add(e.slug);
    const name = e.name || e.title;
    out.push({
      id: `lablab-${e.slug}`,
      source: "Lablab.ai",
      name,
      url: `https://lablab.ai/event/${e.slug}`,
      date: toISO(e.endDate || e.endsAt || e.end_date || e.startDate || e.startsAt || e.start_date),
      location: "Online",
      online: true,
      prize: "",
      org: "",
      tags: Array.from(new Set(["ai", ...tagsFrom(name)]))
    });
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
