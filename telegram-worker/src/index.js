// umania Telegram alerts: checks NEPTUN once a minute and posts to a Telegram channel
// when the Uman area alert starts/ends, and when a target comes close to Uman.

const API = "https://neptun.in.ua/api/v1";
const UMAN = { lat: 48.7484, lon: 30.2218 };
const RAION = "Уманський район";
const OBLAST = "Черкаська область";
const SITE = "https://umania.app";
const BANDS = [15, 30, 50];          // km bands that trigger a message (closest first)
const STALE_MIN = 15;

const TYPE_HE = {
  uav: "רחפן תקיפה (שאהד)", recon: "רחפן צילום", missile: "טיל שיוט", ballistic: "טיל בליסטי",
  kab: "פצצה מונחית", mig31k: "המראת ⁨MiG-31K⁩", fpv: "רחפן ⁨FPV⁩", unknown: "מטרה לא מזוהה"
};
const DIR_ADJ = ["צפונית", "צפון־מזרחית", "מזרחית", "דרום־מזרחית", "דרומית", "דרום־מערבית", "מערבית", "צפון־מערבית"];
const DIR = ["צפון", "צפון־מזרח", "מזרח", "דרום־מזרח", "דרום", "דרום־מערב", "מערב", "צפון־מערב"];

const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
function distKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
const sector = b => Math.round(b / 45) % 8;
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
const hhmm = iso => new Date(iso).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" });

async function getJson(path) {
  const r = await fetch(API + path, { headers: { "user-agent": "umania-telegram (umania.app)" } });
  if (!r.ok) throw new Error(path + " " + r.status);
  return r.json();
}

async function send(env, text) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.CHANNEL, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  if (!r.ok) console.log("telegram error", r.status, await r.text());
}

function describe(t) {
  const p = { lat: t.lat, lon: t.lon };
  const dist = distKm(UMAN, p);
  const hdg = t.velocity && typeof t.velocity.bearingDeg === "number" ? t.velocity.bearingDeg : (typeof t.heading === "number" ? t.heading : null);
  let move = "כיוון לא ידוע";
  let approaching = false;
  if (hdg !== null) {
    const d = angDiff(hdg, bearing(p, UMAN));
    const cross = Math.abs(dist * Math.sin(rad(d)));
    if (d < 90 && cross < 25) { move = "בכיוון אומן"; approaching = true; }
    else if (d < 90 && cross < 60) move = "חולף בצד";
    else move = "מתרחק";
  }
  return { dist, dirAdj: DIR_ADJ[sector(bearing(UMAN, p))], heading: hdg === null ? null : DIR[sector(hdg)], move, approaching };
}

async function run(env) {
  const [tr, ar] = await Promise.all([getJson("/threats"), getJson("/alerts")]);
  const prevRaw = (await env.STATE.get("state")) || "{}";
  const prev = JSON.parse(prevRaw);
  const state = { alert: prev.alert || null, sent: prev.sent || {} };
  const msgs = [];

  // 1. Alert start / end for the Uman area
  const raion = (ar.raions || []).find(r => r.name === RAION) || (ar.oblasts || []).find(o => o.name === OBLAST);
  const nowAlert = raion ? raion.since : null;
  if (nowAlert && state.alert !== nowAlert) {
    msgs.push(`🔴 <b>התרעה באזור אומן</b>\nהיכנסו למקום מוגן והישארו בו עד סוף ההתרעה.\n\nמפה חיה:\n${SITE}`);
  } else if (!nowAlert && state.alert) {
    msgs.push(`🟢 <b>ההתרעה באזור אומן הסתיימה</b> (${hhmm(new Date().toISOString())})`);
  }
  state.alert = nowAlert;

  // 2. Missiles anywhere (once per track)
  // 3. Targets entering 50 / 30 / 15 km of Uman
  const seen = {};
  for (const t of tr.threats || []) {
    if (t.status === "resolved" || t.advisory) continue;
    if (t.updatedAt && (Date.now() - new Date(t.updatedAt)) / 60000 > STALE_MIN) continue;
    seen[t.id] = true;
    const label = TYPE_HE[t.type] || TYPE_HE.unknown;
    const cnt = t.count > 1 ? ` × ${t.count}` : "";

    if (["missile", "ballistic", "mig31k"].includes(t.type) && !state.sent[t.id]) {
      state.sent[t.id] = 999;
      msgs.push(`🚀 <b>${label}${cnt}</b> באוקראינה. טילים מגיעים תוך דקות. אם יש התרעה באזור, היכנסו למקום מוגן.\n\n${SITE}`);
      continue;
    }
    if (t.areaOnly || typeof t.lat !== "number") continue;
    const d = describe(t);
    const band = BANDS.find(b => d.dist <= b);
    if (!band) continue;
    const last = state.sent[t.id] || 999;
    // announce when a target reaches a closer band; for the 50 km band only if it heads toward Uman
    if (band < last && (band <= 30 || d.approaching)) {
      state.sent[t.id] = band;
      const icon = d.approaching || band <= 15 ? "⚠️" : "🟡";
      msgs.push(`${icon} <b>${label}${cnt}</b>\n${Math.round(d.dist)} ק״מ ${d.dirAdj} לאומן` +
        (d.heading ? `, טס לכיוון ${d.heading}` : "") + `.\n${d.move === "בכיוון אומן" ? "<b>בכיוון אומן.</b>" : d.move + "."}\n\n${SITE}`);
    }
  }
  // forget tracks that disappeared
  for (const id of Object.keys(state.sent)) if (!seen[id]) delete state.sent[id];

  for (const m of msgs) await send(env, m);
  // write only when something changed (free plan allows ~1,000 writes a day)
  const next = JSON.stringify(state);
  if (next !== prevRaw) await env.STATE.put("state", next);
  return msgs.length;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(run(env).catch(e => console.log("run failed", e.message)));
  },
  // GET /status just reports health (no secrets)
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === "/status") {
      const s = await env.STATE.get("state");
      return new Response(JSON.stringify({ ok: true, hasToken: !!env.BOT_TOKEN, channel: env.CHANNEL, state: s ? JSON.parse(s) : null }), { headers: { "content-type": "application/json" } });
    }
    return new Response("umania telegram worker", { status: 200 });
  }
};
