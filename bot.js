require("dotenv").config();

const express = require("express");
const cron = require("node-cron");
const admin = require("firebase-admin");
const {
  Client, GatewayIntentBits, Partials, Events, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require("discord.js");

const required = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "OWNER_UID",
  "FIREBASE_DATABASE_URL", "FIREBASE_SERVICE_ACCOUNT_JSON"];
for (const key of required) {
  if (!process.env[key]) console.error(`[CONFIG] Falta la variable: ${key}`);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "{}");
} catch {
  console.error("[FIREBASE] FIREBASE_SERVICE_ACCOUNT_JSON no es JSON válido.");
  process.exit(1);
}
if (!serviceAccount.project_id) {
  console.error("[FIREBASE] Falta project_id en las credenciales.");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();
const configsPath = `users/${process.env.OWNER_UID}/guilds/${process.env.GUILD_ID}/config`;
let config = { modules: {} };
let lastScheduledKeys = new Set();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

const commands = [
  new SlashCommandBuilder().setName("panel-tickets").setDescription("Publica el panel de tickets")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("ping").setDescription("Comprueba si el bot responde"),
  new SlashCommandBuilder().setName("limpiar").setDescription("Borra mensajes recientes")
    .addIntegerOption(o => o.setName("cantidad").setDescription("Entre 1 y 100").setMinValue(1).setMaxValue(100).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName("expulsar").setDescription("Expulsa a un miembro")
    .addUserOption(o => o.setName("usuario").setDescription("Miembro").setRequired(true))
    .addStringOption(o => o.setName("motivo").setDescription("Motivo").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  new SlashCommandBuilder().setName("banear").setDescription("Banea a un miembro")
    .addUserOption(o => o.setName("usuario").setDescription("Miembro").setRequired(true))
    .addStringOption(o => o.setName("motivo").setDescription("Motivo").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName("evento").setDescription("Publica un evento con asistencia")
    .addStringOption(o => o.setName("titulo").setDescription("Título del evento").setRequired(true).setMaxLength(100))
    .addStringOption(o => o.setName("fecha").setDescription("Fecha y hora ISO local: 2026-11-15 20:30").setRequired(true))
    .addStringOption(o => o.setName("descripcion").setDescription("Detalles del evento").setRequired(true).setMaxLength(1000))
    .addChannelOption(o => o.setName("canal").setDescription("Canal donde publicar").setRequired(true))
    .addRoleOption(o => o.setName("aviso").setDescription("Rol a mencionar").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageEvents)
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
  console.log("[DISCORD] Comandos slash registrados.");
}

// The web panel saves users/{UID}/configs/{welcome,tickets,moderation,activities,logs}.
function normalizeConfig(s) {
  const w = s.welcome || {}, t = s.tickets || {}, m = s.moderation || {};
  const a = s.activities || {}, l = s.logs || {};
  const welcomeChannelId = w.channel || w.channelId || w.welcomeChannelId || "";
  const activityChannelId = a.channel || a.channelId || a.activityChannelId || "";
  const activityMessage = a.message || a.activityMessage || "";
  return {
    modules: {
      welcome: w.enabled !== false && Boolean(welcomeChannelId || w.welcomeMessage || w.welcomeText),
      tickets: t.enabled !== false && Boolean(t.channel || t.channelId || t.title || t.description),
      moderation: m.enabled === true || Boolean(m.antiSpam || m.antispam || m.linkFilter || m.blockLinks),
      activities: a.enabled !== false && Boolean(activityChannelId && activityMessage),
      logs: l.enabled !== false && Boolean(l.channel || l.channelId || l.enabled)
    },
    welcomeChannelId,
    goodbyeChannelId: w.goodbyeChannel || w.goodbyeChannelId || welcomeChannelId,
    welcomeMessage: w.welcomeMessage || w.welcomeText || w.message || "¡Bienvenido/a {usuario} a {servidor}!",
    goodbyeMessage: w.goodbyeMessage || w.goodbyeText || "{usuario} ha salido del servidor.",
    ticketTitle: t.title || "CENTRO DE SOPORTE",
    ticketDescription: t.description || "Pulsa el botón para abrir un ticket privado.",
    ticketOpenMessage: t.openMessage || t.message || "Describe tu consulta con el mayor detalle posible.",
    ticketCategoryId: t.categoryId || t.ticketCategoryId || "",
    supportRoleId: t.supportRoleId || t.roleId || "",
    embedColor: t.embedColor || w.embedColor || "#C1121F",
    blockLinks: Boolean(m.linkFilter || m.blockLinks),
    spamLimit: Number(m.spamLimit || m.limit || 5),
    activityChannelId,
    activityTime1: a.time1 || a.activityTime1 || "14:00",
    activityTime2: a.time2 || a.activityTime2 || "21:00",
    activityMessage,
    activityRoleId: a.roleId || a.activityRoleId || "",
    timezone: a.timezone || "America/Santiago",
    logsChannelId: l.channel || l.channelId || l.logsChannelId || ""
  };
}

function interpolate(text, member) {
  return String(text || "").replaceAll("{usuario}", `<@${member.id}>`)
    .replaceAll("{servidor}", member.guild.name)
    .replaceAll("{miembros}", String(member.guild.memberCount));
}
async function sendConfigured(channelId, text, member = null) {
  if (!channelId || !text) return;
  const channel = await client.channels.fetch(String(channelId)).catch(() => null);
  if (!channel?.isTextBased()) {
    console.warn(`[SEND] Canal de texto no encontrado: ${channelId}`);
    return;
  }
  await channel.send({ content: member ? interpolate(text, member) : String(text) })
    .catch(e => console.error("[SEND] Error enviando mensaje:", e.message));
}
async function sendLog(text) {
  if (config.modules?.logs && config.logsChannelId) await sendConfigured(config.logsChannelId, text);
}
async function publishTicketPanel(interaction) {
  const embed = new EmbedBuilder().setColor(config.embedColor || "#C1121F")
    .setTitle(config.ticketTitle || "CENTRO DE SOPORTE")
    .setDescription(config.ticketDescription || "Pulsa el botón para abrir un ticket privado.")
    .setFooter({ text: "STREET CONTROL" });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("sc_ticket_open").setLabel("Abrir ticket").setEmoji("🎫").setStyle(ButtonStyle.Danger)
  );
  await interaction.channel.send({ embeds: [embed], components: [row] });
  await interaction.reply({ content: "Panel de tickets publicado.", ephemeral: true });
}

client.once(Events.ClientReady, async ready => {
  console.log(`[DISCORD] Bot conectado como ${ready.user.tag}`);
  try { await registerCommands(); }
  catch (e) { console.error("[DISCORD] Error registrando comandos:", e.message); }

  db.ref(configsPath).on("value", snap => {
    config = normalizeConfig(snap.val() || {});
    console.log("[FIREBASE] Configuración recargada desde Firebase.");
  }, e => console.error("[FIREBASE] Error leyendo configuración:", e.message));
});

client.on(Events.GuildMemberAdd, async member => {
  if (config.modules?.welcome) await sendConfigured(config.welcomeChannelId, config.welcomeMessage, member);
  await sendLog(`📥 Entrada: ${member.user.tag} (${member.id})`);
});
client.on(Events.GuildMemberRemove, async member => {
  if (config.modules?.welcome) await sendConfigured(config.goodbyeChannelId, config.goodbyeMessage, member);
  await sendLog(`📤 Salida: ${member.user?.tag || member.id}`);
});

const spam = new Map();
client.on(Events.MessageCreate, async message => {
  if (!message.guild || message.author.bot || !config.modules?.moderation) return;
  if (message.member?.permissions.has(PermissionFlagsBits.ManageMessages)) return;

  const now = Date.now(), old = spam.get(message.author.id) || [];
  const recent = old.filter(t => now - t < 6000);
  recent.push(now);
  spam.set(message.author.id, recent);

  if (recent.length >= Math.max(2, config.spamLimit || 5) && message.member?.moderatable) {
    await message.member.timeout(60000, "Antispam automático").catch(e => console.error("[MOD]", e.message));
    await message.channel.send(`⚠️ ${message.author}, se detectó spam; pausa de 60 segundos.`).catch(() => {});
    await sendLog(`⚠️ Antispam: ${message.author.tag} recibió timeout de 60 segundos.`);
    spam.set(message.author.id, []);
    return;
  }
  if (config.blockLinks && /(https?:\/\/|discord\.gg\/)/i.test(message.content)) {
    await message.delete().catch(() => {});
    await message.channel.send(`${message.author}, no puedes publicar enlaces aquí.`)
      .then(msg => setTimeout(() => msg.delete().catch(() => {}), 5000)).catch(() => {});
  }
});
client.on(Events.MessageDelete, async message => {
  if (message.guild && !message.author?.bot)
    await sendLog(`🗑️ Mensaje eliminado en <#${message.channelId}>${message.author ? ` por ${message.author.tag}` : ""}.`);
});

async function publishEvent(interaction) {
  const title = interaction.options.getString("titulo", true);
  const rawDate = interaction.options.getString("fecha", true);
  const description = interaction.options.getString("descripcion", true);
  const channel = interaction.options.getChannel("canal", true);
  const role = interaction.options.getRole("aviso");
  // Interpret the supplied date in Chile local time. ISO offset avoids server timezone ambiguity.
  const match = rawDate.match(/^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2})$/);
  if (!match) return interaction.reply({ content: "Usa el formato AAAA-MM-DD HH:mm, por ejemplo 2026-11-15 20:30.", ephemeral: true });
  const [, y, mo, d, h, mi] = match;
  const localDate = new Date(`${y}-${mo}-${d}T${h}:${mi}:00-03:00`);
  if (Number.isNaN(localDate.getTime()) || localDate.getTime() < Date.now() + 60000)
    return interaction.reply({ content: "La fecha debe ser futura y válida.", ephemeral: true });
  if (!channel.isTextBased()) return interaction.reply({ content: "Elige un canal de texto.", ephemeral: true });
  const eventId = `${Date.now()}-${interaction.user.id}`;
  const embed = new EmbedBuilder().setColor(config.embedColor || "#C1121F")
    .setTitle(`📅 ${title}`).setDescription(description)
    .addFields(
      { name: "🕒 Fecha y hora (Chile)", value: `${rawDate} (America/Santiago)`, inline: true },
      { name: "👥 Asistencia", value: "Pulsa **Voy** o **No puedo** para responder.", inline: true }
    ).setFooter({ text: `STREET CONTROL · Evento ${eventId}` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sc_event_yes:${eventId}`).setLabel("Voy").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sc_event_no:${eventId}`).setLabel("No puedo").setEmoji("❌").setStyle(ButtonStyle.Secondary)
  );
  await db.ref(`${configsPath}/events/${eventId}`).set({
    id: eventId, title, description, dateISO: localDate.toISOString(), dateLocal: rawDate,
    channelId: channel.id, guildId: interaction.guildId, roleId: role?.id || "",
    createdBy: interaction.user.id, published: false, reminderSent: false, createdAt: Date.now()
  });
  const msg = await channel.send({ content: role ? `<@&${role.id}>` : undefined, embeds: [embed], components: [row], allowedMentions: { roles: role ? [role.id] : [] } });
  await db.ref(`${configsPath}/events/${eventId}/messageId`).set(msg.id);
  await db.ref(`${configsPath}/events/${eventId}/published`).set(true);
  return interaction.reply({ content: `Evento publicado en ${channel}. Los miembros pueden confirmar asistencia con los botones.`, ephemeral: true });
}

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "ping")
        return interaction.reply({ content: `Pong! ${client.ws.ping} ms`, ephemeral: true });
      if (interaction.commandName === "panel-tickets") {
        if (!config.modules?.tickets)
          return interaction.reply({ content: "Tickets desactivados o sin configuración en Firebase.", ephemeral: true });
        return publishTicketPanel(interaction);
      }
      if (interaction.commandName === "limpiar") {
        const n = interaction.options.getInteger("cantidad", true);
        const deleted = await interaction.channel.bulkDelete(n, true);
        return interaction.reply({ content: `Se borraron ${deleted.size} mensajes.`, ephemeral: true });
      }
      if (interaction.commandName === "expulsar") {
        const user = interaction.options.getUser("usuario", true);
        const reason = interaction.options.getString("motivo") || "Sin motivo indicado";
        await interaction.guild.members.kick(user.id, reason);
        await interaction.reply({ content: `Se expulsó a ${user.tag}.`, ephemeral: true });
        await sendLog(`👢 ${user.tag} expulsado. Motivo: ${reason}`);
        return;
      }
      if (interaction.commandName === "banear") {
        const user = interaction.options.getUser("usuario", true);
        const reason = interaction.options.getString("motivo") || "Sin motivo indicado";
        await interaction.guild.members.ban(user.id, { reason });
        await interaction.reply({ content: `Se baneó a ${user.tag}.`, ephemeral: true });
        await sendLog(`🔨 ${user.tag} baneado. Motivo: ${reason}`);
        return;
      }
      if (interaction.commandName === "evento") return publishEvent(interaction);
    }

    if (interaction.isButton() && (interaction.customId.startsWith("sc_event_yes:") || interaction.customId.startsWith("sc_event_no:"))) {
      const [action, eventId] = interaction.customId.split(":");
      const eventRef = db.ref(`${configsPath}/events/${eventId}`);
      const snap = await eventRef.once("value");
      if (!snap.exists()) return interaction.reply({ content: "Este evento ya no está disponible.", ephemeral: true });
      const attending = action === "sc_event_yes";
      await eventRef.child(`responses/${interaction.user.id}`).set({
        attending, userTag: interaction.user.tag, updatedAt: Date.now()
      });
      const counts = await eventRef.child("responses").once("value");
      let yes = 0, no = 0;
      counts.forEach(child => child.val()?.attending ? yes++ : no++);
      return interaction.reply({ content: attending ? `✅ Has confirmado asistencia. Confirmados: ${yes} · No asistirán: ${no}.` : `❌ Has indicado que no asistirás. Confirmados: ${yes} · No asistirán: ${no}.`, ephemeral: true });
    }

    if (interaction.isButton() && interaction.customId === "sc_ticket_open") {
      if (!config.modules?.tickets)
        return interaction.reply({ content: "Tickets desactivados.", ephemeral: true });
      const name = `ticket-${interaction.user.id}`.slice(0, 90);
      const existing = interaction.guild.channels.cache.find(c => c.name === name);
      if (existing) return interaction.reply({ content: `Ya tienes un ticket abierto: ${existing}`, ephemeral: true });

      const overwrites = [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles] }
      ];
      if (config.supportRoleId) overwrites.push({
        id: config.supportRoleId,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
      });

      const opts = { name, type: ChannelType.GuildText, permissionOverwrites: overwrites,
        topic: `Ticket abierto por ${interaction.user.tag} (${interaction.user.id})` };
      if (config.ticketCategoryId) opts.parent = config.ticketCategoryId;
      const channel = await interaction.guild.channels.create(opts);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("sc_ticket_close").setLabel("Cerrar ticket").setStyle(ButtonStyle.Secondary)
      );
      await channel.send({
        content: `${interaction.user} ${config.supportRoleId ? `<@&${config.supportRoleId}>` : ""}\n${config.ticketOpenMessage}`,
        components: [row]
      });
      await interaction.reply({ content: `Ticket creado: ${channel}`, ephemeral: true });
      await sendLog(`🎫 Ticket abierto por ${interaction.user.tag}: ${channel}`);
      return;
    }
    if (interaction.isButton() && interaction.customId === "sc_ticket_close") {
      await interaction.reply({ content: "Este ticket se cerrará en 5 segundos.", ephemeral: true });
      const channel = interaction.channel;
      await sendLog(`🎫 Ticket cerrado por ${interaction.user.tag}: ${channel.name}`);
      setTimeout(() => channel.delete("Ticket cerrado").catch(() => {}), 5000);
    }
  } catch (e) {
    console.error("[INTERACTION] Error:", e);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred)
      await interaction.reply({ content: "Ocurrió un error. Revisa permisos y Logs de Render.", ephemeral: true }).catch(() => {});
  }
});

