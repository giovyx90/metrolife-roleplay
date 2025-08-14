// metrodesk.cjs  — MetroCity Desk Bot (multi-tenant) + SQLite + transcript
// Avvio: node metrodesk.cjs
// ENV: DISCORD_TOKEN (obbligatorio), DB_PATH (opzionale; default: ../metrocity.db)

require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, ChannelType, PermissionFlagsBits,
  ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder,
  UserSelectMenuBuilder, AttachmentBuilder
} = require('discord.js');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ========== ENV & DB PATH ==========
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('❌ Manca DISCORD_TOKEN nel .env'); process.exit(1); }

function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  // Preferisci la cartella *padre* per condividere il DB tra più bot in sottocartelle
  const parent = path.resolve(process.cwd(), '..', 'metrocity.db');
  const here   = path.resolve(process.cwd(), 'metrocity.db');
  if (fs.existsSync(parent)) return parent;
  // Se non esiste, di default crea in cartella padre (condiviso)
  return parent;
}
const DB_PATH = resolveDbPath();

// ========== DB setup (WAL + timeout) ==========
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  category_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  staff_roles_json   TEXT NOT NULL DEFAULT '[]',
  manager_roles_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, name)
);

CREATE TABLE IF NOT EXISTS counters (
  guild_id TEXT NOT NULL,
  tenant   TEXT NOT NULL,
  day      TEXT NOT NULL,
  value    INTEGER NOT NULL,
  PRIMARY KEY (guild_id, tenant, day)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  tenant   TEXT NOT NULL,
  number   INTEGER NOT NULL,
  channel_id  TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  closed_at  TEXT,
  closed_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_open
  ON sessions (guild_id, tenant, number) WHERE closed_at IS NULL;
`);

const parseJSON = (s, fallback=[]) => { try { return JSON.parse(s); } catch { return fallback; } };
const toJSON = (v) => JSON.stringify(v || []);

// ========== Queries ==========
const qUpsertTenant = db.prepare(`
INSERT INTO tenants (guild_id, name, prefix, category_id, archive_id, staff_roles_json, manager_roles_json)
VALUES (@guild_id, @name, @prefix, @category_id, @archive_id, @staff_roles_json, @manager_roles_json)
ON CONFLICT(guild_id, name) DO UPDATE SET
  prefix=excluded.prefix,
  category_id=excluded.category_id,
  archive_id=excluded.archive_id,
  staff_roles_json=excluded.staff_roles_json,
  manager_roles_json=excluded.manager_roles_json,
  updated_at=datetime('now')
`);
const qGetTenants = db.prepare(`SELECT * FROM tenants WHERE guild_id = ? ORDER BY name`);
const qGetTenant  = db.prepare(`SELECT * FROM tenants WHERE guild_id = ? AND name = ?`);

const qNextNumber = db.prepare(`
INSERT INTO counters (guild_id, tenant, day, value)
VALUES (@guild_id, @tenant, @day, 1)
ON CONFLICT(guild_id, tenant, day) DO UPDATE SET value = value + 1
RETURNING value
`);

const txCreateSession = db.transaction((s) => {
  const day = new Date().toISOString().slice(0,10);
  const row = qNextNumber.get({ guild_id: s.guild_id, tenant: s.tenant, day });
  const number = row.value;
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO sessions (id, guild_id, tenant, number, channel_id, customer_id, operator_id, expires_at)
    VALUES (?, ?, ?, ?, '', ?, ?, NULL)
  `).run(id, s.guild_id, s.tenant, number, s.customer_id, s.operator_id);
  return { id, number };
});

const qSetChannelId = db.prepare(`UPDATE sessions SET channel_id=? WHERE id=?`);
const qGetOpenByNum = db.prepare(`SELECT * FROM sessions WHERE guild_id=? AND tenant=? AND number=? AND closed_at IS NULL`);
const qGetOpenByChannel = db.prepare(`SELECT * FROM sessions WHERE channel_id=? AND closed_at IS NULL`);
const qUpdateOperator = db.prepare(`UPDATE sessions SET operator_id=? WHERE id=?`);
const qExtend = db.prepare(`
UPDATE sessions
SET expires_at = CASE
  WHEN expires_at IS NULL OR expires_at <= datetime('now')
  THEN datetime('now', '+' || ? || ' minutes')
  ELSE datetime(expires_at, '+' || ? || ' minutes')
END
WHERE id=? AND closed_at IS NULL
`);
const qClose = db.prepare(`UPDATE sessions SET closed_at=datetime('now'), closed_reason=? WHERE id=? AND closed_at IS NULL`);

