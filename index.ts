import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags
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
  intents: [GatewayIntentBits.Guilds]
});

function isAdmin(interaction: any) {
  return interaction.memberPermissions?.has("Administrator");
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