// Recordatorio de eventos: se ejecuta cada minuto y marca el recordatorio en Firebase para evitar duplicados.
cron.schedule("* * * * *", async () => {
  try {
    const snap = await db.ref(`${configsPath}/events`).once("value");
    const events = snap.val() || {};
    for (const [id, ev] of Object.entries(events)) {
      if (ev.needsPublish && !ev.published && ev.dateLocal && ev.channelId && ev.title && ev.description) {
        const match = String(ev.dateLocal).match(/^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2})$/);
        if (!match) { console.warn("[EVENTS] Fecha inválida en evento", id); continue; }
        const [, yy, mm, dd, hh, min] = match;
        const starts = new Date(`${yy}-${mm}-${dd}T${hh}:${min}:00-03:00`);
        if (Number.isNaN(starts.getTime()) || starts.getTime() <= Date.now()) {
          await db.ref(`${configsPath}/events/${id}/needsPublish`).set(false);
          await db.ref(`${configsPath}/events/${id}/publishError`).set("La fecha ya pasó o no es válida.");
          continue;
        }
        const channel = await client.channels.fetch(String(ev.channelId)).catch(() => null);
        if (!channel?.isTextBased()) continue;
        const embed = new EmbedBuilder().setColor(config.embedColor || "#C1121F").setTitle(`📅 ${ev.title}`)
          .setDescription(ev.description)
          .addFields({ name: "🕒 Fecha y hora (Chile)", value: `${ev.dateLocal} (America/Santiago)`, inline: true },
                     { name: "👥 Asistencia", value: "Pulsa **Voy** o **No puedo** para responder.", inline: true })
          .setFooter({ text: `STREET CONTROL · Evento ${id}` });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`sc_event_yes:${id}`).setLabel("Voy").setEmoji("✅").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`sc_event_no:${id}`).setLabel("No puedo").setEmoji("❌").setStyle(ButtonStyle.Secondary)
        );
        const roleText = ev.roleId ? `<@&${ev.roleId}>` : undefined;
        const msg = await channel.send({ content: roleText, embeds: [embed], components: [row],
          allowedMentions: { roles: ev.roleId ? [ev.roleId] : [] } }).catch(e => { console.error("[EVENTS] Publicación fallida:", e.message); return null; });
        if (msg) await db.ref(`${configsPath}/events/${id}`).update({ published: true, needsPublish: false, messageId: msg.id, dateISO: starts.toISOString() });
        continue;
      }
      if (!ev.published || ev.reminderSent || !ev.dateISO || !ev.channelId) continue;
      const startsAt = new Date(ev.dateISO).getTime();
      const delta = startsAt - Date.now();
      // Aviso 15 minutos antes; si el bot estuvo desconectado, no envía avisos atrasados.
      if (delta > 0 && delta <= 15 * 60 * 1000) {
        const channel = await client.channels.fetch(String(ev.channelId)).catch(() => null);
        if (channel?.isTextBased()) {
          const roleText = ev.roleId ? `<@&${ev.roleId}> ` : "";
          await channel.send({ content: `${roleText}⏰ **Recordatorio:** el evento **${ev.title}** comienza en unos 15 minutos.`, allowedMentions: { roles: ev.roleId ? [ev.roleId] : [] } });
          await db.ref(`${configsPath}/events/${id}/reminderSent`).set(true);
        }
      }
    }
  } catch (e) { console.error("[EVENTS] Error revisando recordatorios:", e.message); }
}, { timezone: "UTC" });

