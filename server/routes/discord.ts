import { Router } from "express";
import { discordBot } from "../lib/discordBot.ts";
import { badRequest, notFound } from "../lib/errors.ts";

export const discordRouter: Router = Router();

discordRouter.get("/discord", (_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.send(discordConsoleHtml());
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

discordRouter.get("/api/discord/channels/:channelId/messages", (req, res) => {
  const channelId = req.params.channelId;
  const messages = discordBot.listMessages(channelId);
  if (!messages.length && !discordBot.listChannels().some((c) => c.id === channelId)) {
    throw notFound(`Channel ${channelId} is not in the Discord bot cache`);
  }
  res.json({ messages });
});

discordRouter.post("/api/discord/channels/:channelId/messages", async (req, res, next) => {
  try {
    const content = typeof req.body?.content === "string" ? req.body.content : "";
    if (!content.trim()) throw badRequest("Missing message content");
    const message = await discordBot.sendChannelMessage(req.params.channelId, content);
    res.status(201).json({ message });
  } catch (e) {
    next(e);
  }
});

function discordConsoleHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Convert API Discord Console</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #111318;
      color: #f3f5f8;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: #111318;
    }
    header, main {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
    }
    header {
      padding: 28px 0 18px;
      display: flex;
      align-items: end;
      justify-content: space-between;
      gap: 20px;
      border-bottom: 1px solid #2c313a;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      letter-spacing: 0;
    }
    main {
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      gap: 18px;
      padding: 18px 0 32px;
    }
    section {
      min-width: 0;
    }
    .panel {
      border: 1px solid #2c313a;
      background: #181b21;
      border-radius: 8px;
      overflow: hidden;
    }
    .panel h2 {
      margin: 0;
      padding: 14px 16px;
      font-size: 14px;
      border-bottom: 1px solid #2c313a;
      color: #cfd6e3;
      letter-spacing: 0;
    }
    .stack {
      display: grid;
      gap: 12px;
      padding: 14px;
    }
    button, select, textarea, input {
      font: inherit;
      color: inherit;
      background: #0f1116;
      border: 1px solid #353b46;
      border-radius: 6px;
      padding: 10px 12px;
    }
    button {
      cursor: pointer;
      background: #2b67f6;
      border-color: #2b67f6;
      font-weight: 650;
    }
    button.secondary {
      background: #232832;
      border-color: #3a414d;
    }
    textarea {
      resize: vertical;
      min-height: 92px;
    }
    .muted {
      color: #9aa4b5;
      font-size: 13px;
    }
    .status {
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      background: #0f1116;
      border: 1px solid #2c313a;
      border-radius: 6px;
      padding: 12px;
      overflow: auto;
    }
    .messages {
      display: grid;
      gap: 10px;
      max-height: 58vh;
      overflow: auto;
      padding: 14px;
    }
    .message {
      border-bottom: 1px solid #2c313a;
      padding-bottom: 10px;
    }
    .message:last-child {
      border-bottom: 0;
    }
    .message strong {
      display: block;
      font-size: 13px;
      color: #dce4f2;
      margin-bottom: 4px;
    }
    .message p {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    @media (max-width: 820px) {
      header {
        align-items: start;
        flex-direction: column;
      }
      main {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Discord Console</h1>
      <div class="muted">View cached Discord activity and send messages as the bot.</div>
    </div>
    <button class="secondary" id="refresh">Refresh</button>
  </header>
  <main>
    <section class="panel">
      <h2>Bot</h2>
      <div class="stack">
        <div id="status" class="status">Loading...</div>
        <label>
          <div class="muted">Server</div>
          <select id="guilds"></select>
        </label>
        <label>
          <div class="muted">Channel</div>
          <select id="channels"></select>
        </label>
        <button id="loadMessages">Load messages</button>
      </div>
    </section>
    <section class="panel">
      <h2>Messages</h2>
      <div id="messages" class="messages"></div>
      <div class="stack">
        <textarea id="content" maxlength="1900" placeholder="Send a message as the bot"></textarea>
        <button id="send">Send</button>
      </div>
    </section>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const apiKey = params.get("apiKey") || params.get("api_key") || "";
    const qs = () => apiKey ? "?apiKey=" + encodeURIComponent(apiKey) : "";
    const state = { guilds: [], channels: [] };

    async function api(path, options) {
      const sep = path.includes("?") ? "&" : "?";
      const url = apiKey ? path + sep + "apiKey=" + encodeURIComponent(apiKey) : path;
      const res = await fetch(url, {
        ...options,
        headers: { "content-type": "application/json", ...(options && options.headers || {}) },
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    function escapeHtml(value) {
      return String(value || "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }

    async function refresh() {
      const [status, guilds, channels] = await Promise.all([
        api("/api/discord/status"),
        api("/api/discord/guilds"),
        api("/api/discord/channels"),
      ]);
      document.querySelector("#status").textContent = JSON.stringify(status, null, 2);
      state.guilds = guilds.guilds || [];
      state.channels = channels.channels || [];
      renderGuilds();
      renderChannels();
    }

    function renderGuilds() {
      const select = document.querySelector("#guilds");
      select.innerHTML = '<option value="">All servers</option>' + state.guilds
        .map((g) => '<option value="' + escapeHtml(g.id) + '">' + escapeHtml(g.name || g.id) + '</option>')
        .join("");
    }

    function renderChannels() {
      const guildId = document.querySelector("#guilds").value;
      const select = document.querySelector("#channels");
      const channels = state.channels.filter((c) => !guildId || c.guild_id === guildId);
      select.innerHTML = channels
        .map((c) => '<option value="' + escapeHtml(c.id) + '">' + escapeHtml("#" + (c.name || c.id)) + '</option>')
        .join("");
    }

    async function loadMessages() {
      const channelId = document.querySelector("#channels").value;
      if (!channelId) return;
      const data = await api("/api/discord/channels/" + encodeURIComponent(channelId) + "/messages");
      const messages = data.messages || [];
      document.querySelector("#messages").innerHTML = messages.map((m) => {
        const author = m.author && (m.author.global_name || m.author.username || m.author.id) || "unknown";
        const files = (m.attachments || []).map((a) => a.filename).join(", ");
        return '<article class="message"><strong>' + escapeHtml(author) + ' <span class="muted">' + escapeHtml(m.timestamp || "") + '</span></strong><p>' + escapeHtml(m.content || "") + '</p>' + (files ? '<div class="muted">' + escapeHtml(files) + '</div>' : '') + '</article>';
      }).join("") || '<div class="muted">No cached messages for this channel yet.</div>';
    }

    async function sendMessage() {
      const channelId = document.querySelector("#channels").value;
      const content = document.querySelector("#content").value;
      if (!channelId || !content.trim()) return;
      await api("/api/discord/channels/" + encodeURIComponent(channelId) + "/messages", {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      document.querySelector("#content").value = "";
      await loadMessages();
    }

    document.querySelector("#refresh").addEventListener("click", refresh);
    document.querySelector("#guilds").addEventListener("change", renderChannels);
    document.querySelector("#loadMessages").addEventListener("click", loadMessages);
    document.querySelector("#send").addEventListener("click", sendMessage);
    refresh().catch((e) => document.querySelector("#status").textContent = e.message);
  </script>
</body>
</html>`;
}