// tenant remove
const qDeleteTenant = db.prepare(`DELETE FROM tenants WHERE guild_id=? AND name=?`);
const qDeleteCounters = db.prepare(`DELETE FROM counters WHERE guild_id=? AND tenant=?`);
const qCloseSessionsByTenant = db.prepare(`
  UPDATE sessions
  SET closed_at = COALESCE(closed_at, datetime('now')),
      closed_reason = COALESCE(closed_reason, 'Tenant removed')
  WHERE guild_id=? AND tenant=? AND closed_at IS NULL
`);

// ========== Discord client ==========
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
  partials: [Partials.GuildMember, Partials.User],
});

// ========== UI ==========
const ui = {
  welcome: ({prefix, number, customerName}) => new EmbedBuilder()
    .setTitle(`Sportello ${prefix}-${String(number).padStart(3,'0')}`)
    .setDescription(`Benvenut* ${customerName}! Un operatore ti assisterà a breve.\n• Non pingare lo staff\n• Attendi le istruzioni\n• Parla solo qui`)
    .setColor(0x2b6cb0),
  controls: (sid) => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`desk:extend:${sid}`).setLabel('Prolunga 10′').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`desk:transfer:${sid}`).setLabel('Trasferisci').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`desk:close:${sid}`).setLabel('Chiudi').setStyle(ButtonStyle.Danger),
  ),
  archived: ({prefix, number, customerName, operatorName, reason}) => new EmbedBuilder()
    .setTitle(`Archivio • ${prefix}-${String(number).padStart(3,'0')}`)
    .addFields(
      { name:'Cliente', value: customerName, inline:true },
      { name:'Operatore', value: operatorName, inline:true },
      { name:'Esito', value: reason || 'Chiuso', inline:true },
    ).setTimestamp(new Date()).setColor(0x718096),
  notStaff: '❌ Solo lo staff può usare questi controlli.',
  notAssigned: '❌ Puoi chiudere solo lo sportello assegnato a te.',
  notFound: '❌ Sportello non trovato.',
  openedOk: (prefix, n) => `✅ Aperto **${prefix}-${String(n).padStart(3,'0')}**.`,
};

const rolesFromRow = (row) => ({
  staff:   parseJSON(row.staff_roles_json, []),
  manager: parseJSON(row.manager_roles_json, []),
});
const hasAny = (member, ids=[]) => ids.some(id => member.roles.cache.has(id));
const isTenantStaff   = (member, r) => hasAny(member, r.staff)   || isTenantManager(member, r);
const isTenantManager = (member, r) => hasAny(member, r.manager);

// ========== Commands ==========
const COMMANDS = [
  new SlashCommandBuilder()
    .setName('tenant-add')
    .setDescription('Crea/aggiorna un’azienda (solo Gestisci Server)')
    .addStringOption(o=>o.setName('nome').setDescription('Nome azienda (es. GBC)').setRequired(true))
    .addStringOption(o=>o.setName('prefix').setDescription('Prefisso numeri (es. GBC)').setRequired(true))
    .addChannelOption(o=>o.setName('categoria').setDescription('Categoria Sportelli').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .addChannelOption(o=>o.setName('archivio').setDescription('Canale archivio log').setRequired(true))
    .addRoleOption(o=>o.setName('staff_role_1').setDescription('Ruolo staff 1'))
    .addRoleOption(o=>o.setName('staff_role_2').setDescription('Ruolo staff 2'))
    .addRoleOption(o=>o.setName('staff_role_3').setDescription('Ruolo staff 3'))
    .addRoleOption(o=>o.setName('manager_role_1').setDescription('Ruolo manager 1'))
    .addRoleOption(o=>o.setName('manager_role_2').setDescription('Ruolo manager 2')),
  new SlashCommandBuilder()
    .setName('tenant-list')
    .setDescription('Elenca le aziende configurate'),
  new SlashCommandBuilder()
    .setName('tenant-remove')
    .setDescription('Rimuove un’azienda (chiude eventuali sportelli aperti)')
    .addStringOption(o=>o.setName('nome').setDescription('Nome azienda').setRequired(true)),
  new SlashCommandBuilder()
    .setName('desk-open')
    .setDescription('Apri sportello per cliente in un’azienda')
    .addStringOption(o=>o.setName('tenant').setDescription('Nome azienda').setRequired(true))
    .addUserOption(o=>o.setName('cliente').setDescription('Cliente').setRequired(true)),
  new SlashCommandBuilder()
    .setName('desk-close')
    .setDescription('Chiudi sportello per numero (specifica tenant se fuori dal canale)')
    .addIntegerOption(o=>o.setName('numero').setDescription('Numero sportello del giorno').setRequired(true))
    .addStringOption(o=>o.setName('tenant').setDescription('Nome azienda (se non nel canale)')),
].map(c=>c.toJSON());

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.application.id), { body: COMMANDS });
    console.log(`Slash commands registrati: ${COMMANDS.length}`);
    console.log(`DB path: ${DB_PATH}`);
  } catch (e) {
    console.error('Command registration error:', e);
  }
});

