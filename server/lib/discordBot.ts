import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { log } from "./log.ts";

const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_VERSION = 10;
const MAX_MESSAGE_HISTORY = Number(process.env.DISCORD_WEB_HISTORY_LIMIT) || 100;
const AUDIT_FLUSH_MS = Number(process.env.DISCORD_AUDIT_FLUSH_MS) || 30_000;
const PROGRESS_UPDATE_MS = Number(process.env.DISCORD_PROGRESS_UPDATE_MS) || 5_000;
const RAW_UPLOAD_DELETE_DELAY_MS = Number(process.env.DISCORD_RAW_UPLOAD_DELETE_DELAY_MS) || 1_500;
const MAX_SELECT_OPTIONS = 25;
const DEFAULT_OUTPUTS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "mp3",
  "mp4",
  "wav",
  "ogg",
  "txt",
  "json",
  "csv",
  "xml",
  "html",
  "md",
  "svg",
  "zip",
  "7z",
  "tar",
  "gz",
  "webm",
  "mov",
  "avi",
  "ico",
];

const INTENTS =
  1 | // GUILDS
  2 | // GUILD_MEMBERS
  4 | // GUILD_MODERATION
  8 | // GUILD_EMOJIS_AND_STICKERS
  16 | // GUILD_INTEGRATIONS
  32 | // GUILD_WEBHOOKS
  64 | // GUILD_INVITES
  512 | // GUILD_MESSAGES
  1024 | // GUILD_MESSAGE_REACTIONS
  32768 | // MESSAGE_CONTENT
  65536 | // GUILD_SCHEDULED_EVENTS
  1048576 | // AUTO_MODERATION_CONFIGURATION
  2097152; // AUTO_MODERATION_EXECUTION

interface DiscordUser {
  id: string;
  username?: string;
  discriminator?: string;
  global_name?: string | null;
  bot?: boolean;
}

interface DiscordGuild {
  id: string;
  name?: string;
  unavailable?: boolean;
  icon?: string | null;
  member_count?: number;
  channels?: DiscordChannel[];
}

interface DiscordChannel {
  id: string;
  guild_id?: string;
  name?: string;
  type: number;
  parent_id?: string | null;
  position?: number;
  topic?: string | null;
}

interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size?: number;
  url: string;
  proxy_url?: string;
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

interface DiscordInteraction {
  id: string;
  token: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user?: DiscordUser };
  user?: DiscordUser;
  message?: DiscordMessage;
  data?: {
    id?: string;
    name?: string;
    custom_id?: string;
    component_type?: number;
    values?: string[];
    options?: InteractionOption[];
    resolved?: {
      attachments?: Record<string, DiscordAttachment>;
    };
    components?: Array<{
      type: number;
      components?: Array<{
        type: number;
        custom_id: string;
        value?: string;
      }>;
    }>;
  };
}

interface InteractionOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: InteractionOption[];
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

