import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHANNEL_USERNAME =
  (process.env.TELEGRAM_CHANNEL_USERNAME || "loycewear").replace("@", "").trim();

const VK_TMR_ID = process.env.VK_TMR_ID || "";
const YM_COUNTER_ID = process.env.YM_COUNTER_ID || "";

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

app.get("/", (req, res) => res.type("text").send("OK"));

function getAlbumKey(row) {
  const raw = row.raw || {};
  const mg = raw.media_group_id ?? raw.grouped_id;
  return mg ? `album:${mg}` : `msg:${row.message_id}`;
}

function pickBestText(rows) {
  // Берем первую непустую подпись в группе (как в телеге)
  for (const r of rows) {
    const t = (r.text || "").trim();
    if (t) return t;
  }
  return "";
}

function makePermalink(channel, messageId) {
  return `https://t.me/${channel}/${messageId}`;
}

async function tgMemberCount(channelUsername) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChatMemberCount?chat_id=@${encodeURIComponent(
        channelUsername
      )}`
    );
    const j = await r.json();
    if (j.ok && typeof j.result === "number") return j.result;
    return null;
  } catch {
    return null;
  }
}

// ===== stats =====
app.get("/api/stats", async (req, res) => {
  const channelUsername = (req.query.channel || TELEGRAM_CHANNEL_USERNAME)
    .replace("@", "")
    .trim();

  // 1) Supabase table (если у тебя настроено)
  const { data, error } = await supabaseAdmin
    .from("telegram_channel_stats")
    .select("channel_username,subscribers_count,updated_at")
    .eq("channel_username", channelUsername)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (!error) {
    const row = (data || [])[0];
    if (row?.subscribers_count != null) {
      return res.json({
        channel_username: channelUsername,
        subscribers_count: row.subscribers_count,
        updated_at: row.updated_at,
        source: "supabase",
      });
    }
  }

  // 2) Fallback: Telegram Bot API (бот должен иметь доступ к каналу)
  const cnt = await tgMemberCount(channelUsername);
  return res.json({
    channel_username: channelUsername,
    subscribers_count: cnt,
    updated_at: null,
    source: "telegram",
  });
});

// ===== posts: albums + thumb/full + pagination =====
app.get("/api/posts", async (req, res) => {
  const limitGroups = Math.min(parseInt(req.query.limit || "10", 10), 50);
  const channelUsername = (req.query.channel || TELEGRAM_CHANNEL_USERNAME)
    .replace("@", "")
    .trim();
  const cursor = req.query.cursor ? String(req.query.cursor) : null;

  // 1 альбом = несколько строк, берем запас
  const fetchRows = Math.min(limitGroups * 25, 1200);

  let q = supabaseAdmin
    .from("telegram_posts")
    .select("channel_username,message_id,posted_at,text,permalink,raw,media_urls")
    .eq("channel_username", channelUsername);

  if (cursor) {
    q = q.lt("posted_at", cursor); // старее курсора
  }

  const { data, error } = await q
    .order("posted_at", { ascending: false })
    .limit(fetchRows);

  if (error) return res.status(500).json({ error: error.message });

  const map = new Map();
  for (const row of data || []) {
    const key = getAlbumKey(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }

  let groups = Array.from(map.values());

  groups.sort((a, b) => {
    const ta = Math.max(...a.map((x) => new Date(x.posted_at).getTime()));
    const tb = Math.max(...b.map((x) => new Date(x.posted_at).getTime()));
    return tb - ta;
  });

  groups = groups.slice(0, limitGroups);

  const items = groups.map((rows) => {
    rows.sort((a, b) => a.message_id - b.message_id);

    const first = rows[0];
    const minId = first.message_id;

    // Собираем изображения группы: [{thumb, full}, ...]
    const images = [];
    for (const r of rows) {
      const arr = r.media_urls;
      if (Array.isArray(arr)) {
        for (const x of arr) {
          if (x && typeof x === "object") {
            images.push({ thumb: x.thumb || null, full: x.full || null });
          } else if (typeof x === "string") {
            // совместимость со старым форматом
            images.push({ thumb: x, full: x });
          }
        }
      }
    }

    // raw нужен для entities (скрытые ссылки TextUrl)
    return {
      channel_username: channelUsername,
      message_id: minId,
      posted_at: first.posted_at,
      text: pickBestText(rows),
      permalink: makePermalink(channelUsername, minId),
      images,
      raw: first.raw || {},
    };
  });

  const next_cursor = items.length ? items[items.length - 1].posted_at : null;
  res.json({ items, next_cursor });
});

// ===== widget UI =====
app.get("/widget", (req, res) => {
  const channel = (req.query.channel || TELEGRAM_CHANNEL_USERNAME).replace("@", "").trim();
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 50);

  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Telegram-лента @${channel}</title>
<style>
  :root{
    --tg:#229ED9;
    --tg-dark:#1C8ABF;
    --bg:#ffffff;
    --card:#ffffff;
    --text:#0f172a;
    --muted:#64748b;
    --border:#e5e7eb;
    --shadow: 0 10px 30px rgba(2, 6, 23, .10);
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--text);}
  .wrap{width:100%;margin:0 auto;padding:14px;}
  .widget{border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);overflow:hidden;background:var(--bg);}
  .head{padding:14px 14px 10px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;justify-content:space-between;gap:10px;}
  .title{font-weight:900;font-size:16px;line-height:1.2;}
  .subline{margin-top:6px;display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13px;}
  .online{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--border);border-radius:999px;background:#f8fafc;color:#0f172a;font-size:12px;font-weight:800;white-space:nowrap;}
  .dot{width:10px;height:10px;border-radius:999px;background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.15);}
  .hint{margin:10px 14px 0;padding:10px 12px;border:1px dashed rgba(34,158,217,.35);background:rgba(34,158,217,.06);border-radius:12px;font-size:13px;}
  .feed{height:640px;overflow:auto;padding:12px 12px 12px;background:#f8fafc;}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:12px;margin-bottom:12px;box-shadow:0 6px 18px rgba(2,6,23,.06);}
  .meta{display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:12px;margin-bottom:8px;}
  .text{font-size:14px;line-height:1.45;white-space:pre-wrap;}
  .text a{color:var(--tg-dark);text-decoration:none;font-weight:800;}
  .text a:hover{text-decoration:underline;}

  /* Telegram-like grid */
  .grid{ margin-top:10px; display:grid; gap:8px; }
  .grid.cols-1{ grid-template-columns:1fr; }
  .grid.cols-2{ grid-template-columns:1fr 1fr; }
  .grid.cols-3{ grid-template-columns:1fr 1fr 1fr; }
  .grid .cell{
    border-radius:14px;
    overflow:hidden;
    border:1px solid var(--border);
    background:#fff;
    aspect-ratio:1/1;
  }
  .grid .cell img{
    width:100%; height:100%;
    object-fit:cover;
    display:block;
    cursor:pointer;
  }
  @media (max-width:480px){
    .feed{height:560px}
    .grid.cols-3{ grid-template-columns:1fr 1fr; }
  }

  .actions{margin-top:12px;display:flex;justify-content:flex-end;}
  .btn{display:inline-flex;align-items:center;gap:10px;padding:10px 14px;border-radius:999px;border:1px solid rgba(34,158,217,.35);background:rgba(34,158,217,.10);color:var(--tg-dark);font-weight:900;text-decoration:none;transition:.15s;}
  .btn:hover{background:rgba(34,158,217,.16);border-color:rgba(34,158,217,.55);}
  .plane{width:18px;height:18px;fill:var(--tg-dark);}

  .moreWrap{padding: 0 12px 14px; background:#f8fafc;}
  .moreBtn{
    width:100%;
    padding:12px 14px;
    border-radius:14px;
    border:1px solid rgba(34,158,217,.35);
    background: rgba(34,158,217,.10);
    color:#1C8ABF;
    font-weight:900;
    cursor:pointer;
  }

  .footer{padding:10px 14px;border-top:1px solid var(--border);background:#fff;color:var(--muted);font-size:12px;text-align:center;}

  /* Lightbox */
  .lb{
    position:fixed; inset:0;
    background: rgba(15,23,42,.72);
    display:none;
    align-items:center;
    justify-content:center;
    padding: 18px;
    z-index: 9999;
  }
  .lb.show{display:flex;}
  .lb img{
    max-width: min(920px, 96vw);
    max-height: 92vh;
    border-radius: 16px;
    border: 1px solid rgba(255,255,255,.25);
    box-shadow: 0 20px 70px rgba(0,0,0,.45);
    background:#fff;
  }
  .lbClose{
    position:fixed;
    top:14px; right:14px;
    width:44px; height:44px;
    border-radius:999px;
    border:1px solid rgba(255,255,255,.25);
    background: rgba(255,255,255,.12);
    color:#fff;
    font-weight:900;
    cursor:pointer;
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="widget">
    <div class="head">
      <div>
        <div class="title">Telegram-лента канала @${channel}</div>
        <div class="subline">
          <span class="online"><span class="dot"></span>Online</span>
          <span id="subs">Подписчиков: …</span>
        </div>
      </div>
    </div>

    <div class="hint">Посты можно прокручивать <b>внутри этого блока</b>.</div>

    <div id="feed" class="feed"></div>

    <div class="moreWrap">
      <button id="moreBtn" class="moreBtn">Показать ещё</button>
    </div>

    <div class="footer">Прокрутите внутри блока, чтобы увидеть ещё посты ↓</div>
  </div>
</div>

<div id="lb" class="lb" role="dialog" aria-modal="true">
  <button id="lbClose" class="lbClose">✕</button>
  <img id="lbImg" alt=""/>
</div>

${VK_TMR_ID ? `
<script type="text/javascript">
var _tmr = window._tmr || (window._tmr = []);
_tmr.push({id: "${VK_TMR_ID}", type: "pageView", start: (new Date()).getTime()});
(function (d, w, id) {
  if (d.getElementById(id)) return;
  var ts = d.createElement("script"); ts.type = "text/javascript"; ts.async = true; ts.id = id;
  ts.src = "https://top-fwz1.mail.ru/js/code.js";
  var f = function () {var s = d.getElementsByTagName("script")[0]; s.parentNode.insertBefore(ts, s);};
  if (w.opera == "[object Opera]") { d.addEventListener("DOMContentLoaded", f, false); } else { f(); }
})(document, window, "tmr-code");
</script>
<noscript><div><img src="https://top-fwz1.mail.ru/counter?id=${VK_TMR_ID};js=na" style="position:absolute;left:-9999px;" alt="Top.Mail.Ru" /></div></noscript>
` : ""}

${YM_COUNTER_ID ? `
<script type="text/javascript">
(function(m,e,t,r,i,k,a){
  m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
  m[i].l=1*new Date();
  k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)
})(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");
ym(${YM_COUNTER_ID}, "init", { clickmap:true, trackLinks:true, accurateTrackBounce:true, webvisor:false });
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/${YM_COUNTER_ID}" style="position:absolute; left:-9999px;" alt="" /></div></noscript>
` : ""}

<script type="module">
  const CHANNEL = ${JSON.stringify(channel)};
  const LIMIT = ${JSON.stringify(limit)};

  const feed = document.getElementById("feed");
  const subsEl = document.getElementById("subs");
  const moreBtn = document.getElementById("moreBtn");

  const lb = document.getElementById("lb");
  const lbImg = document.getElementById("lbImg");
  const lbClose = document.getElementById("lbClose");

  let cursor = null;

  function fmtDate(iso){
    const dt = iso ? new Date(iso) : null;
    if (!dt) return "";
    return dt.toLocaleString("ru-RU", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
  }

  function escapeHtml(s){
    return (s || "").replace(/[&<>"']/g, (m)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
  }

  // Делает кликабельными обычные ссылки + скрытые TextUrl (entities)
  function renderTelegramText(text, raw){
    const t = text || "";
    const entities = raw?.entities || raw?.caption_entities || [];
    if (!Array.isArray(entities) || !entities.length) {
      // fallback: http(s)
      return escapeHtml(t).replace(/(https?:\\/\\/[^\\s<]+)/g, (m)=>\`<a href="\${m}" target="_blank" rel="noopener">\${m}</a>\`)
                         .replace(/(^|\\s)(t\\.me\\/[A-Za-z0-9_\\/\\-\\?=&#.%]+)/g, (all, sp, path)=>{