// ========== helpers ==========
const getTenants = (guildId) => qGetTenants.all(guildId);
const getTenant  = (guildId, name) => qGetTenant.get(guildId, name);

function overwritesFor(guild, roles, customerId) {
  const ow = [];
  ow.push({ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] });
  const cm = guild.members.cache.get(customerId);
  if (cm) ow.push({ id: cm.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
  for (const r of roles.staff)   if (guild.roles.cache.has(r)) ow.push({ id: r, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
  for (const r of roles.manager) if (guild.roles.cache.has(r)) ow.push({ id: r, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] });
  return ow;
}

function pad2(n){ return String(n).padStart(2,'0'); }
function hhmm(d){ const h = d.getHours(), m = d.getMinutes(); return `${pad2(h)}:${pad2(m)}`; }

// Costruisce trascrizione testuale: (HH:MM) DisplayName : messaggio
async function buildTranscript(channel, sinceIso) {
  const since = sinceIso ? new Date(sinceIso) : null;
  const lines = [];
  let lastId = undefined;
  let total = 0;
  // raccogli fino a 1000 messaggi recenti (basta per sportelli)
  while (total < 1000) {
    const batch = await channel.messages.fetch({ limit: 100, before: lastId }).catch(()=>null);
    if (!batch || batch.size === 0) break;
    const arr = Array.from(batch.values());
    for (const msg of arr) {
      if (since && msg.createdAt < since) continue;
      if (msg.author?.bot) continue; // escludi messaggi del bot
      const disp = msg.member?.displayName || msg.author?.username || 'Utente';
      const when = hhmm(msg.createdAt);
      const text = msg.cleanContent || (msg.content ?? '');
      // allega eventuali attachments come [file: nome]
      const attach = msg.attachments?.size ? ' ' + Array.from(msg.attachments.values()).map(a=>`[file: ${a.name}]`).join(' ') : '';
      lines.push(`(${when}) ${disp} : ${text}${attach}`);
    }
    total += arr.length;
    lastId = arr[arr.length-1].id;
  }
  // ordina cronologico
  lines.sort(); // (HH:MM) già ordina quasi ok; per sicurezza potresti mapparle con timestamp
  const body = lines.join('\n');
  const buf = Buffer.from(body || '(nessun messaggio)');
  return new AttachmentBuilder(buf, { name: 'transcript.txt' });
}

// ========== Interactions ==========
client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) {
      if (!i.inGuild()) return i.reply({ content:'Usa i comandi in un server.', ephemeral:true });
      const g = i.guild;
      const name = i.commandName;

      // tenant-add (Gestisci Server)
      if (name === 'tenant-add') {
        if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild))
          return i.reply({ content:'❌ Serve il permesso Gestisci Server.', ephemeral:true });

        const tenantName = i.options.getString('nome', true).trim();
        const prefix     = i.options.getString('prefix', true).trim();
        const category   = i.options.getChannel('categoria', true);
        const archive    = i.options.getChannel('archivio', true);

        const staffRoles = [
          i.options.getRole('staff_role_1')?.id,
          i.options.getRole('staff_role_2')?.id,
          i.options.getRole('staff_role_3')?.id,
        ].filter(Boolean);
        const managerRoles = [
          i.options.getRole('manager_role_1')?.id,
          i.options.getRole('manager_role_2')?.id,
        ].filter(Boolean);

        if (category.type !== ChannelType.GuildCategory)
          return i.reply({ content:'❌ La categoria non è una Category.', ephemeral:true });

        qUpsertTenant.run({
          guild_id: g.id,
          name: tenantName,
          prefix,
          category_id: category.id,
          archive_id: archive.id,
          staff_roles_json:   toJSON(staffRoles),
          manager_roles_json: toJSON(managerRoles),
        });

        return i.reply({ content:`✅ Tenant **${tenantName}** salvato. Prefix: **${prefix}**`, ephemeral:true });
      }

      // tenant-list
      if (name === 'tenant-list') {
        const rows = getTenants(g.id);
        if (!rows.length) return i.reply({ content:'(vuoto) Nessuna azienda configurata.', ephemeral:true });
        const lines = rows.map(r => {
          const roles = rolesFromRow(r);
          return `• **${r.name}** — prefix: ${r.prefix} — categoria: <#${r.category_id}> — archivio: <#${r.archive_id}> — staff: ${roles.staff.map(x=>`<@&${x}>`).join(', ') || '(none)'}`;
        });
        return i.reply({ content: lines.join('\n'), ephemeral:true });
      }

      // tenant-remove
      if (name === 'tenant-remove') {
        if (!i.member.permissions.has(PermissionFlagsBits.ManageGuild))
          return i.reply({ content:'❌ Serve il permesso Gestisci Server.', ephemeral:true });

        const tenantName = i.options.getString('nome', true).trim();
        const t = getTenant(g.id, tenantName);
        if (!t) return i.reply({ content:'❌ Tenant inesistente.', ephemeral:true });

        // chiudi eventuali sportelli aperti e pulisci contatori
        const tx = db.transaction(() => {
          qCloseSessionsByTenant.run(g.id, t.name);
          qDeleteCounters.run(g.id, t.name);
          qDeleteTenant.run(g.id, t.name);
        });
        tx();

        return i.reply({ content:`🗑️ Tenant **${tenantName}** rimosso.`, ephemeral:true });
      }

      // desk-open
      if (name === 'desk-open') {
        const tenantName = i.options.getString('tenant', true);
        const t = getTenant(g.id, tenantName);
        if (!t) return i.reply({ content:'❌ Tenant inesistente.', ephemeral:true });
        const roles = rolesFromRow(t);
        if (!(isTenantStaff(i.member, roles)))
          return i.reply({ content: ui.notStaff, ephemeral:true });

        const customer = i.options.getUser('cliente', true);
        let cm = g.members.cache.get(customer.id);
        if (!cm) { try { cm = await g.members.fetch(customer.id); } catch {} }
        if (!cm) return i.reply({ content:'❌ Il cliente non è nel server.', ephemeral:true });

        const { id: sid, number } = txCreateSession({
          guild_id: g.id, tenant: t.name, customer_id: customer.id, operator_id: i.user.id
        });
        const nameFinal = `sportello-${t.prefix}-${String(number).padStart(3,'0')}`.toLowerCase();

        const cat = g.channels.cache.get(t.category_id);
        if (!cat || cat.type !== ChannelType.GuildCategory)
          return i.reply({ content:'❌ Categoria del tenant non valida.', ephemeral:true });

        const overw = overwritesFor(g, roles, customer.id);
        const ch = await g.channels.create({
          name: nameFinal, type: ChannelType.GuildText, parent: t.category_id, permissionOverwrites: overw
        });

        qSetChannelId.run(ch.id, sid);

        const emb = ui.welcome({ prefix: t.prefix, number, customerName: cm.displayName });
        await ch.send({ content:`Operatore: <@${i.user.id}> • Cliente: <@${customer.id}>`, embeds:[emb] });
        await ch.send({ components: [ui.controls(sid)] });

        return i.reply({ content: ui.openedOk(t.prefix, number), ephemeral:true });
      }

      // desk-close
      if (name === 'desk-close') {
        const number = i.options.getInteger('numero', true);
        const explicitTenant = i.options.getString('tenant', false);

        let t = explicitTenant ? getTenant(g.id, explicitTenant) : null;
        if (!t) {
          const s = qGetOpenByChannel.get(i.channelId);
          if (s) t = getTenant(g.id, s.tenant);
        }
        if (!t) return i.reply({ content:'❌ Specifica il tenant o esegui nel canale dello sportello.', ephemeral:true });

        const roles = rolesFromRow(t);
        const s = qGetOpenByNum.get(g.id, t.name, number);
        if (!s) return i.reply({ content: ui.notFound, ephemeral:true });

        const isAssigned = s.operator_id === i.user.id;
        if (!(isAssigned || isTenantManager(i.member, roles)))
          return i.reply({ content: ui.notAssigned, ephemeral:true });

        qClose.run('Chiuso da comando', s.id);

        const archive = g.channels.cache.get(t.archive_id);
        const customerName = g.members.cache.get(s.customer_id)?.displayName ?? 'Sconosciut*';
        const operatorName = g.members.cache.get(s.operator_id)?.displayName ?? 'Sconosciut*';

        // Transcript
        let transcript;
        const ch = g.channels.cache.get(s.channel_id);
        if (ch && ch.isTextBased()) {
          transcript = await buildTranscript(ch, s.opened_at);
        }

        if (archive && archive.isTextBased()) {
          const payload = { embeds:[ui.archived({ prefix:t.prefix, number:s.number, customerName, operatorName, reason:'Chiuso da comando' })] };
          if (transcript) payload.files = [transcript];
          await archive.send(payload);
        }
        if (ch) await ch.delete('Sportello chiuso');

        return i.reply({ content:`✅ Sportello ${t.prefix}-${String(s.number).padStart(3,'0')} chiuso.`, ephemeral:true });
      }

      return;
    }

    // Pulsanti
    if (i.isButton()) {
      if (!i.inGuild()) return;
      const [ns, action, sid] = i.customId.split(':');
      if (ns !== 'desk') return;

      const s = qGetOpenByChannel.get(i.channelId);
      if (!s || s.id !== sid) return i.reply({ content: ui.notFound, ephemeral:true });

      const t = getTenant(i.guild.id, s.tenant);
      if (!t) return i.reply({ content:'❌ Config tenant mancante.', ephemeral:true });
      const roles = rolesFromRow(t);
      if (!isTenantStaff(i.member, roles)) return i.reply({ content: ui.notStaff, ephemeral:true });

      if (action === 'extend') {
        qExtend.run(10, 10, s.id);
        return i.reply({ content:'⏱️ Prolungato di 10 minuti.', ephemeral:true });
      }

      if (action === 'transfer') {
        const row = new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId(`desk:transfer:${sid}`)
            .setPlaceholder('Seleziona nuovo operatore')
            .setMinValues(1).setMaxValues(1)
        );
        return i.reply({ content:'Seleziona il nuovo operatore:', components:[row], ephemeral:true });
      }

      if (action === 'close') {
        const isAssigned = s.operator_id === i.user.id;
        if (!(isAssigned || isTenantManager(i.member, roles)))
          return i.reply({ content: ui.notAssigned, ephemeral:true });

        qClose.run('Chiuso da pulsante', s.id);

        const archive = i.guild.channels.cache.get(t.archive_id);
        const customerName = i.guild.members.cache.get(s.customer_id)?.displayName ?? 'Sconosciut*';
        const operatorName = i.guild.members.cache.get(s.operator_id)?.displayName ?? 'Sconosciut*';

        // Transcript
        let transcript;
        if (i.channel && i.channel.isTextBased()) {
          transcript = await buildTranscript(i.channel, s.opened_at);
        }

        if (archive && archive.isTextBased()) {
          const payload = { embeds:[ui.archived({ prefix:t.prefix, number:s.number, customerName, operatorName, reason:'Chiuso da pulsante' })] };
          if (transcript) payload.files = [transcript];
          await archive.send(payload);
        }

        await i.reply({ content:'✅ Sportello chiuso.', ephemeral:true });
        setTimeout(()=> i.channel?.delete('Sportello chiuso'), 800);
        return;
      }
    }

    // Selettore per trasferimento
    if (i.isUserSelectMenu()) {
      if (!i.inGuild()) return;
      const [ns, action, sid] = i.customId.split(':');
      if (ns !== 'desk' || action !== 'transfer') return;

      const s = qGetOpenByChannel.get(i.channelId);
      if (!s || s.id !== sid) return i.reply({ content: ui.notFound, ephemeral:true });

      const t = getTenant(i.guild.id, s.tenant);
      if (!t) return i.reply({ content:'❌ Config tenant mancante.', ephemeral:true });
      const roles = rolesFromRow(t);
      if (!isTenantStaff(i.member, roles)) return i.reply({ content: ui.notStaff, ephemeral:true });

      const newOpId = i.values[0];
      const newOp = await i.guild.members.fetch(newOpId).catch(()=>null);
      if (!newOp || !(isTenantStaff(newOp, roles)))
        return i.reply({ content:'❌ L’utente selezionato non è staff del tenant.', ephemeral:true });

      qUpdateOperator.run(newOp.id, s.id);

      try {
        if (i.channel?.type === ChannelType.GuildText) {
          await i.channel.permissionOverwrites.edit(newOp.id, {
            ViewChannel: true, SendMessages: true
          });
        }
      } catch {}

      return i.reply({ content:`👤 Assegnazione aggiornata: ora è <@${newOp.id}>.`, ephemeral:true });
    }

  } catch (err) {
    console.error('Interaction error:', err);
    if (i.isRepliable()) {
      try { await i.reply({ content:'⚠️ Errore inatteso.', ephemeral:true }); } catch {}
    }
  }
});

client.login(TOKEN);