interface AuditEvent {
  type: string;
  guildId?: string;
  channelId?: string;
  message: string;
  at: number;
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

interface JobSnapshot {
  jobId?: string;
  id?: string;
  kind?: string;
  status?: "queued" | "running" | "complete" | "failed" | "cancelled";
  progress?: number;
  estimateMs?: number;
  estimatedSeconds?: number;
  statusUrl?: string;
  resultUrl?: string;
  error?: string;
  result?: {
    contentType?: string;
    fileName?: string;
  };
}

function firstApiKey(): string {
  return (process.env.DISCORD_CONVERT_API_KEY || process.env.CONVERT_API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)[0] || "";
}

function commaList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function cleanContent(content: unknown, max = 500): string {
  const s = typeof content === "string" && content.trim() ? content.trim() : "(no text)";
  return s.replace(/\s+/g, " ").slice(0, max);
}

function displayUser(user?: DiscordUser): string {
  if (!user) return "unknown user";
  return user.global_name || user.username || user.id;
}

function apiFileName(name: string): string {
  return name.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "result.bin";
}

function formatBytes(n?: number): string {
  if (!Number.isFinite(n)) return "unknown size";
  const bytes = Number(n);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function progressBar(progress?: number): string {
  const clamped = Math.max(0, Math.min(1, Number(progress) || 0));
  const filled = Math.round(clamped * 10);
  return `[${"#".repeat(filled)}${"-".repeat(10 - filled)}] ${Math.round(clamped * 100)}%`;
}

function fieldValue(options: InteractionOption[] | undefined, name: string): unknown {
  return options?.find((o) => o.name === name)?.value;
}

function boolFlag(flags: number | undefined, flag: number): boolean {
  return ((flags ?? 0) & flag) === flag;
}

export class DiscordBot {
  private token = process.env.DISCORD_BOT_TOKEN || "";
  private apiBaseUrl =
    process.env.CONVERT_API_BASE_URL ||
    process.env.DISCORD_CONVERT_API_BASE_URL ||
    `http://127.0.0.1:${Number(process.env.PORT) || 3000}`;
  private apiKey = firstApiKey();
  private applicationId = process.env.DISCORD_APPLICATION_ID || "";
  private commandGuildId = process.env.DISCORD_GUILD_ID || "";
  private auditChannelIds = commaList(process.env.DISCORD_AUDIT_CHANNEL_IDS || process.env.DISCORD_AUDIT_CHANNEL_ID);
  private auditWebhookUrls = commaList(process.env.DISCORD_AUDIT_WEBHOOK_URLS || process.env.DISCORD_AUDIT_WEBHOOK_URL);

  private ws?: WebSocket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private auditTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private sequence: number | null = null;
  private sessionId = "";
  private gatewayUrl = "";
  private botUser?: DiscordUser;
  private connected = false;
  private ready = false;
  private started = false;
  private stopped = false;
  private lastError?: string;
  private commandVersion = "";

  private guilds = new Map<string, DiscordGuild>();
  private channels = new Map<string, DiscordChannel>();
  private messagesByChannel = new Map<string, DiscordMessage[]>();
  private pendingUploads = new Map<string, PendingUpload>();
  private pendingConversions = new Map<string, PendingConversion>();
  private auditQueue: AuditEvent[] = [];
  private formatCache?: { at: number; formats: FormatEntry[] };

  get enabled(): boolean {
    return !!this.token;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.auditTimer = setInterval(() => void this.flushAudit(), AUDIT_FLUSH_MS);
    this.auditTimer.unref?.();

    if (!this.token) {
      log.info("Discord bot disabled (set DISCORD_BOT_TOKEN to enable)");
      return;
    }
    if (typeof WebSocket === "undefined") {
      this.lastError = "Global WebSocket is not available in this Node runtime";
      log.warn(`Discord bot disabled: ${this.lastError}`);
      return;
    }

    try {
      await this.loadApplication();
      await this.registerCommands();
      await this.connectGateway();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      log.error("Discord startup failed:", e);
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.auditTimer) clearInterval(this.auditTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = undefined;
    this.auditTimer = undefined;
    this.reconnectTimer = undefined;
    await this.flushAudit();
    this.ws?.close(1000, "server shutting down");
  }

  status() {
    return {
      enabled: this.enabled,
      connected: this.connected,
      ready: this.ready,
      applicationId: this.applicationId || null,
      botUser: this.botUser || null,
      apiBaseUrl: this.apiBaseUrl,
      commandGuildId: this.commandGuildId || null,
      guilds: this.guilds.size,
      channels: this.channels.size,
      pendingUploads: this.pendingUploads.size,
      pendingConversions: this.pendingConversions.size,
      auditQueue: this.auditQueue.length,
      auditChannels: this.auditChannelIds.length,
      auditWebhooks: this.auditWebhookUrls.length,
      lastError: this.lastError || null,
    };
  }

  listGuilds(): DiscordGuild[] {
    return Array.from(this.guilds.values()).sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }

  listChannels(guildId?: string): DiscordChannel[] {
    return Array.from(this.channels.values())
      .filter((c) => !guildId || c.guild_id === guildId)
      .sort((a, b) => {
        const byGuild = (a.guild_id || "").localeCompare(b.guild_id || "");
        if (byGuild) return byGuild;
        return (a.position ?? 0) - (b.position ?? 0) || (a.name || a.id).localeCompare(b.name || b.id);
      });
  }

  listMessages(channelId: string): DiscordMessage[] {
    return [...(this.messagesByChannel.get(channelId) || [])].reverse();
  }

  async sendChannelMessage(channelId: string, content: string): Promise<DiscordMessage> {
    if (!content.trim()) throw new Error("Message content is required");
    return this.request<DiscordMessage>(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: content.slice(0, 1900) }),
    });
  }

  private async loadApplication(): Promise<void> {
    const app = await this.request<{ id: string; bot?: DiscordUser }>("/oauth2/applications/@me");
    this.applicationId = this.applicationId || app.id;
    if (app.bot) this.botUser = app.bot;
  }

  private async connectGateway(): Promise<void> {
    const gateway = await this.request<{ url: string }>("/gateway/bot");
    this.gatewayUrl = `${gateway.url}/?v=${GATEWAY_VERSION}&encoding=json`;
    this.openSocket();
  }

