import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { log } from "./log.ts";

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_VERSION = 10;
const MAX_MESSAGE_HISTORY = Number(process.env.DISCORD_WEB_HISTORY_LIMIT) || 100;
const AUDIT_FLUSH_MS = Number(process.env.DISCORD_AUDIT_FLUSH_MS) || 30_000;
const DEFAULT_OUTPUTS = ["pdf", "png", "jpg", "jpeg", "webp", "gif", "mp3", "mp4", "wav", "ogg", "txt", "json", "csv", "xml", "html", "md", "svg", "zip", "7z", "tar", "gz", "webm", "mov", "avi", "ico"];
const MAX_SELECT_OPTIONS = 25;
const PROGRESS_UPDATE_MS = Number(process.env.DISCORD_PROGRESS_UPDATE_MS) || 5_000;
const RAW_UPLOAD_DELETE_DELAY_MS = Number(process.env.DISCORD_RAW_UPLOAD_DELETE_DELAY_MS) || 1_500;

const INTENTS =
  (1 << 0) | // Guilds
  (1 << 1) | // Guild members
  (1 << 9) | // Guild messages
  (1 << 15); // Message content

type DiscordMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size?: number;
  url: string;
  proxy_url?: string;
}

interface DiscordUser {
  id: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
}

interface DiscordMember {
  user?: DiscordUser;
  nick?: string | null;
  roles?: string[];
  joined_at?: string;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: DiscordUser;
  content?: string;
  timestamp?: string;
  edited_timestamp?: string | null;
  attachments?: DiscordAttachment[];
}

interface DiscordChannel {
  id: string;
  guild_id?: string;
  name?: string;
  type: number;
  parent_id?: string | null;
}

interface DiscordGuild {
  id: string;
  name: string;
  icon?: string | null;
}

interface PendingUpload {
  userId: string;
  channelId: string;
  guildId?: string;
  expiresAt: number;
}

interface PendingConversion {
  userId: string;
  channelId: string;
  guildId?: string;
  attachment: DiscordAttachment;
}

interface AuditEntry {
  type: string;
  guildId?: string;
  channelId?: string;
  message: string;
  at: string;
}

interface ApiJobAccepted {
  jobId: string;
  kind: string;
  status: string;
  estimateMs?: number;
  estimatedSeconds?: number;
  statusUrl: string;
  resultUrl: string;
  streamUrl?: string;
  pollAfterMs?: number;
}

interface ApiJobSnapshot {
  id: string;
  kind: string;
  status: string;
  progress?: number;
  estimateMs?: number;
  error?: string;
  result?: { fileName?: string; contentType?: string };
}

interface ApiResult {
  bytes: Uint8Array;
  contentType: string;
  fileName?: string;
}

interface FormatEntry {
  name?: string;
  format: string;
  extension?: string;
  mime?: string;
  from?: boolean;
  to?: boolean;
  category?: string | string[];
}

function envList(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function displayUser(user?: DiscordUser): string {
  if (!user) return "Unknown user";
  return user.global_name || user.username || `<@${user.id}>`;
}

function cleanContent(content?: string): string {
  const trimmed = (content || "").trim();
  if (!trimmed) return "(no text)";
  return trimmed.length > 900 ? `${trimmed.slice(0, 900)}…` : trimmed;
}

function isTextChannel(ch: DiscordChannel): boolean {
  return [0, 5, 10, 11, 12, 15].includes(ch.type);
}

function apiFileName(name: string, fallbackExt = "bin"): string {
  const safe = basename(name || `converted.${fallbackExt}`).replace(/[\r\n]/g, "_");
  return safe || `converted.${fallbackExt}`;
}

function progressBar(progress: number): string {
  const safe = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const filled = Math.round(safe * 12);
  return `${"█".repeat(filled)}${"░".repeat(12 - filled)} ${Math.round(safe * 100)}%`;
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 1) return "unknown";
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function normalizeFormat(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^\./, "")
    .toLowerCase()
    .replace(/[^a-z0-9+_-]/g, "")
    .slice(0, 20);
}

