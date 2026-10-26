import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  Partials,
  AttachmentBuilder
} from "discord.js";

import { existsSync, readFileSync, writeFileSync } from "fs";

// ---------------- ENV ----------------
const TOKEN = process.env.DISCORD_TOKEN!;
if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env");
  process.exit(1);
}

const GUILD_ID = process.env.GUILD_ID!;
if (!GUILD_ID) {
  console.error("Missing GUILD_ID in .env");
  process.exit(1);
}

// ---------------- DATABASE ----------------
const DB_PATH = "./db.json";

function ensureDB() {
  if (!existsSync(DB_PATH)) {
    console.log("Creating database...");
    writeFileSync(DB_PATH, JSON.stringify({ servers: [] }, null, 2));
  }
}

function getDB() {
  ensureDB();
  return JSON.parse(readFileSync(DB_PATH, "utf8"));
}

function saveDB(db: any) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---------------- DISCORD CLIENT ----------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  // DM channels aren't cached, so this is needed to receive DM messageCreate events
  partials: [Partials.Channel]
});

function isAdmin(interaction: any) {
  return interaction.memberPermissions?.has("Administrator");
}

// ---------------- DOMAIN WATCH ----------------
const CONFIG_PATH = "./config.json";

function loadConfig() {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const dw = config.domainWatch ?? {};
  return {
    notifyUserId: String(dw.notifyUserId ?? ""),
    // WHOIS_PATH in .env overrides for dev (e.g. C:\tools\whois\whois.exe)
    whoisPath: process.env.WHOIS_PATH || dw.whoisPath || "whois",
    checkIntervalHours: Number(dw.checkIntervalHours ?? 12),
    alertDays: ((dw.alertDays ?? [30, 7, 1]) as number[]).slice().sort((a, b) => a - b),
    domains: ((dw.domains ?? []) as string[]).map(d => d.trim().toLowerCase()).filter(Boolean)
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WHOIS_TIMEOUT_MS = 30_000;

async function runWhois(whoisPath: string, domain: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([whoisPath, "-accepteula", "-nobanner", domain], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: WHOIS_TIMEOUT_MS
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text()
    ]);
    await proc.exited;
    const text = (out + "\n" + err).trim();
    return text || null;
  } catch (e: any) {
    if (e?.code === "ENOENT")
      console.error(`whois failed for ${domain}: "${whoisPath}" not found. Set WHOIS_PATH or domainWatch.whoisPath to the full path of whois.exe.`);
    else
      console.error(`whois failed for ${domain}:`, e);
    return null;
  }
}

const AVAILABLE_RE = /No whois information found|No match for|NOT FOUND|No Data Found|is available|Status:\s*free|No entries found/i;

