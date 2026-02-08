import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" }));

// =====================
// ENV (на Render)
// =====================
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY,

  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_USERNAME, // "loycewear" (без @)

  VK_TMR_ID,       // "3738381"
  YM_COUNTER_ID    // "82720792"
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function tgPermalink(channelUsername, messageId) {
  return `https://t.me/${channelUsername}/${messageId}`;
}

// =====================
// 1) Telegram webhook
// =====================
app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;
    const msg = update.channel_post || update.edited_channel_post;
    if (!msg) return res.status(200).send("ok (no channel_post)");

    const channelUsername = (TELEGRAM_CHANNEL_USERNAME || msg.chat?.username || "")
      .replace("@", "")
      .trim();
    if (!channelUsername) return res.status(200).send("ok (no channel)");

    const messageId = msg.message_id;
    const postedAt = new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const text = msg.text || msg.caption || "";
    const permalink = tgPermalink(channelUsername, messageId);

    // анти-дубли: upsert по уникальному (channel_username,message_id)
    const { error } = await supabaseAdmin
      .from("telegram_posts")
      .upsert(
        {
          channel_username: channelUsername,
          message_id: messageId,
          posted_at: postedAt,
          text,
          permalink,
          raw: msg
        },
        { onConflict: "channel_username,message_id" }
      );

    if (error) console.error("Supabase upsert error:", error);

    return res.status(200).send("ok");
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(200).send("ok (error logged)");
  }
});

// =====================
// 2) API: posts
// =====================
app.get("/api/posts", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "20", 10), 50);
  const channelUsername = (req.query.channel || TELEGRAM_CHANNEL_USERNAME || "").replace("@", "").trim();
  if (!channelUsername) return res.status(400).json({ error: "No channel" });

  const { data, error } = await supabaseAdmin
    .from("telegram_posts")
    .select("channel_username,message_id,posted_at,text,permalink")
    .eq("channel_username", channelUsername)
    .order("posted_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [] });
});

