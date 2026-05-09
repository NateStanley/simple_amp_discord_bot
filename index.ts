import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { readFileSync, writeFileSync } from "fs";

// -------- Environment --------
const TOKEN = process.env.DISCORD_TOKEN!;
const PORT = Number(process.env.PORT ?? 3000);

if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN in .env file");
  process.exit(1);
}

// -------- Database helpers --------
function getDB() {
  return JSON.parse(readFileSync("./db.json", "utf8"));
}

function saveDB(db:any) {
  writeFileSync("./db.json", JSON.stringify(db, null, 2));
}

// -------- Discord Bot --------
const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", async () => {
  console.log("Bot ready");

  const command = new SlashCommandBuilder()
    .setName("ip")
    .setDescription("Show community game servers");

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(
    Routes.applicationCommands(client.user!.id),
    { body: [command.toJSON()] }
  );
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "ip") return;

  const db = getDB();

  const embed = new EmbedBuilder()
    .setTitle("🎮 Community Game Servers")
    .setColor(0x00AEFF);

  db.servers.forEach((s:any) => {
    embed.addFields({
      name: s.name,
      value: `IP: **${s.ip}**\n${s.description}`,
      inline: false
    });
  });

  await interaction.reply({ embeds: [embed] });
});

client.login(TOKEN);

// -------- Web Dashboard API --------
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // serve dashboard
    if (url.pathname === "/")
      return new Response(Bun.file("./public/index.html"));

    // get servers
    if (url.pathname === "/api/servers" && req.method === "GET") {
      return Response.json(getDB().servers);
    }

    // add server
    if (url.pathname === "/api/servers" && req.method === "POST") {
      const body = await req.json();
      const db = getDB();
      db.servers.push(body);
      saveDB(db);
      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  }
});

console.log(`Dashboard running on port ${PORT}`);