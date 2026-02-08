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

const VK_TMR_ID = process.env.VK_TMR_ID || ""; // 3738381
const YM_COUNTER_ID = process.env.YM_COUNTER_ID || ""; // 82720792

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

  // 1) пробуем таблицу telegram_channel_stats
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

  // 2) fallback: Telegram Bot API
  const cnt = await tgMemberCount(channelUsername);
  return res.json({
    channel_username: channelUsername,
    subscribers_count: cnt,
    updated_at: null,
    source: "telegram",
  });
});

// ===== posts (albums + media_urls) =====
app.get("/api/posts", async (req, res) => {
  const limitGroups = Math.min(parseInt(req.query.limit || "20", 10), 50);
  const channelUsername = (req.query.channel || TELEGRAM_CHANNEL_USERNAME)
    .replace("@", "")
    .trim();

  const fetchRows = Math.min(limitGroups * 20, 1000);

  const { data, error } = await supabaseAdmin
    .from("telegram_posts")
    .select("channel_username,message_id,posted_at,text,permalink,raw,media_urls")
    .eq("channel_username", channelUsername)
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

    // собираем все фото из media_urls
    const images = [];
    for (const r of rows) {
      const arr = r.media_urls;
      if (Array.isArray(arr)) {
        for (const u of arr) if (typeof u === "string" && u) images.push(u);
      }
    }

    return {
      channel_username: channelUsername,
      message_id: minId,
      posted_at: first.posted_at,
      text: pickBestText(rows),
      permalink: makePermalink(channelUsername, minId),
      images,
    };
  });

  res.json({ items });
});