class DiscordBot extends EventEmitter {
  private token = process.env.DISCORD_BOT_TOKEN || "";
  private applicationId = process.env.DISCORD_APPLICATION_ID || "";
  private logChannelIds = envList("DISCORD_LOG_CHANNEL_ID");
  private logWebhookUrls = envList("DISCORD_LOG_WEBHOOK_URL");
  private apiBaseUrl = process.env.DISCORD_CONVERT_API_BASE_URL || `http://127.0.0.1:${Number(process.env.PORT) || 3000}`;
  private apiKey = envList("CONVERT_API_KEYS")[0];
  private ws?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private sequence: number | null = null;
  private sessionId?: string;
  private reconnectTimer?: NodeJS.Timeout;
  private started = false;
  private botUserId?: string;
  private readonly guilds = new Map<string, DiscordGuild>();
  private readonly channels = new Map<string, DiscordChannel>();
  private readonly messages = new Map<string, DiscordMessage[]>();
  private readonly pendingUploads = new Map<string, PendingUpload>();
  private readonly pendingConversions = new Map<string, PendingConversion>();
  private readonly auditQueue: AuditEntry[] = [];
  private readonly knownMemberRoles = new Map<string, Set<string>>();
  private formatCache: { at: number; formats: FormatEntry[] } | null = null;
  private readonly flushTimer: NodeJS.Timeout;

  constructor() {
    super();
    this.flushTimer = setInterval(() => void this.flushAudit(), AUDIT_FLUSH_MS);
    this.flushTimer.unref?.();
  }

  isEnabled(): boolean {
    return !!this.token;
  }

  status() {
    return {
      enabled: this.isEnabled(),
      connected: this.ws?.readyState === WebSocket.OPEN,
      botUserId: this.botUserId,
      guilds: this.guilds.size,
      channels: this.channels.size,
      logChannels: this.logChannelIds,
      logWebhooks: this.logWebhookUrls.length,
      flushMs: AUDIT_FLUSH_MS,
    };
  }

  async start(): Promise<void> {
    if (!this.isEnabled() || this.started) return;
    this.started = true;
    await this.registerCommands().catch((e) => log.warn("Discord command registration failed:", e));
    await this.connectGateway().catch((e) => log.warn("Discord gateway failed:", e));
  }