// =====================
// 3) Telegram API: subscribers count
// =====================
async function fetchTelegramMemberCount(channelUsername) {
  const chatId = `@${channelUsername}`;
  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChatMemberCount?chat_id=${encodeURIComponent(chatId)}`;

  const r = await fetch(url);
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || "Telegram API error");
  return j.result;
}

app.get("/api/stats", async (req, res) => {
  try {
    const channelUsername = (req.query.channel || TELEGRAM_CHANNEL_USERNAME || "").replace("@", "").trim();
    if (!channelUsername) return res.status(400).json({ error: "No channel" });

    let memberCount = null;

    if (TELEGRAM_BOT_TOKEN) {
      try {
        memberCount = await fetchTelegramMemberCount(channelUsername);

        await supabaseAdmin
          .from("telegram_channel_stats")
          .upsert(
            {
              channel_username: channelUsername,
              member_count: memberCount,
              updated_at: new Date().toISOString()
            },
            { onConflict: "channel_username" }
          );
      } catch (e) {
        console.warn("MemberCount fetch failed, fallback to DB:", e.message);
      }
    }

    if (memberCount === null) {
      const { data } = await supabaseAdmin
        .from("telegram_channel_stats")
        .select("member_count,updated_at")
        .eq("channel_username", channelUsername)
        .maybeSingle();

      memberCount = data?.member_count ?? 0;
    }

    return res.json({ channel: channelUsername, member_count: memberCount });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// =====================
// 4) Widget page (вставляем в Taplink через iframe)
// =====================
app.get("/widget", async (req, res) => {
  const channelUsername = (req.query.channel || TELEGRAM_CHANNEL_USERNAME || "loycewear").replace("@", "").trim();

  const anonKey = SUPABASE_ANON_KEY || "";
  const vkId = VK_TMR_ID || "3738381";
  const ymId = YM_COUNTER_ID || "82720792";

  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Telegram-лента @${channelUsername}</title>

  <style>
    :root{
      --text:#f5f5f7;
      --muted:#b8b8c6;
      --border:rgba(255,255,255,.12);
      --shadow: 0 12px 30px rgba(0,0,0,.35);
      --radius:18px;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      background:transparent;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      color:var(--text);
    }
    .wrap{width:100%; max-width:860px; margin:0 auto; padding:12px;}
    .widget{
      border:1px solid var(--border);
      border-radius: var(--radius);
      background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
      box-shadow: var(--shadow);
      overflow:hidden;
    }
    .head{
      display:flex; align-items:center; justify-content:space-between;
      padding:14px 14px 12px 14px;
      background: rgba(0,0,0,.25);
      border-bottom:1px solid var(--border);
    }
    .title{display:flex; flex-direction:column; gap:2px; min-width:0;}
    .title b{font-size:14.5px; letter-spacing:.2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;}
    .sub{display:flex; gap:10px; align-items:center; font-size:12.5px; color:var(--muted);}
    .dot{width:8px;height:8px;border-radius:999px;background:#32d74b;box-shadow:0 0 0 4px rgba(50,215,75,.14);display:inline-block;margin-right:6px;}
    .online{
      display:inline-flex; align-items:center; gap:6px;
      padding:6px 10px; border:1px solid rgba(255,255,255,.18);
      border-radius:999px; background: rgba(0,0,0,.18);
      font-size:12px; color:var(--text); user-select:none; white-space:nowrap;
    }

    .scroller{
      height:520px;
      overflow:auto;
      padding:12px;
      background: rgba(0,0,0,.12);
    }
    .hintTop{
      font-size:12px;
      color:var(--muted);
      border:1px dashed rgba(255,255,255,.14);
      border-radius:14px;
      padding:10px 12px;
      margin:0 0 12px 0;
      background: rgba(0,0,0,.18);
    }

    .post{
      border:1px solid rgba(255,255,255,.12);
      border-radius:16px;
      background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03));
      padding:12px 12px 10px 12px;
      margin:0 0 10px 0;
    }
    .meta{display:flex; justify-content:space-between; gap:8px; font-size:12px; color:var(--muted); margin-bottom:8px;}
    .text{font-size:14px; line-height:1.45; color:var(--text); white-space:pre-wrap; word-break:break-word;}
    .actions{margin-top:10px; display:flex; justify-content:flex-end;}
    .btn{
      display:inline-flex; align-items:center; gap:8px;
      border:none; cursor:pointer;
      padding:10px 12px; border-radius:12px;
      background: rgba(255,255,255,.92);
      color:#0b0b0f; font-weight:700; font-size:13px;
      text-decoration:none;
    }
    .btn:active{transform: translateY(1px)}
    .tgicon{width:18px;height:18px}
    .foot{
      border-top:1px solid var(--border);
      padding:10px 14px;
      background: rgba(0,0,0,.22);
      color:var(--muted);
      font-size:12.5px;
      text-align:center;
    }
    @media (max-width: 420px){
      .scroller{ height:480px; }
      .btn{ width:100%; justify-content:center; }
      .actions{ justify-content:stretch; }
      .sub{flex-wrap:wrap}
    }
  </style>

  <!-- VK Ads / Top.Mail.Ru counter (ваш код) -->
  <script type="text/javascript">
  var _tmr = window._tmr || (window._tmr = []);
  _tmr.push({id: "${vkId}", type: "pageView", start: (new Date()).getTime()});
  (function (d, w, id) {
    if (d.getElementById(id)) return;
    var ts = d.createElement("script"); ts.type = "text/javascript"; ts.async = true; ts.id = id;
    ts.src = "https://top-fwz1.mail.ru/js/code.js";
    var f = function () {var s = d.getElementsByTagName("script")[0]; s.parentNode.insertBefore(ts, s);};
    if (w.opera == "[object Opera]") { d.addEventListener("DOMContentLoaded", f, false); } else { f(); }
  })(document, window, "tmr-code");
  </script>
  <noscript><div><img src="https://top-fwz1.mail.ru/counter?id=${vkId};js=na" style="position:absolute;left:-9999px;" alt="Top.Mail.Ru" /></div></noscript>

  <!-- ВАЖНО: Метрика должна быть установлена (в Taplink глобально или сюда полным кодом).
       Здесь мы используем только вызов цели ym(..., 'reachGoal', 'tg_open') -->
</head>

<body>
  <div class="wrap">
    <div class="widget">
      <div class="head">
        <div class="title">
          <b>Telegram-лента канала @${channelUsername}</b>
          <div class="sub">
            <span class="online"><span class="dot"></span>Online</span>
            <span id="subs">Подписчиков: …</span>
          </div>
        </div>
      </div>

      <div class="scroller" id="scroller">
        <div class="hintTop">Подсказка: внутри этого блока можно прокручивать посты (скролл).</div>
        <div id="list"></div>
      </div>

      <div class="foot">Прокрутите внутри блока, чтобы увидеть ещё посты ↓</div>
    </div>
  </div>

  <script type="module">
    import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

    const SUPABASE_URL = ${JSON.stringify(SUPABASE_URL)};
    const SUPABASE_ANON_KEY = ${JSON.stringify(anonKey)};
    const CHANNEL = ${JSON.stringify(channelUsername)};
    const YM_ID = ${JSON.stringify(ymId)};
    const VK_ID = ${JSON.stringify(vkId)};

    const listEl = document.getElementById("list");
    const subsEl = document.getElementById("subs");

    function formatDate(iso){
      try{
        const d = new Date(iso);
        return d.toLocaleString("ru-RU", { day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit" });
      }catch(e){ return ""; }
    }

    function safeText(s){
      return (s || "")
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#039;");
    }

    function fireTgOpenEvents(){
      // VK Ads / Top.Mail.Ru goal
      try{
        const _tmr = window._tmr || (window._tmr = []);
        _tmr.push({ id: VK_ID, type: "reachGoal", goal: "tg_open" });
      }catch(e){}

      // Yandex Metrika goal
      try{
        if (typeof window.ym === "function") {
          window.ym(Number(YM_ID), "reachGoal", "tg_open");
        }
      }catch(e){}
    }

    function renderPost(item){
      const text = safeText(item.text || "");
      const date = formatDate(item.posted_at);
      const link = item.permalink;

      const el = document.createElement("div");
      el.className = "post";
      el.innerHTML = \`
        <div class="meta">
          <span>Пост #\${item.message_id}</span>
          <span>\${date}</span>
        </div>
        <div class="text">\${text || "<i style='color:rgba(255,255,255,.7)'>Без текста (возможен медиа-пост)</i>"}</div>
        <div class="actions">
          <a class="btn" href="\${link}" target="_blank" rel="noopener noreferrer">
            <svg class="tgicon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21.7 3.2c.4.2.6.7.5 1.2l-3.2 15.3c-.1.5-.5.9-1 .9-.2.1-.5 0-.8-.1l-4.7-3.5-2.3 2.2c-.2.2-.4.3-.7.3-.1 0-.2 0-.3-.1-.3-.1-.5-.4-.5-.8v-3l8.9-8.2c.3-.3.4-.7.1-1-.2-.3-.6-.3-1-.1l-11 6.9-4.6-1.5c-.4-.1-.7-.5-.7-1s.2-.9.7-1.1L20.4 3c.4-.2.9-.2 1.3.2z"></path>
            </svg>
            Открыть пост в канале!
          </a>
        </div>
      \`;

      el.querySelector("a.btn").addEventListener("click", () => {
        fireTgOpenEvents();
      });

      return el;
    }

    async function loadInitial(){
      const r = await fetch(\`/api/posts?channel=\${encodeURIComponent(CHANNEL)}&limit=20\`);
      const j = await r.json();
      listEl.innerHTML = "";
      (j.items || []).forEach(item => listEl.appendChild(renderPost(item)));
    }

    async function loadStats(){
      try{
        const r = await fetch(\`/api/stats?channel=\${encodeURIComponent(CHANNEL)}\`);
        const j = await r.json();
        subsEl.textContent = "Подписчиков: " + (j.member_count ?? "—");
      }catch(e){
        subsEl.textContent = "Подписчиков: —";
      }
    }

    await loadStats();
    await loadInitial();

    // ===== Realtime: новые посты сразу =====
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    supabase
      .channel("tg-feed")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "telegram_posts",
          filter: \`channel_username=eq.\${CHANNEL}\`
        },
        (payload) => {
          const item = payload.new;
          const node = renderPost(item);
          listEl.prepend(node);

          const sc = document.getElementById("scroller");
          sc.scrollTop = 0;
        }
      )
      .subscribe();

    setInterval(loadStats, 60000);
  </script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(html);
});

// health
app.get("/", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server listening on", port));