function findField(raw: string, labels: string[]): string | null {
  for (const label of labels) {
    const m = raw.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im"));
    if (m && m[1]!.trim()) return m[1]!.trim();
  }
  return null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function parseWhois(raw: string) {
  const statuses = [...raw.matchAll(/^\s*(?:Domain )?Status\s*:\s*(\S+)/gim)].map(m => m[1]!);
  return {
    available: AVAILABLE_RE.test(raw) && !/Creation Date|Expir/i.test(raw),
    expiry: parseDate(findField(raw, [
      "Registry Expiry Date",
      "Registrar Registration Expiration Date",
      "Expiration Date",
      "Expiry Date",
      "Expiry date",
      "paid-till",
      "Expires On",
      "expires"
    ])),
    created: parseDate(findField(raw, ["Creation Date", "Created On", "Registered On", "created"])),
    updated: parseDate(findField(raw, ["Updated Date", "Last Updated On", "Last Modified", "changed"])),
    registrar: findField(raw, ["Registrar", "Sponsoring Registrar"]),
    statuses: [...new Set(statuses)]
  };
}

type WhoisInfo = ReturnType<typeof parseWhois>;

// Higher rank = more urgent. Expiry thresholds rank by how few days are left.
function alertRank(key: string | null): number {
  if (!key) return 0;
  const fixed: Record<string, number> = {
    expired: 10_000,
    redemptionPeriod: 10_001,
    pendingDelete: 10_002,
    available: 10_003
  };
  if (key in fixed) return fixed[key]!;
  return 1_000 - Number(key.slice(1)); // d30 < d7 < d1
}

function getAlert(info: WhoisInfo, alertDays: number[]): { key: string; reason: string } | null {
  if (info.available)
    return { key: "available", reason: "Domain is AVAILABLE to purchase" };

  const statuses = info.statuses.map(s => s.toLowerCase());
  if (statuses.some(s => s.includes("pendingdelete")))
    return { key: "pendingDelete", reason: "Domain is pending delete (drops within ~5 days)" };
  if (statuses.some(s => s.includes("redemptionperiod")))
    return { key: "redemptionPeriod", reason: "Domain is in redemption period" };

  if (!info.expiry) return null;
  const daysLeft = (info.expiry.getTime() - Date.now()) / DAY_MS;
  if (daysLeft <= 0)
    return { key: "expired", reason: "Domain has expired" };

  const threshold = alertDays.find(d => daysLeft <= d);
  if (threshold !== undefined)
    return { key: `d${threshold}`, reason: `Domain expires within ${threshold} day${threshold === 1 ? "" : "s"}` };

  return null;
}

function ts(d: Date | null) {
  if (!d) return "Unknown";
  const unix = Math.floor(d.getTime() / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function whoisExcerpt(raw: string) {
  const lines = raw
    .split(/\r?\n/)
    .filter(l => /^\s*[\w.-]{3,}(?: [\w./-]+){0,4}:\s*\S/.test(l) && !/^\s*(Connecting|NOTICE|TERMS|URL of the ICANN)/i.test(l));
  let out = "";
  for (const l of lines) {
    if (out.length + l.length + 1 > 990) break;
    out += l.trim() + "\n";
  }
  return out || raw.slice(0, 990);
}

function buildDomainEmbed(domain: string, info: WhoisInfo, raw: string, alert: { key: string; reason: string }) {
  const urgent = !alert.key.startsWith("d") || Number(alert.key.slice(1)) <= 7;

  const embed = new EmbedBuilder()
    .setColor(urgent ? 0xE53935 : 0xFB8C00)
    .setTitle(`${domain}: ${alert.reason}`)
    .setTimestamp(new Date());

  if (info.available) {
    embed.setDescription("No whois record found. The domain looks available to register.");
  } else {
    const daysLeft = info.expiry ? Math.floor((info.expiry.getTime() - Date.now()) / DAY_MS) : null;
    embed.addFields(
      { name: "Registrar", value: info.registrar || "Unknown", inline: true },
      { name: "Days Left", value: daysLeft === null ? "Unknown" : String(daysLeft), inline: true },
      { name: "Status", value: info.statuses.join("\n").slice(0, 1024) || "Unknown", inline: false },
      { name: "Created", value: ts(info.created), inline: false },
      { name: "Updated", value: ts(info.updated), inline: false },
      { name: "Expires", value: ts(info.expiry), inline: false }
    );
  }

  embed.addFields({ name: "Whois", value: "```\n" + whoisExcerpt(raw) + "```", inline: false });
  return embed;
}

function domainSummaryLine(domain: string, info: WhoisInfo | null) {
  if (!info) return `**${domain}**: whois lookup failed`;
  if (info.available) return `**${domain}**: AVAILABLE`;
  const exp = info.expiry ? `expires <t:${Math.floor(info.expiry.getTime() / 1000)}:R>` : "expiry unknown";
  return `**${domain}**: ${exp}, ${info.statuses.slice(0, 3).join(", ") || "no status"}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

// Checks run one at a time; a check requested while another runs waits for it to finish
let domainCheckQueue: Promise<unknown> = Promise.resolve();

function whoisAttachment(domain: string, raw: string) {
  return new AttachmentBuilder(Buffer.from(raw, "utf8"), { name: `${domain}-whois.txt` });
}

type DomainCheckResult = { summary: string[]; files: AttachmentBuilder[] };

function checkDomains(opts: { force?: boolean } = {}): Promise<DomainCheckResult> {
  const run = domainCheckQueue.then(() => runDomainCheck(opts));
  domainCheckQueue = run.catch(() => {});
  return run;
}

async function runDomainCheck(opts: { force?: boolean }) {
  const config = loadConfig();
  const summary: string[] = [];
  const files: AttachmentBuilder[] = [];
  console.log(`Domain check started (${config.domains.length} domain(s), whois: ${config.whoisPath})`);

  try {
    const user = await withTimeout(client.users.fetch(config.notifyUserId), 30_000, "Fetching notify user");
    const db = getDB();
    db.domainWatch ??= {};

    for (const domain of config.domains) {
      console.log(`Checking ${domain}...`);
      const raw = await runWhois(config.whoisPath, domain);
      const info = raw ? parseWhois(raw) : null;
      summary.push(domainSummaryLine(domain, info));
      if (raw) files.push(whoisAttachment(domain, raw));

      if (raw && info) {
        const state = db.domainWatch[domain] ?? { lastAlertKey: null, lastExpiry: null };
        const expiryIso = info.expiry?.toISOString() ?? null;

        // Renewed or re-registered: start alerting from scratch
        if (!info.available && expiryIso && expiryIso !== state.lastExpiry) {
          if (state.lastExpiry && new Date(expiryIso) > new Date(state.lastExpiry)) state.lastAlertKey = null;
          state.lastExpiry = expiryIso;
        }
        if (!info.available && state.lastAlertKey === "available") state.lastAlertKey = null;

        const alert = getAlert(info, config.alertDays);
        const isNew = alert !== null && alertRank(alert.key) > alertRank(state.lastAlertKey);
        if (alert && (opts.force || isNew)) {
          try {
            await withTimeout(user.send({ embeds: [buildDomainEmbed(domain, info, raw, alert)], files: [whoisAttachment(domain, raw)] }), 30_000, `DM for ${domain}`);
            console.log(`Sent ${alert.key} alert for ${domain}`);
            if (isNew) state.lastAlertKey = alert.key;
          } catch (e) {
            console.error(`Failed to DM alert for ${domain}:`, e);
          }
        }

        db.domainWatch[domain] = state;
      }

      // be gentle with whois servers
      await new Promise(r => setTimeout(r, 2000));
    }

    saveDB(db);
  } catch (e) {
    console.error("Domain check failed:", e);
    summary.push("Domain check failed, see bot logs.");
  }

  console.log("Domain check finished");
  return { summary, files };
}

function startDomainWatch() {
  const { checkIntervalHours, domains } = loadConfig();
  console.log(`Watching ${domains.length} domain(s), checking every ${checkIntervalHours}h`);
  checkDomains();
  setInterval(() => checkDomains(), checkIntervalHours * 60 * 60 * 1000);
}

// ---------------- REGISTER COMMANDS ----------------
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName("ip")
      .setDescription("Show community game servers"),

    new SlashCommandBuilder()
    .setName("addserver")
    .setDescription("Add a new game server (Admin only)")
    .addStringOption(o =>
        o.setName("name")
        .setDescription("Unique server name")
        .setRequired(true))
    .addStringOption(o =>
        o.setName("ip")
        .setDescription("Server IP or address")
        .setRequired(true))
    .addStringOption(o =>
        o.setName("description")
        .setDescription("Server description")
        .setRequired(true))
    .addStringOption(o =>
        o.setName("image")
        .setDescription("Thumbnail image URL")
        .setRequired(true)),

    new SlashCommandBuilder()
      .setName("removeserver")
      .setDescription("Remove a game server (Admin only)")
      .addStringOption(o =>
        o.setName("name").setDescription("Server name").setRequired(true)),

    new SlashCommandBuilder()
    .setName("publish")
    .setDescription("Publish a single server embed to the channel")
    .addStringOption(o =>
        o.setName("name")
        .setDescription("Server name")
        .setRequired(true)
    )
  ];

    const rest = new REST({ version: "10" }).setToken(TOKEN);
    
    // 1) Delete existing guild commands (forces refresh)
    console.log("Clearing old commands...");
    await rest.put(
    Routes.applicationGuildCommands(client.user!.id, GUILD_ID),
    { body: [] }
    );

    // small delay so Discord fully clears cache
    await new Promise(r => setTimeout(r, 1500));

    // 2) Register new commands
    console.log("Registering new commands...");
    await rest.put(
    Routes.applicationGuildCommands(client.user!.id, GUILD_ID),
    { body: commands.map(c => c.toJSON()) }
    );

    console.log("Slash commands registered");

    startDomainWatch();
});

// ---------------- DM COMMANDS ----------------
// Plain text commands, only accepted in DMs from the configured user
client.on("messageCreate", async message => {
  if (message.guild || message.author.bot) return;
  if (message.author.id !== loadConfig().notifyUserId) return;

  if (message.content.trim().toLowerCase() === "!checkdomains") {
    console.log("!checkdomains requested");
    try {
      await message.reply("Checking domains...");
      const { summary, files } = await checkDomains({ force: true });
      // Discord allows at most 10 attachments per message
      await message.reply({
        content: summary.join("\n").slice(0, 2000) || "No domains configured.",
        files: files.slice(0, 10)
      });
      for (let i = 10; i < files.length; i += 10)
        await message.reply({ files: files.slice(i, i + 10) });
    } catch (e) {
      console.error("!checkdomains failed:", e);
    }
  }
});

// ---------------- COMMAND HANDLER ----------------
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const db = getDB();

    // -------- /ip --------
    if (interaction.commandName === "ip") {
    if (db.servers.length === 0) {
        return interaction.reply({
        content: "No servers have been added yet.",
        flags: MessageFlags.Ephemeral
        });
    }

    const embeds = db.servers.map((s:any) => {
        const embed = new EmbedBuilder()
        .setColor(0x00AEFF)
        .addFields({
            name: "Server",
            value: `${s.name}`,
            inline: true
        },{
            name: "IP Address",
            value: `${s.ip}`,
            inline: true
        }, {
            name: "Description",
            value: s.description || "No description provided.",
            inline: false
        });
        //.setDescription(s.description);

        if (s.image) embed.setThumbnail(s.image);

        return embed;
    });

    return interaction.reply({
        embeds,
        flags: MessageFlags.Ephemeral
    });
    }
  // -------- /addserver --------
    if (interaction.commandName === "addserver") {
    if (!isAdmin(interaction))
        return interaction.reply({ content: "Admin only command.", flags: MessageFlags.Ephemeral });

    const name = interaction.options.getString("name", true).trim();
    const ip = interaction.options.getString("ip", true).trim();
    const description = interaction.options.getString("description", true).trim();
    const image = interaction.options.getString("image", true).trim();

    if (db.servers.find((s:any) => s.name.toLowerCase() === name.toLowerCase()))
        return interaction.reply({ content: "Server already exists.", flags: MessageFlags.Ephemeral });

    db.servers.push({ name, ip, description, image });
    saveDB(db);

    return interaction.reply(`Server **${name}** added.`);
    }

  // -------- /removeserver --------
  if (interaction.commandName === "removeserver") {
    if (!isAdmin(interaction))
      return interaction.reply({ content: "Admin only command.", flags: MessageFlags.Ephemeral });

    const name = interaction.options.getString("name", true);

    const index = db.servers.findIndex((s: any) =>
      s.name.toLowerCase() === name.toLowerCase()
    );

    if (index === -1)
      return interaction.reply({ content: "Server not found.", flags: MessageFlags.Ephemeral });

    const removed = db.servers.splice(index, 1)[0];
    saveDB(db);

    return interaction.reply(`Removed server **${removed.name}**.`);
  }

    // -------- /publish --------
    if (interaction.commandName === "publish") {
    if (!isAdmin(interaction)) {
        return interaction.reply({
        content: "Admin only command.",
        flags: MessageFlags.Ephemeral
        });
    }

    const name = interaction.options.getString("name", true).trim();
    const db = getDB();

    const server = db.servers.find(
        (s: any) => s.name.toLowerCase() === name.toLowerCase()
    );

    if (!server) {
        return interaction.reply({
        content: "Server not found.",
        flags: MessageFlags.Ephemeral
        });
    }

    const embed = new EmbedBuilder()
        .setColor(0x00AEFF)
        .setTitle(server.name)
        .addFields(
        { name: "IP Address", value: server.ip, inline: true },
        { name: "Description", value: server.description || "No description", inline: false }
        );

    if (server.image) embed.setThumbnail(server.image);

    return interaction.reply({
        embeds: [embed] // NOT ephemeral → public message
    });
    }
});

// ---------------- LOGIN ----------------
client.login(TOKEN);