// ===== widget =====
app.get("/widget", (req, res) => {
  const channel = (req.query.channel || TELEGRAM_CHANNEL_USERNAME).replace("@", "").trim();
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 50);

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
  .title{font-weight:800;font-size:16px;line-height:1.2;}
  .subline{margin-top:6px;display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13px;}
  .online{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid var(--border);border-radius:999px;background:#f8fafc;color:#0f172a;font-size:12px;font-weight:700;white-space:nowrap;}
  .dot{width:10px;height:10px;border-radius:999px;background:#22c55e;box-shadow:0 0 0 4px rgba(34,197,94,.15);}
  .hint{margin:10px 14px 0;padding:10px 12px;border:1px dashed rgba(34,158,217,.35);background:rgba(34,158,217,.06);border-radius:12px;font-size:13px;}
  .feed{height:640px;overflow:auto;padding:12px 12px 54px;background:#f8fafc;}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:12px;margin-bottom:12px;box-shadow:0 6px 18px rgba(2, 6, 23, .06);}
  .meta{display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:12px;margin-bottom:8px;}
  .text{font-size:14px;line-height:1.45;white-space:pre-wrap;}
  .text a{color:var(--tg-dark);text-decoration:none;font-weight:700;}
  .text a:hover{text-decoration:underline;}
  .carousel{margin-top:10px;display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;scroll-snap-type:x mandatory;}
  .carousel::-webkit-scrollbar{height:8px}
  .carousel::-webkit-scrollbar-thumb{background:rgba(15,23,42,.18);border-radius:999px}
  .shot{flex:0 0 86%;scroll-snap-align:start;border-radius:14px;overflow:hidden;border:1px solid var(--border);background:#fff;}
  .shot img{width:100%;display:block;}
  .actions{margin-top:12px;display:flex;justify-content:flex-end;}
  .btn{display:inline-flex;align-items:center;gap:10px;padding:10px 14px;border-radius:999px;border:1px solid rgba(34,158,217,.35);background:rgba(34,158,217,.10);color:var(--tg-dark);font-weight:800;text-decoration:none;transition:.15s;}
  .btn:hover{background:rgba(34,158,217,.16);border-color:rgba(34,158,217,.55);}
  .plane{width:18px;height:18px;fill:var(--tg-dark);}
  .footer{position:relative;margin-top:-44px;padding:10px 14px;border-top:1px solid var(--border);background:linear-gradient(to top,#ffffff 70%,rgba(255,255,255,0));color:var(--muted);font-size:12px;text-align:center;}
  @media (max-width:480px){.feed{height:560px}.shot{flex-basis:92%}}
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
    <div class="footer">Прокрутите внутри блока, чтобы увидеть ещё посты ↓</div>
  </div>
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

  function fmtDate(iso){
    const dt = iso ? new Date(iso) : null;
    if (!dt) return "";
    return dt.toLocaleString("ru-RU", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit" });
  }

  function linkify(text){
    // 1) экранируем
    const esc = (s)=> (s||"").replace(/[&<>"']/g, (m)=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[m]));
    let t = esc(text);

    // 2) http(s)
    t = t.replace(/(https?:\\/\\/[^\\s<]+)/g, (m)=>\`<a href="\${m}" target="_blank" rel="noopener">\${m}</a>\`);

    // 3) t.me/xxx
    t = t.replace(/(^|\\s)(t\\.me\\/[A-Za-z0-9_\\/\\-\\?=&#.%]+)/g, (all, sp, path)=>{
      const url = "https://" + path;
      return \`\${sp}<a href="\${url}" target="_blank" rel="noopener">\${path}</a>\`;
    });

    return t;
  }

  window.trackTgOpen = function(){
    try{ if (window._tmr) window._tmr.push({ type: "reachGoal", goal: "tg_open" }); }catch(e){}
    try{ if (window.ym) ym(${YM_COUNTER_ID ? YM_COUNTER_ID : "0"}, "reachGoal", "tg_open"); }catch(e){}
  };

  function renderPost(item){
    const el = document.createElement("div");
    el.className = "card";

    const text = (item.text || "").trim();
    const carousel = Array.isArray(item.images) && item.images.length
      ? \`<div class="carousel">\${item.images.map(u => \`<div class="shot"><img src="\${u}" loading="lazy" /></div>\`).join("")}</div>\`
      : "";

    el.innerHTML = \`
      <div class="meta">
        <div>Пост #\${item.message_id}</div>
        <div>\${fmtDate(item.posted_at)}</div>
      </div>
      <div class="text">\${text ? linkify(text) : "<i style='color:#64748b'>Подпись отсутствует</i>"}</div>
      \${carousel}
      <div class="actions">
        <a class="btn" href="\${item.permalink}" target="_blank" rel="noopener" onclick="trackTgOpen()">
          <svg class="plane" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21.9 4.6c.3-1.3-1-2.2-2.1-1.7L2.6 10c-1.4.6-1.3 2.6.1 3.1l4.7 1.6 1.8 5.2c.5 1.4 2.4 1.5 3.1.2l2.7-4.7 4.7 3.4c1.2.9 2.9.2 3.2-1.3L21.9 4.6zM9.4 14.1l8.7-7.1-7 8.5-.3 3-1.5-4.1-3.9-1.3 13.7-5.6-9.7 6.6z"/>
          </svg>
          Открыть пост в канале!
        </a>
      </div>
    \`;
    return el;
  }

  async function loadStats(){
    const r = await fetch(\`/api/stats?channel=\${encodeURIComponent(CHANNEL)}\`);
    const j = await r.json().catch(()=>null);
    if (j && typeof j.subscribers_count === "number") {
      subsEl.textContent = "Подписчиков: " + j.subscribers_count.toLocaleString("ru-RU");
    } else {
      subsEl.textContent = "Подписчиков: —";
    }
  }

  async function loadPosts(){
    feed.innerHTML = "";
    const r = await fetch(\`/api/posts?channel=\${encodeURIComponent(CHANNEL)}&limit=\${LIMIT}\`);
    const j = await r.json().catch(()=>null);
    const items = j?.items || [];
    if (!items.length){
      const empty = document.createElement("div");
      empty.className = "card";
      empty.innerHTML = "<div class='text' style='color:#64748b'>Пока нет данных. Запусти импорт истории с media_urls.</div>";
      feed.appendChild(empty);
      return;
    }
    for (const it of items) feed.appendChild(renderPost(it));
  }

  // Realtime (опционально): если анон-ключ задан и RLS разрешает select
  async function enableRealtime(){
    const SUPABASE_URL = ${JSON.stringify(SUPABASE_URL)};
    const SUPABASE_ANON_KEY = ${JSON.stringify(SUPABASE_ANON_KEY)};
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;

    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    sb.channel("tg-posts")
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "telegram_posts",
        filter: \`channel_username=eq.\${CHANNEL}\`
      }, async () => {
        await loadPosts();
        await loadStats();
      })
      .subscribe();
  }

  await loadStats();
  await loadPosts();
  await enableRealtime();
</script>
</body>
</html>`;
  res.type("html").send(html);
});

app.listen(PORT, () => console.log("Server listening on " + PORT));
