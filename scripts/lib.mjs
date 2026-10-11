// Small helpers, kept free of dependencies so they are easy to test.

export const TAG_RULES = {
  health: /health|medic|clinic|bio|care|hospital|pharma/i,
  ai: /\bai\b|artificial|machine learning|\bml\b|llm|gpt|agent|generative/i,
  data: /\bdata\b|analytics|kaggle|dataset/i,
  web: /\bweb\b|\bapp\b|software|mobile|developer|open source|cloud|hack/i,
  blockchain: /blockchain|web3|crypto|ethereum|solana|defi|bitcoin/i,
  fintech: /fintech|finance|payment|bank|commerce|business|startup|entrepreneur/i,
  climate: /climate|agri|farm|energy|sustainab|environment|green/i,
  education: /education|learn|school|edtech|student/i,
  security: /security|cyber|privacy/i
};

export function tagsFrom(text = "") {
  const tags = Object.entries(TAG_RULES)
    .filter(([, rx]) => rx.test(text))
    .map(([tag]) => tag);
  return tags.length ? tags : ["web"];
}

export function stripHtml(s = "") {
  return String(s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

// Turns "Oct 06 - Nov 10, 2026", "Oct 06, 2026 - Jan 12, 2027" or
// "Nov 03 - 10, 2026" into an ISO string for the END of the range (23:59 UTC).
export function parseRange(str, today = new Date()) {
  if (!str) return null;
  const parts = String(str).split(/\s[-–]\s/);
  const start = parts[0].trim();
  let end = (parts[1] || parts[0]).trim();

  const MONTH = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
  if (!MONTH.test(end)) {
    const m = start.match(/[A-Za-z]{3,}/);
    if (m && MONTH.test(m[0])) end = `${m[0]} ${end}`;
  }
  if (!MONTH.test(end)) return null;
  if (!/\d{4}/.test(end)) {
    const y = start.match(/\d{4}/);
    end = `${end}, ${y ? y[0] : today.getUTCFullYear()}`;
  }
  const t = Date.parse(`${end} 23:59:00 UTC`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function toISO(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Keep online events and events in or near Africa. Empty location = keep.
const AFRICA = /africa|rwanda|kigali|kenya|nairobi|uganda|kampala|tanzania|nigeria|lagos|ghana|accra|ethiopia|egypt|morocco|south africa|cape town|global|worldwide|anywhere/i;
export function regionOk(ev) {
  if (ev.online) return true;
  if (!ev.location) return true;
  return AFRICA.test(ev.location);
}

// Walk any JSON and collect objects that look like events (used for Next.js pages).
export function findEvents(node, acc = []) {
  if (Array.isArray(node)) {
    node.forEach((n) => findEvents(n, acc));
  } else if (node && typeof node === "object") {
    const hasName = node.name || node.title;
    const hasDate = node.endDate || node.endsAt || node.end_date || node.startDate || node.startsAt || node.start_date;
    if (node.slug && hasName && hasDate) acc.push(node);
    Object.values(node).forEach((v) => findEvents(v, acc));
  }
  return acc;
}

export function normName(s = "") {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ---------- Dates written like "OCT 09 - 11", "SEP 1 - DEC 1", "NOV 3 - 8" ----------
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const M = "(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\\.?";
export const DATE_SEG = new RegExp(`^${M}\\s+\\d{1,2}(\\s*[-–]\\s*(${M}\\s+)?\\d{1,2})?$`, "i");
export const MODE_SEG = /^(in-?person|digital( only)?|online|hybrid|on-?site)$/i;

// Turns "OCT 31 - NOV 01" + 2026 into an ISO end date. If the end month comes
// before the start month (e.g. DEC - JAN) the end falls in the next year.
export function rangeInYear(text, year) {
  const parts = String(text).split(/\s*[-–]\s*/);
  const s = parts[0].trim();
  const e = (parts[1] || parts[0]).trim();
  const idx = (x) => {
    const m = x.match(/[A-Za-z]{3}/);
    return m ? MON.indexOf(m[0].toLowerCase()) : -1;
  };
  const sm = idx(s);
  const em = /[A-Za-z]{3}/.test(e) ? idx(e) : sm;
  const endYear = em < sm ? year + 1 : year;
  return parseRange(`${s}, ${year} - ${e}, ${endYear}`);
}