cron.schedule("* * * * *", async () => {
  if (!config.modules?.activities || !config.activityChannelId || !config.activityMessage) return;
  const tz = config.timezone || "America/Santiago";
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
    const timeNow = `${p.find(x => x.type === "hour").value}:${p.find(x => x.type === "minute").value}`;
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const date = `${d.find(x => x.type === "year").value}-${d.find(x => x.type === "month").value}-${d.find(x => x.type === "day").value}`;
    for (const time of [config.activityTime1 || "14:00", config.activityTime2 || "21:00"]) {
      const key = `${date}-${time}`;
      if (timeNow === time && !lastScheduledKeys.has(key)) {
        lastScheduledKeys.add(key);
        await sendConfigured(config.activityChannelId,
          `${config.activityRoleId ? `<@&${config.activityRoleId}> ` : ""}${config.activityMessage}`);
      }
    }
    if (lastScheduledKeys.size > 10) lastScheduledKeys = new Set([...lastScheduledKeys].slice(-4));
  } catch (e) {
    console.error("[ACTIVITIES] Error con zona horaria:", e.message);
  }
}, { timezone: "UTC" });

const app = express();
app.get("/", (_req, res) => res.status(200).send("STREET CONTROL está ejecutándose."));
app.get("/health", (_req, res) => res.json({
  ok: true, botReady: client.isReady(), bot: client.user?.tag || null
}));
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`[WEB] Health server escuchando en puerto ${port}.`));

client.login(process.env.DISCORD_TOKEN).catch(error => {
  console.error("[DISCORD] No se pudo iniciar sesión. Revisa DISCORD_TOKEN en Render.");
  console.error(error.message);
  process.exit(1);
});