  private openSocket(): void {
    if (this.stopped || !this.gatewayUrl) return;
    this.ws?.close();
    const ws = new WebSocket(this.gatewayUrl);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      log.info("Discord gateway connected");
    });
    ws.addEventListener("message", (event) => void this.onGatewayMessage(event));
    ws.addEventListener("close", (event) => {
      this.connected = false;
      this.ready = false;
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      const close = event as { code?: number; reason?: string };
      const reason = close.code ? `${close.code} ${close.reason || ""}`.trim() : "closed";
      if (!this.stopped) {
        log.warn(`Discord gateway closed (${reason}); reconnecting`);
        this.scheduleReconnect();
      }
    });
    ws.addEventListener("error", () => {
      this.lastError = "Discord gateway socket error";
    });
  }

  private async onGatewayMessage(event: MessageEvent): Promise<void> {
    try {
      const raw = typeof event.data === "string" ? event.data : Buffer.from(await (event.data as Blob).arrayBuffer()).toString("utf8");
      const payload = JSON.parse(raw) as { op: number; d?: unknown; s?: number | null; t?: string | null };
      if (typeof payload.s === "number") this.sequence = payload.s;
      switch (payload.op) {
        case 10:
          this.startHeartbeat((payload.d as { heartbeat_interval?: number })?.heartbeat_interval || 45_000);
          this.identify();
          break;
        case 0:
          await this.handleDispatch(payload.t || "", payload.d);
          break;
        case 1:
          this.sendGateway({ op: 1, d: this.sequence });
          break;
        case 7:
          this.scheduleReconnect();
          break;
        case 9:
          this.sessionId = "";
          this.sequence = null;
          this.scheduleReconnect();
          break;
      }
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      log.warn("Discord gateway message failed:", e);
    }
  }

  private startHeartbeat(ms: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.sendGateway({ op: 1, d: this.sequence }), ms);
    this.heartbeatTimer.unref?.();
  }

  private identify(): void {
    this.sendGateway({
      op: 2,
      d: {
        token: this.token,
        intents: INTENTS,
        properties: { os: process.platform, browser: "convert-api", device: "convert-api" },
      },
    });
  }

  private sendGateway(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.token) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const wait = Math.min(60_000, 1_000 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = setTimeout(() => {
      void this.connectGateway().catch((e) => {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.scheduleReconnect();
      });
    }, wait);
    this.reconnectTimer.unref?.();
  }

  private async handleDispatch(type: string, data: unknown): Promise<void> {
    const d = data as Record<string, unknown>;
    switch (type) {
      case "READY":
        this.ready = true;
        this.sessionId = String(d.session_id || "");
        this.botUser = d.user as DiscordUser;
        for (const g of (d.guilds as DiscordGuild[] | undefined) || []) this.guilds.set(g.id, g);
        this.queueAudit({ type: "ready", message: `Discord bot connected as ${displayUser(this.botUser)}.` });
        break;
      case "GUILD_CREATE":
      case "GUILD_UPDATE":
        this.rememberGuild(d as unknown as DiscordGuild);
        this.queueAudit({
          type: type.toLowerCase(),
          guildId: String(d.id || ""),
          message: `Guild ${type === "GUILD_CREATE" ? "available" : "updated"}: ${String(d.name || d.id)}.`,
        });
        break;
      case "GUILD_DELETE":
        this.guilds.delete(String(d.id || ""));
        this.queueAudit({ type: "guild_delete", guildId: String(d.id || ""), message: `Guild unavailable or removed: ${String(d.id || "")}.` });
        break;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
        this.channels.set(String(d.id || ""), d as unknown as DiscordChannel);
        this.queueAudit({
          type: type.toLowerCase(),
          guildId: String(d.guild_id || ""),
          channelId: String(d.id || ""),
          message: `Channel ${type === "CHANNEL_CREATE" ? "created" : "updated"}: #${String(d.name || d.id)}.`,
        });
        break;
      case "CHANNEL_DELETE":
        this.channels.delete(String(d.id || ""));
        this.queueAudit({
          type: "channel_delete",
          guildId: String(d.guild_id || ""),
          channelId: String(d.id || ""),
          message: `Channel deleted: #${String(d.name || d.id)}.`,
        });
        break;
      case "MESSAGE_CREATE":
        this.rememberMessage(d as unknown as DiscordMessage);
        this.logMessageCreate(d as unknown as DiscordMessage);
        await this.maybeHandlePendingUpload(d as unknown as DiscordMessage);
        break;
      case "MESSAGE_UPDATE":
        this.rememberMessage(d as unknown as DiscordMessage);
        this.queueAudit({
          type: "message_edit",
          guildId: String(d.guild_id || ""),
          channelId: String(d.channel_id || ""),
          message: `Message edited in <#${String(d.channel_id || "")}> by ${displayUser(d.author as DiscordUser)}: ${cleanContent(d.content)} (message ${String(d.id || "")}).`,
        });
        break;
      case "MESSAGE_DELETE":
        this.queueAudit({
          type: "message_delete",
          guildId: String(d.guild_id || ""),
          channelId: String(d.channel_id || ""),
          message: `Message deleted in <#${String(d.channel_id || "")}> (message ${String(d.id || "")}).`,
        });
        break;
      case "MESSAGE_DELETE_BULK":
        this.queueAudit({
          type: "message_bulk_delete",
          guildId: String(d.guild_id || ""),
          channelId: String(d.channel_id || ""),
          message: `${((d.ids as unknown[]) || []).length} messages bulk-deleted in <#${String(d.channel_id || "")}>.`,
        });
        break;
      case "GUILD_MEMBER_ADD":
      case "GUILD_MEMBER_REMOVE":
        this.queueAudit({
          type: type.toLowerCase(),
          guildId: String(d.guild_id || ""),
          message: `${type === "GUILD_MEMBER_ADD" ? "Member joined" : "Member left"}: ${displayUser((d.user || d) as DiscordUser)}.`,
        });
        break;
      case "GUILD_ROLE_CREATE":
      case "GUILD_ROLE_UPDATE":
      case "GUILD_ROLE_DELETE":
      case "GUILD_BAN_ADD":
      case "GUILD_BAN_REMOVE":
      case "INVITE_CREATE":
      case "INVITE_DELETE":
      case "WEBHOOKS_UPDATE":
      case "GUILD_EMOJIS_UPDATE":
      case "GUILD_STICKERS_UPDATE":
      case "MESSAGE_REACTION_ADD":
      case "MESSAGE_REACTION_REMOVE":
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
      case "THREAD_DELETE":
      case "INTEGRATION_CREATE":
      case "INTEGRATION_UPDATE":
      case "INTEGRATION_DELETE":
      case "GUILD_SCHEDULED_EVENT_CREATE":
      case "GUILD_SCHEDULED_EVENT_UPDATE":
      case "GUILD_SCHEDULED_EVENT_DELETE":
      case "AUTO_MODERATION_ACTION_EXECUTION":
        this.queueAudit({
          type: type.toLowerCase(),
          guildId: String(d.guild_id || ""),
          channelId: String(d.channel_id || d.id || ""),
          message: this.describeAuditEvent(type, d),
        });
        break;
      case "INTERACTION_CREATE":
        await this.handleInteraction(data as DiscordInteraction);
        break;
    }
  }

  private rememberGuild(guild: DiscordGuild): void {
    if (!guild.id) return;
    this.guilds.set(guild.id, guild);
    for (const channel of guild.channels || []) {
      this.channels.set(channel.id, { ...channel, guild_id: channel.guild_id || guild.id });
    }
  }

  private rememberMessage(message: DiscordMessage): void {
    if (!message.channel_id || !message.id) return;
    const existing = this.messagesByChannel.get(message.channel_id) || [];
    const next = [message, ...existing.filter((m) => m.id !== message.id)].slice(0, MAX_MESSAGE_HISTORY);
    this.messagesByChannel.set(message.channel_id, next);
  }

  private logMessageCreate(message: DiscordMessage): void {
    if (!message.guild_id || message.author?.id === this.botUser?.id) return;
    const attachmentText = message.attachments?.length
      ? ` Attachments: ${message.attachments.map((a) => `${a.filename} (${formatBytes(a.size)})`).join(", ")}.`
      : "";
    this.queueAudit({
      type: "message_create",
      guildId: message.guild_id,
      channelId: message.channel_id,
      message: `Message in <#${message.channel_id}> by ${displayUser(message.author)}: ${cleanContent(message.content)}.${attachmentText}`,
    });
  }

  private async handleInteraction(interaction: DiscordInteraction): Promise<void> {
    try {
      if (interaction.type === 2) {
        await this.handleSlash(interaction);
        return;
      }
      if (interaction.type === 3) {
        await this.handleComponent(interaction);
        return;
      }
      if (interaction.type === 5) {
        await this.handleModal(interaction);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.queueAudit({
        type: "interaction_error",
        guildId: interaction.guild_id,
        channelId: interaction.channel_id,
        message: `Interaction ${interaction.data?.name || interaction.data?.custom_id || interaction.id} failed: ${message}`,
      });
      await this.respondOrEdit(interaction, { content: `Sorry, that failed: ${message}`, flags: 64 }).catch(() => undefined);
    }
  }

  private async handleSlash(interaction: DiscordInteraction): Promise<void> {
    const name = interaction.data?.name || "";
    this.queueAudit({
      type: "slash_command",
      guildId: interaction.guild_id,
      channelId: interaction.channel_id,
      message: `/${name} used by ${displayUser(interaction.member?.user || interaction.user)}.`,
    });
    switch (name) {
      case "convert":
        await this.handleConvertCommand(interaction);
        break;
      case "formats":
        await this.respondDeferred(interaction);
        await this.editOriginal(interaction, {
          content: await this.formatListMessage(
            String(fieldValue(interaction.data?.options, "direction") || "to"),
            fieldValue(interaction.data?.options, "category") as string | undefined,
          ),
        });
        break;
      case "screenshot":
        await this.respondDeferred(interaction);
        await this.runSimpleApiJob(interaction, "/api/screenshot", {
          json: {
            url: String(fieldValue(interaction.data?.options, "url") || ""),
            format: String(fieldValue(interaction.data?.options, "format") || "png"),
            fullPage: Boolean(fieldValue(interaction.data?.options, "full_page")),
            async: true,
          },
          label: "Screenshot",
        });
        break;
      case "download":
        await this.respondDeferred(interaction);
        await this.runSimpleApiJob(interaction, "/api/ytdlp", {
          json: {
            url: String(fieldValue(interaction.data?.options, "url") || ""),
            format: String(fieldValue(interaction.data?.options, "format") || "best"),
            quality: fieldValue(interaction.data?.options, "quality"),
            async: true,
          },
          label: "Download",
        });
        break;
      case "ocr":
        await this.respondDeferred(interaction);
        await this.runFileOrUrlJob(interaction, "/api/ocr", {
          label: "OCR",
          fields: {
            mode: String(fieldValue(interaction.data?.options, "mode") || "txt"),
            lang: String(fieldValue(interaction.data?.options, "lang") || "eng"),
            async: "true",
          },
        });
        break;
      case "transcribe":
        await this.respondDeferred(interaction);
        await this.runFileOrUrlJob(interaction, "/api/transcribe", {
          label: "Transcription",
          fields: {
            language: String(fieldValue(interaction.data?.options, "language") || ""),
            summarize: String(Boolean(fieldValue(interaction.data?.options, "summarize"))),
            async: "true",
          },
        });
        break;
    }
  }

  private async handleConvertCommand(interaction: DiscordInteraction): Promise<void> {
    const attachment = this.optionAttachment(interaction, "file");
    const userId = interaction.member?.user?.id || interaction.user?.id || "";
    if (!interaction.channel_id || !userId) {
      await this.respond(interaction, { content: "I need a channel and user context to start a conversion.", flags: 64 });
      return;
    }
    if (attachment) {
      const token = randomUUID();
      this.pendingConversions.set(token, {
        userId,
        channelId: interaction.channel_id,
        guildId: interaction.guild_id,
        attachment,
      });
      await this.respond(interaction, this.convertUiPayload(token, attachment));
      return;
    }

    this.pendingUploads.set(`${interaction.channel_id}:${userId}`, {
      userId,
      channelId: interaction.channel_id,
      guildId: interaction.guild_id,
      expiresAt: Date.now() + 10 * 60_000,
    });
    await this.respond(interaction, {
      content: "Upload or paste the file you want to convert in this channel within 10 minutes.",
      flags: 64,
    });
  }

  private async handleComponent(interaction: DiscordInteraction): Promise<void> {
    const customId = interaction.data?.custom_id || "";
    if (customId.startsWith("convert_select:")) {
      const token = customId.slice("convert_select:".length);
      const target = interaction.data?.values?.[0] || "";
      await this.respondDeferredUpdate(interaction);
      await this.runConversion(interaction, token, target);
      return;
    }
    if (customId.startsWith("convert_custom:")) {
      const token = customId.slice("convert_custom:".length);
      await this.respondModal(interaction, {
        title: "Custom format",
        custom_id: `convert_modal:${token}`,
        components: [
          {
            type: 1,
            components: [
              {
                type: 4,
                custom_id: "format",
                label: "Target extension",
                style: 1,
                required: true,
                min_length: 1,
                max_length: 16,
                placeholder: "pdf",
              },
            ],
          },
        ],
      });
      return;
    }
    if (customId.startsWith("formats_all:")) {
      const direction = customId.slice("formats_all:".length) || "to";
      await this.respondDeferred(interaction, true);
      await this.editOriginal(interaction, { content: await this.formatListMessage(direction) });
    }
  }

  private async handleModal(interaction: DiscordInteraction): Promise<void> {
    const customId = interaction.data?.custom_id || "";
    if (!customId.startsWith("convert_modal:")) return;
    const token = customId.slice("convert_modal:".length);
    const format = interaction.data?.components?.[0]?.components?.find((c) => c.custom_id === "format")?.value || "";
    await this.respondDeferred(interaction);
    await this.runConversion(interaction, token, format.toLowerCase().replace(/^\./, ""));
  }

  private async maybeHandlePendingUpload(message: DiscordMessage): Promise<void> {
    if (!message.channel_id || !message.author?.id || !message.attachments?.length) return;
    const key = `${message.channel_id}:${message.author.id}`;
    const pending = this.pendingUploads.get(key);
    if (!pending) return;
    if (pending.expiresAt < Date.now()) {
      this.pendingUploads.delete(key);
      return;
    }
    this.pendingUploads.delete(key);
    const attachment = message.attachments[0];
    const token = randomUUID();
    this.pendingConversions.set(token, {
      userId: pending.userId,
      channelId: pending.channelId,
      guildId: pending.guildId,
      attachment,
    });
    await this.sendChannelMessagePayload(pending.channelId, this.convertUiPayload(token, attachment));
    await delay(RAW_UPLOAD_DELETE_DELAY_MS);
    await this.deleteRawUploadMessage(message).then(
      () =>
        this.queueAudit({
          type: "raw_upload_cleanup",
          guildId: message.guild_id,
          channelId: message.channel_id,
          message: `Deleted raw post-/convert upload message ${message.id}.`,
        }),
      (e) =>
        this.queueAudit({
          type: "raw_upload_cleanup_failed",
          guildId: message.guild_id,
          channelId: message.channel_id,
          message: `Could not delete raw post-/convert upload message ${message.id}: ${e instanceof Error ? e.message : String(e)}.`,
        }),
    );
  }

  private convertUiPayload(token: string, attachment: DiscordAttachment) {
    return {
      content: `Ready to convert **${attachment.filename}** (${formatBytes(attachment.size)}).`,
      components: [
        {
          type: 1,
          components: [
            {
              type: 3,
              custom_id: `convert_select:${token}`,
              placeholder: "Pick output format",
              options: DEFAULT_OUTPUTS.slice(0, MAX_SELECT_OPTIONS).map((value) => ({
                label: value.toUpperCase(),
                value,
              })),
            },
          ],
        },
        {
          type: 1,
          components: [
            { type: 2, style: 2, custom_id: `convert_custom:${token}`, label: "Custom format" },
            { type: 2, style: 2, custom_id: "formats_all:to", label: "Show all formats" },
          ],
        },
      ],
    };
  }

  private async runConversion(interaction: DiscordInteraction, token: string, target: string): Promise<void> {
    const conversion = this.pendingConversions.get(token);
    if (!conversion) {
      await this.editOriginal(interaction, { content: "That conversion session has expired. Run /convert again.", components: [] });
      return;
    }
    if (!target) {
      await this.editOriginal(interaction, { content: "Pick a target format first.", components: [] });
      return;
    }
    this.pendingConversions.delete(token);
    this.queueAudit({
      type: "conversion_start",
      guildId: conversion.guildId,
      channelId: conversion.channelId,
      message: `Converting ${conversion.attachment.filename} to ${target}.`,
    });
    await this.editOriginal(interaction, {
      content: `Converting **${conversion.attachment.filename}** to **${target}**...\n${progressBar(0)}`,
      components: [],
    });
    const form = new FormData();
    form.set("to", target);
    form.set("async", "true");
    const file = await this.fetchAttachment(conversion.attachment);
    form.set("file", new Blob([Buffer.from(file.bytes)], { type: file.contentType }), apiFileName(conversion.attachment.filename));
    const job = await this.apiFetchJob("/api/convert", { method: "POST", body: form });
    await this.resolveApiResultWithProgress(interaction, job, {
      channelId: conversion.channelId,
      label: "Conversion",
      fallbackFileName: conversion.attachment.filename,
    });
  }

  private async runFileOrUrlJob(
    interaction: DiscordInteraction,
    endpoint: string,
    opts: { label: string; fields: Record<string, string> },
  ): Promise<void> {
    const attachment = this.optionAttachment(interaction, "file");
    const url = String(fieldValue(interaction.data?.options, "url") || "");
    if (!attachment && !url) {
      await this.editOriginal(interaction, { content: `Provide a file attachment or URL for ${opts.label.toLowerCase()}.` });
      return;
    }
    if (attachment) {
      const form = new FormData();
      for (const [k, v] of Object.entries(opts.fields)) if (v) form.set(k, v);
      const file = await this.fetchAttachment(attachment);
      form.set("file", new Blob([Buffer.from(file.bytes)], { type: file.contentType }), apiFileName(attachment.filename));
      const job = await this.apiFetchJob(endpoint, { method: "POST", body: form });
      await this.resolveApiResultWithProgress(interaction, job, {
        channelId: interaction.channel_id!,
        label: opts.label,
        fallbackFileName: attachment.filename,
      });
      return;
    }
    const job = await this.apiFetchJob(endpoint, {
      method: "POST",
      body: JSON.stringify({ ...opts.fields, url, async: true }),
    });
    await this.resolveApiResultWithProgress(interaction, job, {
      channelId: interaction.channel_id!,
      label: opts.label,
      fallbackFileName: `${opts.label.toLowerCase()}.bin`,
    });
  }

  private async runSimpleApiJob(
    interaction: DiscordInteraction,
    endpoint: string,
    opts: { json: Record<string, unknown>; label: string },
  ): Promise<void> {
    const job = await this.apiFetchJob(endpoint, { method: "POST", body: JSON.stringify(opts.json) });
    await this.resolveApiResultWithProgress(interaction, job, {
      channelId: interaction.channel_id!,
      label: opts.label,
      fallbackFileName: `${opts.label.toLowerCase()}.bin`,
    });
  }

  private async resolveApiResultWithProgress(
    interaction: DiscordInteraction,
    accepted: JobSnapshot,
    opts: { channelId: string; label: string; fallbackFileName: string },
  ): Promise<void> {
    let snap = accepted;
    const statusUrl = accepted.statusUrl || (accepted.jobId ? this.apiUrl(`/api/jobs/${accepted.jobId}`).toString() : "");
    const resultUrl = accepted.resultUrl || (accepted.jobId ? this.apiUrl(`/api/jobs/${accepted.jobId}/result`).toString() : "");
    if (!statusUrl || !resultUrl) {
      throw new Error("API did not return job status/result URLs");
    }
    while (snap.status === "queued" || snap.status === "running" || !snap.status) {
      const progress = Number(snap.progress ?? 0);
      const estimate = snap.estimatedSeconds ?? (snap.estimateMs ? Math.round(snap.estimateMs / 100) / 10 : "?");
      await this.editOriginal(interaction, {
        content: `${opts.label} running for **${opts.fallbackFileName}**\n${progressBar(progress)}\nStatus: **${snap.status || "queued"}** - estimated time: **${estimate}s** - job: \`${snap.jobId || snap.id || "pending"}\``,
        components: [],
      });
      await delay(PROGRESS_UPDATE_MS);
      const res = await fetch(statusUrl, { headers: this.apiHeaders() });
      if (!res.ok) throw new Error(`Job status failed (${res.status})`);
      snap = (await res.json()) as JobSnapshot;
    }
    if (snap.status !== "complete") {
      throw new Error(snap.error || `${opts.label} ended with status ${snap.status}`);
    }
    const result = await fetch(resultUrl, { headers: this.apiHeaders() });
    if (!result.ok) throw new Error(`Result download failed (${result.status})`);
    const bytes = new Uint8Array(await result.arrayBuffer());
    const fileName = snap.result?.fileName || this.fileNameFromDisposition(result.headers.get("content-disposition")) || opts.fallbackFileName;
    const contentType = result.headers.get("content-type") || snap.result?.contentType || "application/octet-stream";
    await this.uploadFile(opts.channelId, bytes, contentType, fileName, `${opts.label} complete: **${apiFileName(fileName)}**`);
    await this.editOriginal(interaction, {
      content: `${opts.label} complete. I uploaded **${apiFileName(fileName)}** to this channel.`,
      components: [],
    });
    this.queueAudit({
      type: "conversion_complete",
      guildId: interaction.guild_id,
      channelId: opts.channelId,
      message: `${opts.label} complete for ${opts.fallbackFileName}: ${fileName}.`,
    });
  }

  private async apiFetchJob(path: string, init: RequestInit): Promise<JobSnapshot> {
    const headers = new Headers(init.headers);
    if (!(init.body instanceof FormData)) headers.set("content-type", "application/json");
    for (const [k, v] of Object.entries(this.apiHeaders())) headers.set(k, v);
    const res = await fetch(this.apiUrl(path), { ...init, headers });
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok) {
      const body = contentType.includes("json") ? JSON.stringify(await res.json()) : await res.text();
      throw new Error(`Convert API failed (${res.status}): ${body.slice(0, 500)}`);
    }
    if (contentType.includes("json")) return (await res.json()) as JobSnapshot;
    throw new Error("Convert API returned a file inline when an async job was expected");
  }

  private async fetchAttachment(attachment: DiscordAttachment): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`Could not download Discord attachment (${res.status})`);
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") || attachment.content_type || "application/octet-stream",
    };
  }

  private optionAttachment(interaction: DiscordInteraction, name: string): DiscordAttachment | undefined {
    const option = interaction.data?.options?.find((o) => o.name === name);
    const id = typeof option?.value === "string" ? option.value : "";
    return id ? interaction.data?.resolved?.attachments?.[id] : undefined;
  }

  private async fetchFormats(direction = "to", category?: string): Promise<FormatEntry[]> {
    if (!this.formatCache || Date.now() - this.formatCache.at > 5 * 60_000) {
      const url = this.apiUrl("/api/formats");
      const res = await fetch(url, { headers: this.apiHeaders() });
      if (!res.ok) throw new Error(`Format list failed (${res.status})`);
      const json = (await res.json()) as { formats?: FormatEntry[] };
      this.formatCache = { at: Date.now(), formats: json.formats || [] };
    }
    return this.formatCache.formats.filter((f) => {
      if (direction === "from" && !f.from) return false;
      if (direction === "to" && !f.to) return false;
      if (category) {
        const categories = Array.isArray(f.category) ? f.category : f.category ? [f.category] : [];
        if (!categories.some((c) => c.toLowerCase() === category.toLowerCase())) return false;
      }
      return true;
    });
  }

  private async formatListMessage(direction = "to", category?: string): Promise<string> {
    const formats = await this.fetchFormats(direction, category);
    const lines = formats
      .slice(0, 80)
      .map((f) => `\`${f.format || f.extension || "?"}\` - ${f.name || f.mime || "format"}`);
    const suffix = formats.length > lines.length ? `\n...and ${formats.length - lines.length} more.` : "";
    return `Formats (${direction}${category ? `, ${category}` : ""}): ${formats.length}\n${lines.join("\n") || "No formats matched."}${suffix}`;
  }

  private async uploadFile(channelId: string, bytes: Uint8Array, contentType: string, fileName: string, content: string): Promise<void> {
    const form = new FormData();
    form.set("payload_json", JSON.stringify({ content }));
    form.set("files[0]", new Blob([Buffer.from(bytes)], { type: contentType }), apiFileName(fileName));
    await this.requestMultipart(`/channels/${channelId}/messages`, form);
  }

  private async deleteRawUploadMessage(message: DiscordMessage): Promise<void> {
    await this.request(`/channels/${message.channel_id}/messages/${message.id}`, { method: "DELETE" });
  }

  private async sendChannelMessagePayload(channelId: string, payload: unknown): Promise<void> {
    await this.request(`/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify(payload) });
  }

  private async respond(interaction: DiscordInteraction, data: unknown): Promise<void> {
    await this.request(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({ type: 4, data }),
    });
  }

  private async respondDeferred(interaction: DiscordInteraction, ephemeral = false): Promise<void> {
    await this.request(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({ type: 5, data: ephemeral ? { flags: 64 } : undefined }),
    });
  }

  private async respondDeferredUpdate(interaction: DiscordInteraction): Promise<void> {
    await this.request(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({ type: 6 }),
    });
  }

  private async respondModal(interaction: DiscordInteraction, data: unknown): Promise<void> {
    await this.request(`/interactions/${interaction.id}/${interaction.token}/callback`, {
      method: "POST",
      body: JSON.stringify({ type: 9, data }),
    });
  }

  private async respondOrEdit(interaction: DiscordInteraction, data: unknown): Promise<void> {
    try {
      await this.respond(interaction, data);
    } catch {
      await this.editOriginal(interaction, data);
    }
  }

  private async editOriginal(interaction: DiscordInteraction, data: unknown): Promise<void> {
    await this.request(`/webhooks/${this.applicationId}/${interaction.token}/messages/@original`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  }

  private async registerCommands(): Promise<void> {
    if (!this.applicationId) throw new Error("Discord application id is not available");
    const commands = [
      {
        name: "convert",
        description: "Upload a file and choose the output format with a simple UI.",
        options: [{ type: 11, name: "file", description: "File to convert", required: false }],
      },
      {
        name: "formats",
        description: "List conversion formats this API currently reports.",
        options: [
          {
            type: 3,
            name: "direction",
            description: "Show input or output formats",
            required: false,
            choices: [
              { name: "to", value: "to" },
              { name: "from", value: "from" },
            ],
          },
          { type: 3, name: "category", description: "Optional category filter", required: false },
        ],
      },
      {
        name: "screenshot",
        description: "Capture a website as an image or PDF.",
        options: [
          { type: 3, name: "url", description: "Website URL", required: true },
          {
            type: 3,
            name: "format",
            description: "Output format",
            required: false,
            choices: ["png", "jpeg", "webp", "pdf"].map((value) => ({ name: value, value })),
          },
          { type: 5, name: "full_page", description: "Capture the full page", required: false },
        ],
      },
      {
        name: "download",
        description: "Download YouTube or media URLs as audio/video.",
        options: [
          { type: 3, name: "url", description: "Media URL", required: true },
          { type: 3, name: "format", description: "yt-dlp format selector", required: false },
          { type: 3, name: "quality", description: "Optional quality selector", required: false },
        ],
      },
      {
        name: "ocr",
        description: "Extract text from an uploaded image/PDF or URL.",
        options: [
          { type: 11, name: "file", description: "Image or PDF", required: false },
          { type: 3, name: "url", description: "Image or PDF URL", required: false },
          {
            type: 3,
            name: "mode",
            description: "OCR output mode",
            required: false,
            choices: ["txt", "pdf", "hocr", "tsv"].map((value) => ({ name: value, value })),
          },
          { type: 3, name: "lang", description: "Tesseract language code", required: false },
        ],
      },
      {
        name: "transcribe",
        description: "Transcribe uploaded audio/video or a media URL.",
        options: [
          { type: 11, name: "file", description: "Audio or video file", required: false },
          { type: 3, name: "url", description: "Audio/video URL", required: false },
          { type: 3, name: "language", description: "Optional language hint", required: false },
          { type: 5, name: "summarize", description: "Also summarize the transcript", required: false },
        ],
      },
    ];
    const signature = JSON.stringify(commands);
    if (signature === this.commandVersion) return;
    const path = this.commandGuildId
      ? `/applications/${this.applicationId}/guilds/${this.commandGuildId}/commands`
      : `/applications/${this.applicationId}/commands`;
    await this.request(path, { method: "PUT", body: signature });
    this.commandVersion = signature;
    log.info(`Discord slash commands registered (${this.commandGuildId ? "guild" : "global"})`);
  }

  private queueAudit(event: Omit<AuditEvent, "at">): void {
    this.auditQueue.push({ ...event, at: Date.now() });
  }

  private async flushAudit(): Promise<void> {
    if (!this.auditQueue.length || (!this.auditChannelIds.length && !this.auditWebhookUrls.length)) return;
    const events = this.auditQueue.splice(0);
    const chunks = this.auditChunks(events);
    for (const content of chunks) {
      for (const channelId of this.auditChannelIds) {
        await this.request(`/channels/${channelId}/messages`, {
          method: "POST",
          body: JSON.stringify({ content }),
        }).catch((e) => log.warn("Discord audit channel flush failed:", e));
      }
      for (const webhookUrl of this.auditWebhookUrls) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
        }).catch((e) => log.warn("Discord audit webhook flush failed:", e));
      }
    }
  }

  private auditChunks(events: AuditEvent[]): string[] {
    const out: string[] = [];
    let cur = "";
    for (const event of events) {
      const line = `[${new Date(event.at).toISOString()}] ${event.type}: ${event.message}`;
      if (cur && cur.length + line.length + 1 > 1900) {
        out.push(cur);
        cur = "";
      }
      cur += `${cur ? "\n" : ""}${line}`;
    }
    if (cur) out.push(cur);
    return out;
  }

  private describeAuditEvent(type: string, data: Record<string, unknown>): string {
    const channel = data.channel_id ? ` in <#${String(data.channel_id)}>` : "";
    const user = displayUser((data.user || data.member || data.author) as DiscordUser);
    if (type.startsWith("MESSAGE_REACTION")) return `${type.replaceAll("_", " ").toLowerCase()}${channel} by ${user}.`;
    if (type.startsWith("GUILD_BAN")) return `${type.replaceAll("_", " ").toLowerCase()} for ${user}.`;
    if (type.startsWith("THREAD")) return `${type.replaceAll("_", " ").toLowerCase()}: ${String(data.name || data.id || "")}.`;
    return `${type.replaceAll("_", " ").toLowerCase()}${channel}.`;
  }

  private apiUrl(pathOrUrl: string): URL {
    try {
      return new URL(pathOrUrl);
    } catch {
      return new URL(pathOrUrl, this.apiBaseUrl);
    }
  }

  private apiHeaders(): Record<string, string> {
    return this.apiKey ? { "x-api-key": this.apiKey } : {};
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bot ${this.token}`);
    if (!(init.body instanceof FormData)) headers.set("content-type", "application/json");
    const res = await fetch(`${DISCORD_API}${path}`, { ...init, headers });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) throw new Error(`Discord API ${init.method || "GET"} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private async requestMultipart<T = unknown>(path: string, form: FormData): Promise<T> {
    return this.request<T>(path, { method: "POST", body: form });
  }

  private fileNameFromDisposition(header: string | null): string | undefined {
    if (!header) return undefined;
    const utf = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (utf) return decodeURIComponent(utf[1]);
    const basic = /filename="?([^";]+)"?/i.exec(header);
    return basic?.[1];
  }
}

export const discordBot = new DiscordBot();