  listGuilds(): DiscordGuild[] {
    return [...this.guilds.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  listChannels(guildId?: string): DiscordChannel[] {
    return [...this.channels.values()]
      .filter((c) => (!guildId || c.guild_id === guildId) && isTextChannel(c))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }

  getMessages(channelId: string): DiscordMessage[] {
    return [...(this.messages.get(channelId) || [])].reverse();
  }

  async fetchMessages(channelId: string, limit = 50): Promise<DiscordMessage[]> {
    const msgs = await this.request<DiscordMessage[]>("GET", `/channels/${channelId}/messages?limit=${Math.min(Math.max(limit, 1), 100)}`);
    this.messages.set(channelId, [...msgs].reverse().slice(-MAX_MESSAGE_HISTORY));
    return this.getMessages(channelId);
  }

  async sendMessage(channelId: string, content: string): Promise<DiscordMessage> {
    return this.request<DiscordMessage>("POST", `/channels/${channelId}/messages`, { content });
  }

  private async request<T>(method: DiscordMethod, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    if (!this.token) throw new Error("DISCORD_BOT_TOKEN is not configured");
    const headers: Record<string, string> = { authorization: `Bot ${this.token}`, ...extraHeaders };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${DISCORD_API}${path}`, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Discord ${method} ${path} failed: ${res.status} ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async requestMultipart<T>(path: string, form: FormData): Promise<T> {
    if (!this.token) throw new Error("DISCORD_BOT_TOKEN is not configured");
    const res = await fetch(`${DISCORD_API}${path}`, { method: "POST", headers: { authorization: `Bot ${this.token}` }, body: form });
    if (!res.ok) throw new Error(`Discord multipart ${path} failed: ${res.status} ${await res.text().catch(() => "")}`);
    return (await res.json()) as T;
  }

  private async registerCommands(): Promise<void> {
    if (!this.applicationId) {
      const me = await this.request<DiscordUser>("GET", "/users/@me");
      this.applicationId = me.id;
      this.botUserId = me.id;
    }
    const commands = [
      { name: "convert", description: "Upload a file and choose the output format with a simple UI.", options: [{ name: "file", description: "Optional file to convert now. If omitted, upload it after running the command.", type: 11, required: false }] },
      { name: "screenshot", description: "Capture a website as an image or PDF.", options: [{ name: "url", description: "Website URL", type: 3, required: true }, { name: "format", description: "Output format", type: 3, required: false, choices: ["png", "jpeg", "webp", "pdf"].map((v) => ({ name: v, value: v })) }] },
      { name: "download", description: "Download YouTube or media URLs as audio/video.", options: [{ name: "url", description: "Media URL", type: 3, required: true }, { name: "format", description: "best, mp3, mp4, etc.", type: 3, required: false }] },
      { name: "ocr", description: "Extract text from an uploaded image or PDF.", options: [{ name: "file", description: "Image or PDF", type: 11, required: true }, { name: "mode", description: "txt, pdf, hocr, or tsv", type: 3, required: false }] },
      { name: "transcribe", description: "Transcribe uploaded audio/video or a media URL.", options: [{ name: "file", description: "Audio/video file", type: 11, required: false }, { name: "url", description: "Audio/video URL", type: 3, required: false }, { name: "summarize", description: "Include a summary when configured", type: 5, required: false }] },
      { name: "formats", description: "List every conversion format this API currently reports.", options: [{ name: "direction", description: "Show input or output formats", type: 3, required: false, choices: [{ name: "output formats", value: "to" }, { name: "input formats", value: "from" }, { name: "all formats", value: "all" }] }, { name: "category", description: "Optional category filter, for example image, audio, document, archive", type: 3, required: false }] },
    ];
    await this.request("PUT", `/applications/${this.applicationId}/commands`, commands);
    log.info("Discord slash commands registered");
  }

  private async connectGateway(): Promise<void> {
    const gateway = await this.request<{ url: string }>("GET", "/gateway/bot");
    const url = `${gateway.url}?v=${GATEWAY_VERSION}&encoding=json`;
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => void this.onGatewayMessage(String(event.data)));
    this.ws.addEventListener("close", () => this.scheduleReconnect());
    this.ws.addEventListener("error", () => this.scheduleReconnect());
  }

  private scheduleReconnect(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectGateway().catch((e) => log.warn("Discord reconnect failed:", e));
    }, 5_000);
  }

  private async onGatewayMessage(raw: string): Promise<void> {
    const packet = JSON.parse(raw) as { op: number; d: any; s?: number | null; t?: string | null };
    if (packet.s !== undefined) this.sequence = packet.s;
    if (packet.op === 10) {
      this.identify(packet.d.heartbeat_interval);
      return;
    }
    if (packet.op === 11) return;
    if (packet.op === 0 && packet.t) await this.onDispatch(packet.t, packet.d);
  }

  private identify(interval: number): void {
    if (!this.ws) return;
    this.heartbeat = setInterval(() => this.ws?.send(JSON.stringify({ op: 1, d: this.sequence })), interval);
    this.heartbeat.unref?.();
    this.ws.send(JSON.stringify({ op: 2, d: { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: "convert-api", device: "convert-api" } } }));
  }

  private async onDispatch(type: string, data: any): Promise<void> {
    switch (type) {
      case "READY":
        this.botUserId = data.user?.id;
        for (const guild of data.guilds || []) this.guilds.set(guild.id, { id: guild.id, name: guild.name || guild.id, icon: guild.icon });
        break;
      case "GUILD_CREATE":
        this.guilds.set(data.id, { id: data.id, name: data.name, icon: data.icon });
        for (const ch of data.channels || []) this.channels.set(ch.id, { ...ch, guild_id: data.id });
        this.queueAudit({ type: "server", guildId: data.id, message: `Joined or became ready in server **${data.name}** (${data.id}).` });
        break;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
        this.channels.set(data.id, data);
        this.queueAudit({ type: "channel", guildId: data.guild_id, channelId: data.id, message: `Channel ${type === "CHANNEL_CREATE" ? "created" : "updated"}: <#${data.id}> (${data.name || data.id}).` });
        break;
      case "CHANNEL_DELETE":
        this.channels.delete(data.id);
        this.queueAudit({ type: "channel", guildId: data.guild_id, channelId: data.id, message: `Channel deleted: #${data.name || data.id} (${data.id}).` });
        break;
      case "MESSAGE_CREATE":
        this.rememberMessage(data);
        await this.maybeHandlePendingUpload(data);
        break;
      case "MESSAGE_UPDATE":
        this.queueAudit({ type: "message_edit", guildId: data.guild_id, channelId: data.channel_id, message: `Message edited in <#${data.channel_id}> by ${displayUser(data.author)}: ${cleanContent(data.content)} (message ${data.id}).` });
        this.rememberMessage(data);
        break;
      case "MESSAGE_DELETE": {
        const cached = (this.messages.get(data.channel_id) || []).find((m) => m.id === data.id);
        this.queueAudit({ type: "message_delete", guildId: data.guild_id, channelId: data.channel_id, message: `Message deleted in <#${data.channel_id}>${cached?.author ? ` by ${displayUser(cached.author)}` : ""}: ${cleanContent(cached?.content)} (message ${data.id}).` });
        break;
      }
      case "MESSAGE_DELETE_BULK":
        this.queueAudit({ type: "message_delete", guildId: data.guild_id, channelId: data.channel_id, message: `${(data.ids || []).length} messages bulk-deleted in <#${data.channel_id}>.` });
        break;
      case "GUILD_MEMBER_ADD":
        this.queueAudit({ type: "member_join", guildId: data.guild_id, message: `${displayUser(data.user)} joined the server.` });
        this.rememberRoles(data.guild_id, data);
        break;
      case "GUILD_MEMBER_UPDATE":
        this.logRoleChanges(data.guild_id, data);
        this.rememberRoles(data.guild_id, data);
        break;
      case "GUILD_MEMBER_REMOVE":
        this.queueAudit({ type: "member_leave", guildId: data.guild_id, message: `${displayUser(data.user)} left or was removed from the server.` });
        break;
      case "GUILD_UPDATE":
        this.guilds.set(data.id, { id: data.id, name: data.name, icon: data.icon });
        this.queueAudit({ type: "server_update", guildId: data.id, message: `Server profile updated: **${data.name}** (${data.id}).` });
        break;
      case "GUILD_ROLE_CREATE":
      case "GUILD_ROLE_UPDATE":
      case "GUILD_ROLE_DELETE":
        this.queueAudit({ type: "role", guildId: data.guild_id, message: `Role ${type.replace("GUILD_ROLE_", "").toLowerCase()}: **${data.role?.name || data.role_id || "unknown"}**.` });
        break;
      case "GUILD_BAN_ADD":
      case "GUILD_BAN_REMOVE":
        this.queueAudit({ type: "ban", guildId: data.guild_id, message: `${displayUser(data.user)} was ${type === "GUILD_BAN_ADD" ? "banned from" : "unbanned in"} the server.` });
        break;
      case "INVITE_CREATE":
      case "INVITE_DELETE":
        this.queueAudit({ type: "invite", guildId: data.guild_id, channelId: data.channel_id, message: `Invite ${type === "INVITE_CREATE" ? "created" : "deleted"} in <#${data.channel_id}>: ${data.code || "unknown code"}.` });
        break;
      case "WEBHOOKS_UPDATE":
        this.queueAudit({ type: "webhook", guildId: data.guild_id, channelId: data.channel_id, message: `Webhooks changed in <#${data.channel_id}>.` });
        break;
      case "GUILD_EMOJIS_UPDATE":
        this.queueAudit({ type: "emoji", guildId: data.guild_id, message: `Server emojis updated (${(data.emojis || []).length} total).` });
        break;
      case "GUILD_STICKERS_UPDATE":
        this.queueAudit({ type: "sticker", guildId: data.guild_id, message: `Server stickers updated (${(data.stickers || []).length} total).` });
        break;
      case "INTERACTION_CREATE":
        await this.handleInteraction(data);
        break;
    }
  }

  private rememberMessage(message: DiscordMessage): void {
    if (!message.channel_id) return;
    const list = this.messages.get(message.channel_id) || [];
    const idx = list.findIndex((m) => m.id === message.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...message };
    else list.push(message);
    this.messages.set(message.channel_id, list.slice(-MAX_MESSAGE_HISTORY));
  }

  private rememberRoles(guildId: string | undefined, member: DiscordMember): void {
    if (!guildId || !member.user?.id) return;
    this.knownMemberRoles.set(`${guildId}:${member.user.id}`, new Set(member.roles || []));
  }

  private logRoleChanges(guildId: string | undefined, member: DiscordMember): void {
    if (!guildId || !member.user?.id) return;
    const key = `${guildId}:${member.user.id}`;
    const before = this.knownMemberRoles.get(key) || new Set<string>();
    const after = new Set(member.roles || []);
    const added = [...after].filter((r) => !before.has(r));
    const removed = [...before].filter((r) => !after.has(r));
    if (added.length) this.queueAudit({ type: "roles", guildId, message: `Roles given to ${displayUser(member.user)}: ${added.map((r) => `<@&${r}>`).join(", ")}.` });
    if (removed.length) this.queueAudit({ type: "roles", guildId, message: `Roles removed from ${displayUser(member.user)}: ${removed.map((r) => `<@&${r}>`).join(", ")}.` });
  }

  private queueAudit(entry: Omit<AuditEntry, "at">): void {
    if (!this.logChannelIds.length && !this.logWebhookUrls.length) return;
    this.auditQueue.push({ ...entry, at: new Date().toISOString() });
  }

  private async flushAudit(): Promise<void> {
    if (!this.auditQueue.length || (!this.logChannelIds.length && !this.logWebhookUrls.length)) return;
    const batch = this.auditQueue.splice(0, this.auditQueue.length);
    const chunks: string[] = [];
    let current = `**Discord audit log** (${batch.length} event${batch.length === 1 ? "" : "s"})\n`;
    for (const entry of batch) {
      const line = `• [${entry.at}] ${entry.message}\n`;
      if ((current + line).length > 1900) {
        chunks.push(current);
        current = "**Discord audit log (continued)**\n";
      }
      current += line;
    }
    chunks.push(current);
    for (const channelId of this.logChannelIds) {
      for (const content of chunks) {
        await this.sendMessage(channelId, content).catch((e) => log.warn("Discord audit flush failed:", e));
      }
    }
    for (const webhookUrl of this.logWebhookUrls) {
      for (const content of chunks) {
        await this.postWebhook(webhookUrl, { content }).catch((e) => log.warn("Discord audit webhook flush failed:", e));
      }
    }
  }

  private async postWebhook(webhookUrl: string, body: unknown): Promise<void> {
    const res = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${await res.text().catch(() => "")}`);
  }

  private optionMap(data: any): Record<string, any> {
    const out: Record<string, any> = {};
    for (const opt of data.data?.options || []) out[opt.name] = opt.value ?? opt;
    return out;
  }

  private async handleInteraction(data: any): Promise<void> {
    const kind = data.type;
    if (kind === 2) return this.handleSlash(data);
    if (kind === 3) return this.handleComponent(data);
    if (kind === 5) return this.handleModal(data);
  }

  private async interactionCallback(interaction: any, body: unknown): Promise<void> {
    await fetch(`${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  private async followup(interaction: any, body: unknown): Promise<void> {
    await fetch(`${DISCORD_API}/webhooks/${this.applicationId}/${interaction.token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  private async editOriginal(interaction: any, body: unknown): Promise<void> {
    await fetch(`${DISCORD_API}/webhooks/${this.applicationId}/${interaction.token}/messages/@original`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  private async handleSlash(interaction: any): Promise<void> {
    const command = interaction.data.name;
    const opts = this.optionMap(interaction);
    if (command === "convert") {
      const attachment = this.attachmentFromOption(interaction, opts.file);
      if (attachment) return this.showConvertUi(interaction, attachment, true);
      this.pendingUploads.set(`${interaction.channel_id}:${interaction.member?.user?.id || interaction.user?.id}`, { userId: interaction.member?.user?.id || interaction.user?.id, channelId: interaction.channel_id, guildId: interaction.guild_id, expiresAt: Date.now() + 10 * 60_000 });
      await this.interactionCallback(interaction, { type: 4, data: { flags: 64, content: "Upload the file in this channel within 10 minutes. I’ll reply with a simple output-format picker." } });
      return;
    }
    if (command === "formats") {
      await this.interactionCallback(interaction, { type: 4, data: { flags: 64, content: await this.formatListMessage(opts.direction || "to", opts.category) } });
      return;
    }
    await this.interactionCallback(interaction, { type: 5 });
    try {
      if (command === "screenshot") await this.runUrlJob(interaction, "/api/screenshot?async=true", { url: opts.url, format: opts.format || "png" }, `screenshot.${opts.format || "png"}`);
      if (command === "download") await this.runUrlJob(interaction, "/api/ytdlp?async=true", { url: opts.url, format: opts.format || "best" }, "download.bin");
      if (command === "ocr") await this.runAttachmentJob(interaction, "/api/ocr?async=true", this.attachmentFromOption(interaction, opts.file), { mode: opts.mode || "txt" }, "ocr.txt");
      if (command === "transcribe") {
        const attachment = this.attachmentFromOption(interaction, opts.file);
        if (attachment) await this.runAttachmentJob(interaction, "/api/transcribe?async=true", attachment, { summarize: String(!!opts.summarize) }, "transcript.json");
        else await this.runUrlJob(interaction, "/api/transcribe?async=true", { url: opts.url, summarize: !!opts.summarize }, "transcript.json");
      }
    } catch (e) {
      await this.editOriginal(interaction, { content: `Failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private attachmentFromOption(interaction: any, value: any): DiscordAttachment | undefined {
    const id = typeof value === "string" ? value : value?.value;
    if (!id) return undefined;
    return interaction.data?.resolved?.attachments?.[id];
  }

  private async maybeHandlePendingUpload(message: DiscordMessage): Promise<void> {
    if (!message.author?.id || message.author.bot || !message.attachments?.length) return;
    const key = `${message.channel_id}:${message.author.id}`;
    const pending = this.pendingUploads.get(key);
    if (!pending || pending.expiresAt < Date.now()) return;
    this.pendingUploads.delete(key);
    const token = crypto.randomUUID();
    this.pendingConversions.set(token, { userId: pending.userId, channelId: pending.channelId, guildId: pending.guildId, attachment: message.attachments[0] });
    await this.deleteRawUploadMessage(message).catch((e) => log.warn("Discord raw upload cleanup failed:", e));
    await this.sendMessage(message.channel_id, `Got **${message.attachments[0].filename}**. I removed the raw upload message to keep the channel clean. Choose an output format:`).then(async (sent) => {
      await this.request("PATCH", `/channels/${message.channel_id}/messages/${sent.id}`, this.convertUiPayload(token, false));
    });
  }

  private async deleteRawUploadMessage(message: DiscordMessage): Promise<void> {
    if (!message.channel_id || !message.id) return;
    await new Promise((resolve) => setTimeout(resolve, RAW_UPLOAD_DELETE_DELAY_MS));
    await this.request("DELETE", `/channels/${message.channel_id}/messages/${message.id}`);
  }

  private async showConvertUi(interaction: any, attachment: DiscordAttachment, ephemeral: boolean): Promise<void> {
    const token = crypto.randomUUID();
    this.pendingConversions.set(token, { userId: interaction.member?.user?.id || interaction.user?.id, channelId: interaction.channel_id, guildId: interaction.guild_id, attachment });
    await this.interactionCallback(interaction, { type: 4, data: this.convertUiPayload(token, ephemeral) });
  }

  private convertUiPayload(token: string, ephemeral: boolean): any {
    return {
      flags: ephemeral ? 64 : undefined,
      content: "Choose a target format from the menu, click **Show all formats** for the complete API-reported list, or use **Custom format** for any extension this API supports (for example `pdf`).",
      components: [
        { type: 1, components: [{ type: 3, custom_id: `convert_select:${token}`, placeholder: "Pick output format", options: DEFAULT_OUTPUTS.slice(0, MAX_SELECT_OPTIONS).map((v) => ({ label: v.toUpperCase(), value: v })) }] },
        { type: 1, components: [
          { type: 2, style: 2, custom_id: `convert_custom:${token}`, label: "Custom format" },
          { type: 2, style: 2, custom_id: "formats_all:to", label: "Show all formats" },
        ] },
      ],
    };
  }

  private async handleComponent(interaction: any): Promise<void> {
    const customId = interaction.data.custom_id as string;
    const [action, token] = customId.split(":");
    if (action === "formats_all") {
      await this.interactionCallback(interaction, { type: 4, data: { flags: 64, content: await this.formatListMessage(token || "to") } });
      return;
    }
    if (action === "convert_custom") {
      await this.interactionCallback(interaction, { type: 9, data: { title: "Custom conversion format", custom_id: `convert_modal:${token}`, components: [{ type: 1, components: [{ type: 4, custom_id: "format", label: "Output extension (pdf, png, mp3, etc.)", style: 1, min_length: 1, max_length: 20, required: true }] }] } });
      return;
    }
    if (action === "convert_select") {
      const to = interaction.data.values?.[0];
      await this.interactionCallback(interaction, { type: 5, data: { flags: 64 } });
      await this.finishConversion(interaction, token, to);
    }
  }

  private async handleModal(interaction: any): Promise<void> {
    const [, token] = String(interaction.data.custom_id).split(":");
    const to = interaction.data.components?.[0]?.components?.[0]?.value;
    await this.interactionCallback(interaction, { type: 5, data: { flags: 64 } });
    await this.finishConversion(interaction, token, to);
  }

  private async finishConversion(interaction: any, token: string, to: string): Promise<void> {
    const pending = this.pendingConversions.get(token);
    if (!pending) return this.followup(interaction, { content: "That conversion session expired. Run `/convert` again.", flags: 64 });
    if ((interaction.member?.user?.id || interaction.user?.id) !== pending.userId) return this.followup(interaction, { content: "Only the person who started this conversion can use these controls.", flags: 64 });
    const target = normalizeFormat(to);
    if (!target) return this.followup(interaction, { content: "Pick or enter a valid output extension.", flags: 64 });
    try {
      await this.runAttachmentJob(interaction, "/api/convert?async=true", pending.attachment, { to: target }, `converted.${target}`);
      this.pendingConversions.delete(token);
    } catch (e) {
      await this.editOriginal(interaction, { content: `Conversion failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private apiHeaders(): Record<string, string> {
    return this.apiKey ? { "x-api-key": this.apiKey } : {};
  }

  private async runUrlJob(interaction: any, path: string, body: Record<string, unknown>, fallbackFileName: string): Promise<void> {
    const res = await fetch(`${this.apiBaseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...this.apiHeaders() }, body: JSON.stringify(body) });
    const result = await this.resolveApiResultWithProgress(interaction, res, fallbackFileName);
    await this.uploadResult(interaction.channel_id, result.bytes, result.fileName || fallbackFileName, result.contentType, `<@${interaction.member?.user?.id || interaction.user?.id}> done: ${result.fileName || fallbackFileName}`);
    await this.editOriginal(interaction, { content: `✅ Done — I posted **${result.fileName || fallbackFileName}** in this channel. ${progressBar(1)}` });
  }

  private async runAttachmentJob(interaction: any, path: string, attachment: DiscordAttachment | undefined, fields: Record<string, string>, fallbackFileName: string): Promise<void> {
    if (!attachment) throw new Error("Missing attachment");
    await this.editOriginal(interaction, { content: `Downloading **${attachment.filename || "upload.bin"}** from Discord... ${progressBar(0.03)}` });
    const source = await fetch(attachment.url);
    if (!source.ok) throw new Error(`Could not download Discord attachment (${source.status})`);
    const bytes = new Uint8Array(await source.arrayBuffer());
    const form = new FormData();
    form.set("file", new Blob([Buffer.from(bytes)], { type: attachment.content_type || "application/octet-stream" }), attachment.filename || "upload.bin");
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    const res = await fetch(`${this.apiBaseUrl}${path}`, { method: "POST", headers: this.apiHeaders(), body: form });
    const result = await this.resolveApiResultWithProgress(interaction, res, fallbackFileName);
    await this.uploadResult(interaction.channel_id, result.bytes, result.fileName || fallbackFileName, result.contentType, `<@${interaction.member?.user?.id || interaction.user?.id}> done: ${result.fileName || fallbackFileName}`);
    await this.editOriginal(interaction, { content: `✅ Done — I posted **${result.fileName || fallbackFileName}** in this channel. ${progressBar(1)}` });
  }

  private async resolveApiResultWithProgress(interaction: any, res: Response, fallbackFileName: string): Promise<ApiResult> {
    if (res.status !== 202) return this.resolveApiResult(res);
    const job = await res.json() as ApiJobAccepted;
    if (!job.statusUrl || !job.resultUrl) throw new Error("API returned an async job without status/result URLs");
    const estimate = formatDuration(job.estimateMs);
    let lastEdit = 0;
    while (true) {
      const statusRes = await fetch(job.statusUrl, { headers: this.apiHeaders() });
      if (!statusRes.ok) throw new Error(`Could not poll job ${job.jobId} (${statusRes.status})`);
      const snap = await statusRes.json() as ApiJobSnapshot;
      const progress = snap.progress ?? 0;
      const now = Date.now();
      if (now - lastEdit >= PROGRESS_UPDATE_MS || snap.status === "complete" || snap.status === "failed") {
        lastEdit = now;
        await this.editOriginal(interaction, { content: `Converting **${fallbackFileName}**
${progressBar(progress)}
Status: **${snap.status}** · estimated time: **${estimate}** · job: \`${job.jobId}\`` }).catch((e) => log.warn("Discord progress edit failed:", e));
      }
      if (snap.status === "failed") throw new Error(snap.error || "API job failed");
      if (snap.status === "cancelled") throw new Error("API job was cancelled");
      if (snap.status === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, Math.max(750, Math.min(job.pollAfterMs || 2_000, PROGRESS_UPDATE_MS))));
    }
    const url = new URL(job.resultUrl);
    const resultRes = await fetch(url, { headers: this.apiHeaders() });
    return this.resolveApiResult(resultRes);
  }

  private async resolveApiResult(res: Response): Promise<ApiResult> {
    if (!res.ok) throw new Error(`API failed (${res.status}): ${await res.text().catch(() => "")}`);
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const disposition = res.headers.get("content-disposition") || "";
    const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(disposition);
    const fileName = match ? decodeURIComponent(match[1] || match[2]) : undefined;
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType, fileName };
  }

  private async fetchFormats(direction = "to", category?: string): Promise<FormatEntry[]> {
    if (!this.formatCache || Date.now() - this.formatCache.at > 5 * 60_000) {
      const url = new URL("/api/formats", this.apiBaseUrl);
      const res = await fetch(url, { headers: this.apiHeaders() });
      if (!res.ok) throw new Error(`Could not load formats (${res.status})`);
      const json = await res.json() as { formats?: FormatEntry[] };
      this.formatCache = { at: Date.now(), formats: json.formats || [] };
    }
    const dir = String(direction || "to").toLowerCase();
    const cat = typeof category === "string" ? category.toLowerCase().trim() : "";
    return this.formatCache.formats.filter((f) => {
      if (dir === "to" && !f.to) return false;
      if (dir === "from" && !f.from) return false;
      if (cat) {
        const cats = Array.isArray(f.category) ? f.category : f.category ? [f.category] : [];
        if (!cats.some((c) => c.toLowerCase() === cat)) return false;
      }
      return true;
    });
  }

  private async formatListMessage(direction = "to", category?: string): Promise<string> {
    try {
      const formats = await this.fetchFormats(direction, category);
      const unique = [...new Map(formats.map((f) => [f.format || f.extension || f.mime || f.name || "unknown", f])).values()]
        .sort((a, b) => (a.format || "").localeCompare(b.format || ""));
      const label = direction === "from" ? "input" : direction === "all" ? "input/output" : "output";
      const items = unique.map((f) => `\`${f.format || f.extension}\`${f.name ? ` ${f.name}` : ""}`).join(", ");
      const prefix = `**${unique.length} ${category ? `${category} ` : ""}${label} format${unique.length === 1 ? "" : "s"}**
`;
      const suffix = `

Tip: use **Custom format** in /convert if the dropdown does not show the extension you want. Full machine-readable list: \`GET /api/formats${direction && direction !== "all" ? `?direction=${direction}` : ""}\`.`;
      const maxItems = 1900 - prefix.length - suffix.length;
      return `${prefix}${items.length > maxItems ? `${items.slice(0, maxItems)}…` : items || "No formats matched."}${suffix}`;
    } catch (e) {
      return `I could not load the format list: ${e instanceof Error ? e.message : String(e)}. Try GET /api/formats on the API server.`;
    }
  }

  private async uploadResult(channelId: string, bytes: Uint8Array, fileName: string, contentType: string, content: string): Promise<void> {
    const form = new FormData();
    form.set("payload_json", JSON.stringify({ content }));
    form.set("files[0]", new Blob([Buffer.from(bytes)], { type: contentType }), apiFileName(fileName));
    await this.requestMultipart(`/channels/${channelId}/messages`, form);
  }
}

export const discordBot = new DiscordBot();
