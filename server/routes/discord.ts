import { Router } from "express";
import { discordBot } from "../lib/discordBot.ts";
import { badRequest } from "../lib/errors.ts";

export const discordRouter: Router = Router();

const page = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Discord Bot Console</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif; background: #111217; color: #f4f4f5; }
    body { margin: 0; display: grid; grid-template-columns: 280px 1fr; min-height: 100vh; }
    aside { border-right: 1px solid #2a2d36; padding: 16px; background: #181a22; overflow: auto; }
    main { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
    header, form { padding: 14px 18px; border-bottom: 1px solid #2a2d36; background: #181a22; }
    form { border-top: 1px solid #2a2d36; border-bottom: 0; display: flex; gap: 10px; }
    select, input, button { background: #242733; color: #fff; border: 1px solid #3a3e4d; border-radius: 8px; padding: 10px; }
    button { cursor: pointer; background: #5865f2; border-color: #5865f2; font-weight: 700; }
    button.secondary { background: #2d3140; border-color: #3a3e4d; width: 100%; margin-top: 8px; }
    input { flex: 1; }
    .channel { display: block; width: 100%; text-align: left; margin: 4px 0; background: transparent; border: 0; color: #d7d8df; padding: 8px; border-radius: 6px; }
    .channel:hover, .channel.active { background: #2b2f3b; }
    #messages { overflow: auto; padding: 18px; display: flex; flex-direction: column; gap: 10px; }
    .msg { background: #1d2029; border: 1px solid #2a2d36; border-radius: 10px; padding: 10px 12px; }
    .meta { color: #a8acba; font-size: 12px; margin-bottom: 4px; }
    .attachments { color: #8ab4ff; font-size: 12px; margin-top: 6px; }
    .muted { color: #a8acba; font-size: 13px; }
    h1 { font-size: 18px; margin: 0 0 4px; }
    h2 { font-size: 13px; color: #a8acba; margin: 18px 0 8px; text-transform: uppercase; letter-spacing: .08em; }
  </style>
</head>
<body>
  <aside>
    <h1>Discord Bot Console</h1>
    <div id="status" class="muted">Loading…</div>
    <h2>Server</h2>
    <select id="guild"></select>
    <button class="secondary" id="refresh" type="button">Refresh</button>
    <h2>Channels the bot can see</h2>
    <div id="channels"></div>
  </aside>
  <main>
    <header><strong id="title">Pick a channel</strong><div class="muted">View cached/fetched messages and send as the bot.</div></header>
    <section id="messages"></section>
    <form id="sendForm"><input id="content" placeholder="Message to send as the bot…" maxlength="1900" /><button>Send</button></form>
  </main>
<script>
const statusEl = document.getElementById('status');
const guildEl = document.getElementById('guild');
const channelsEl = document.getElementById('channels');
const messagesEl = document.getElementById('messages');
const titleEl = document.getElementById('title');
let currentChannel = null;
function esc(s){ return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const apiKey = new URLSearchParams(location.search).get('apiKey') || new URLSearchParams(location.search).get('api_key') || '';
function withKey(path){ if(!apiKey) return path; const u = new URL(path, location.origin); u.searchParams.set('apiKey', apiKey); return u.pathname + u.search; }
async function api(path, opts){ const r = await fetch(withKey(path), opts); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function load(){
  const s = await api('/api/discord/status');
  statusEl.textContent = s.enabled ? (s.connected ? 'Connected' : 'Enabled, connecting…') : 'Set DISCORD_BOT_TOKEN to enable.';
  const guilds = (await api('/api/discord/guilds')).guilds;
  guildEl.innerHTML = guilds.map(g => '<option value="'+g.id+'">'+esc(g.name)+'</option>').join('');
  await loadChannels();
}
async function loadChannels(){
  const gid = guildEl.value;
  const channels = (await api('/api/discord/channels' + (gid ? '?guildId=' + encodeURIComponent(gid) : ''))).channels;
  channelsEl.innerHTML = channels.map(c => '<button class="channel" data-id="'+c.id+'"># '+esc(c.name || c.id)+'</button>').join('') || '<div class="muted">No visible text channels yet.</div>';
  [...channelsEl.querySelectorAll('button')].forEach(btn => btn.onclick = () => selectChannel(btn.dataset.id, btn.textContent));
}
async function selectChannel(id, label){
  currentChannel = id; titleEl.textContent = label;
  [...channelsEl.querySelectorAll('button')].forEach(b => b.classList.toggle('active', b.dataset.id === id));
  await loadMessages();
}
async function loadMessages(){
  if(!currentChannel) return;
  const msgs = (await api('/api/discord/channels/' + currentChannel + '/messages?fetch=true')).messages;
  messagesEl.innerHTML = msgs.map(m => '<div class="msg"><div class="meta">'+esc(m.author?.global_name || m.author?.username || m.author?.id || 'Unknown')+' · '+esc(m.timestamp || '')+'</div><div>'+esc(m.content || '')+'</div>'+(m.attachments?.length ? '<div class="attachments">Attachments: '+m.attachments.map(a => esc(a.filename)).join(', ')+'</div>' : '')+'</div>').join('');
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
guildEl.onchange = loadChannels;
document.getElementById('refresh').onclick = load;
document.getElementById('sendForm').onsubmit = async (e) => {
  e.preventDefault();
  if(!currentChannel) return alert('Pick a channel first.');
  const input = document.getElementById('content');
  const content = input.value.trim();
  if(!content) return;
  await api('/api/discord/channels/' + currentChannel + '/messages', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ content }) });
  input.value = ''; await loadMessages();
};
setInterval(() => { if(currentChannel) loadMessages().catch(console.error); }, 5000);
load().catch(e => statusEl.textContent = e.message);
</script>
</body>
</html>`;

discordRouter.get("/discord", (_req, res) => {
  res.type("html").send(page);
});

discordRouter.get("/api/discord/status", (_req, res) => {
  res.json(discordBot.status());
});

discordRouter.get("/api/discord/guilds", (_req, res) => {
  res.json({ guilds: discordBot.listGuilds() });
});

discordRouter.get("/api/discord/channels", (req, res) => {
  const guildId = typeof req.query.guildId === "string" ? req.query.guildId : undefined;
  res.json({ channels: discordBot.listChannels(guildId) });
});

discordRouter.get("/api/discord/channels/:id/messages", async (req, res, next) => {
  try {
    const fetchRemote = req.query.fetch === "true" || req.query.fetch === "1";
    const messages = fetchRemote ? await discordBot.fetchMessages(req.params.id) : discordBot.getMessages(req.params.id);
    res.json({ messages });
  } catch (e) {
    next(e);
  }
});

discordRouter.post("/api/discord/channels/:id/messages", async (req, res, next) => {
  try {
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) throw badRequest("Missing message content");
    const message = await discordBot.sendMessage(req.params.id, content.slice(0, 1900));
    res.json({ message });
  } catch (e) {
    next(e);
  }
});
