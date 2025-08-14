  // metroaziende.cjs — MetroAziende (Org + HR + Contratti PDF)
// Avvio: node metroaziende.cjs
// ENV: DISCORD_TOKEN (obbligatorio), DB_PATH (opzionale; default: ../metrocity.db)

require('dotenv').config();

const { 
  Client, GatewayIntentBits, Partials, REST, Routes, PermissionFlagsBits,
  SlashCommandBuilder, ChannelType, EmbedBuilder, AttachmentBuilder, Colors
} = require('discord.js');
const Database = require('better-sqlite3');
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ====== ENV & DB PATH ======
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('❌ Manca DISCORD_TOKEN nel .env'); process.exit(1); }

function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const parent = path.resolve(process.cwd(), '..', 'metrocity.db');
  if (fs.existsSync(parent)) return parent;
  return parent; // crea nel padre per condivisione coi bot
}
const DB_PATH = resolveDbPath();

// ====== DB setup ======
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  shortcode TEXT NOT NULL,            -- es. MCGOV, GBC, HSP
  primary_color TEXT NOT NULL DEFAULT '#5865F2',
  icon_emoji TEXT,                    -- opz
  category_id TEXT NOT NULL,          -- categoria sportelli/operativo
  archive_id  TEXT NOT NULL,          -- canale archivio log
  ticket_prefix TEXT NOT NULL,        -- prefisso sportelli
  brand_bio TEXT NOT NULL DEFAULT '',
  brand_hours TEXT NOT NULL DEFAULT '',
  brand_welcome TEXT NOT NULL DEFAULT '',
  brand_services TEXT NOT NULL DEFAULT '',
  logo_url TEXT,
  banner_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(guild_id, name),
  UNIQUE(guild_id, shortcode)
);

-- Fino a 5 ruoli/gerarchie, 1 = Direttore, 2 = Vicedirettore
CREATE TABLE IF NOT EXISTS org_roles (
  org_id TEXT NOT NULL,
  level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 5),
  name TEXT NOT NULL,
  discord_role_id TEXT,               -- collegamento al ruolo Discord
  color TEXT NOT NULL DEFAULT '#99AAB5',
  permissions_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (org_id, level),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Un solo ruolo/level per utente per org
CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  level INTEGER NOT NULL CHECK(level BETWEEN 1 AND 5),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Template contratti (versionati)
CREATE TABLE IF NOT EXISTS org_contract_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,                 -- testo con variabili {{...}}
  version INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 0, -- 1=pubblicato come default
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Offerte/istanze di contratto
CREATE TABLE IF NOT EXISTS org_contract_offers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  salary TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING/ACCEPTED/REJECTED/CANCELED
  created_by TEXT NOT NULL,               -- chi ha emesso (dir/vicedir)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES org_contract_templates(id) ON DELETE CASCADE
);

-- Storico contratti firmati (PDF blob)
CREATE TABLE IF NOT EXISTS org_contract_history (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  title TEXT NOT NULL,
  body_snapshot TEXT NOT NULL,
  salary TEXT,
  notes TEXT,
  signed_by_user TEXT NOT NULL,       -- user id firmatario
  signed_by_dir TEXT,                 -- opz: controfirma
  pdf_blob BLOB,                      -- snapshot PDF
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Audit
CREATE TABLE IF NOT EXISTS org_audit (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,               -- es. HIRE, PROMOTE, BRAND_UPDATE, TEMPLATE_EDIT, CONTRACT_SIGN
  target_id TEXT,
  info TEXT,                          -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const parseJSON = (s, fallback={}) => { try { return JSON.parse(s); } catch { return fallback; } };
const toJSON = v => JSON.stringify(v || {});

// ====== Discord client ======
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember, Partials.User],
});

// ====== Helpers ======
function uuid(){ return crypto.randomUUID(); }

function colorToInt(hex) {
  try {
    if (!hex) return Colors.Blurple;
    const h = hex.replace('#','');
    return parseInt(h, 16);
  } catch { return Colors.Blurple; }
}

function canEditRoleStyle(actorLevel, targetLevel) {
  if (actorLevel === 1) return true;      // Direttore: tutto
  if (actorLevel === 2) return targetLevel >= 3; // Vice: solo L3-L5
  return false;
}
function isValidHexColor(s) {
  return /^#?[0-9A-Fa-f]{6}$/.test(s || '');
}

function ensureOrg(guildId, identifier) {
  // identifier può essere name o shortcode
  const q = db.prepare(`SELECT * FROM organizations WHERE guild_id=? AND (name=? OR shortcode=?)`);
  return q.get(guildId, identifier, identifier);
}

function isL3Plus(orgId, userId) {
  const lvl = getMemberLevel(orgId, userId);
  return lvl && lvl <= 3; // L1, L2, L3
}
function assertChannelInOrgCategory(ch, org) {
  return ch?.parentId === org.category_id;
}

function getOrgRoles(orgId) {
  return db.prepare(`SELECT * FROM org_roles WHERE org_id=? ORDER BY level`).all(orgId);
}

function getMemberLevel(orgId, userId) {
  const row = db.prepare(`SELECT level FROM org_members WHERE org_id=? AND user_id=?`).get(orgId, userId);
  return row?.level || null;
}

function isServerAdmin(inter) {
  return inter.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function isDirectorOrVice(g, org, userId) {
  const lvl = getMemberLevel(org.id, userId);
  return lvl === 1 || lvl === 2;
}

function canManageTarget(actorLevel, targetLevel) {
  // L1 (Direttore) può agire su chiunque, tranne se stesso per licenziarsi
  if (actorLevel === 1) return true;
  // L2 (Vicedirettore) non può toccare L1 o L2
  if (actorLevel === 2) return (targetLevel >= 3); // solo L3..L5
  return false;
}

async function addAudit(org, actorId, action, targetId, infoObj) {
  db.prepare(`INSERT INTO org_audit (id, org_id, actor_id, action, target_id, info)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(uuid(), org.id, actorId, action, targetId || null, JSON.stringify(infoObj||{}));
  // log su canale archivio se esiste
  try {
    const channel = await client.channels.fetch(org.archive_id);
    if (channel?.isTextBased()) {
      const emb = new EmbedBuilder()
        .setTitle(`Audit • ${action}`)
        .setColor(colorToInt(org.primary_color))
        .addFields(
          { name:'Org', value: `${org.name} (${org.shortcode})`, inline:true },
          { name:'Attore', value: `<@${actorId}>`, inline:true },
          ...(targetId ? [{ name:'Target', value:`<@${targetId}>`, inline:true }] : [])
        )
        .setDescription('```json\n' + JSON.stringify(infoObj||{}, null, 2) + '\n```')
        .setTimestamp(new Date());
      await channel.send({ embeds:[emb] });
    }
  } catch {}
}

async function syncDiscordRoleForLevel(inter, org, level, roleName, colorHex) {
  // se già mappato, aggiorna nome/colore; altrimenti crea
  let row = db.prepare(`SELECT * FROM org_roles WHERE org_id=? AND level=?`).get(org.id, level);
  if (!row) {
    db.prepare(`INSERT INTO org_roles (org_id, level, name, color) VALUES (?, ?, ?, ?)`)
      .run(org.id, level, roleName, colorHex || '#99AAB5');
    row = db.prepare(`SELECT * FROM org_roles WHERE org_id=? AND level=?`).get(org.id, level);
  }
  let discordRole = null;
  try {
    if (row.discord_role_id) {
      discordRole = await inter.guild.roles.fetch(row.discord_role_id).catch(()=>null);
    }
    if (!discordRole) {
      discordRole = await inter.guild.roles.create({
        name: roleName,
        color: colorHex || '#99AAB5',
        reason: `Ruolo org ${org.name} L${level}`
      });
      db.prepare(`UPDATE org_roles SET discord_role_id=? WHERE org_id=? AND level=?`)
        .run(discordRole.id, org.id, level);
    } else {
      const updates = {};
      if (discordRole.name !== roleName) updates.name = roleName;
      if (colorHex) updates.color = colorHex;
      if (Object.keys(updates).length) await discordRole.edit(updates, 'Sync MetroAziende');
    }
  } catch (e) {
    console.error('syncDiscordRole error:', e);
    throw new Error('Impossibile creare/aggiornare il ruolo Discord.');
  }
  return discordRole;
}

async function setMemberLevel(inter, org, userId, newLevel) {
  // rimuovi eventuali ruoli Discord mappati a L1..L5 per l’org, poi assegna quello giusto
  const roles = getOrgRoles(org.id);
  const member = await inter.guild.members.fetch(userId).catch(()=>null);
  if (!member) throw new Error('Utente non trovato nel server.');

  // remove old mapped roles
  for (const r of roles) {
    if (r.discord_role_id && member.roles.cache.has(r.discord_role_id)) {
      await member.roles.remove(r.discord_role_id).catch(()=>{});
    }
  }
  // add new
  const targetRole = roles.find(x => x.level === newLevel);
  if (targetRole?.discord_role_id) {
    await member.roles.add(targetRole.discord_role_id).catch(()=>{});
  }

  // update db
  const exists = db.prepare(`SELECT 1 FROM org_members WHERE org_id=? AND user_id=?`).get(org.id, userId);
  if (exists) {
    db.prepare(`UPDATE org_members SET level=? WHERE org_id=? AND user_id=?`).run(newLevel, org.id, userId);
  } else {
    db.prepare(`INSERT INTO org_members (org_id, user_id, level) VALUES (?, ?, ?)`).run(org.id, userId, newLevel);
  }
}

function renderContractBody(templateBody, vars){
  return templateBody.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] ?? ''));
}

function buildPdfBuffer({title, body, orgName, orgColorHex, candidateTag, signerTag, salary, notes}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size:'A4', margin:50 });
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    doc.fillColor('#111').fontSize(18).text(title, { align:'center' });
    doc.moveDown(0.5);
    doc.fontSize(10).fillColor('#555').text(`Organizzazione: ${orgName}`);
    if (salary) doc.text(`Retribuzione: ${salary}`);
    if (notes) doc.text(`Note: ${notes}`);
    doc.moveDown(0.5);
    if (orgColorHex) {
      try { doc.rect(50, doc.y, 515, 2).fillColor(orgColorHex).fill(); } catch {}
      doc.moveDown(0.5);
    }
    doc.fillColor('#111').fontSize(12).text(body, { align:'left' });
    doc.moveDown(1.5);
    doc.text(`Firma dipendente: ${candidateTag}`);
    doc.moveDown(0.5);
    doc.text(`Firma direzione: ${signerTag || '—'}`);
    doc.end();
  });
}

// ====== Slash Commands ======
const COMMANDS = [
  // ADMIN (staff server)
  new SlashCommandBuilder()
    .setName('org-create')
    .setDescription('ADMIN: Crea un’organizzazione')
    .addStringOption(o => o.setName('nome').setDescription('Nome').setRequired(true))
    .addStringOption(o => o.setName('shortcode').setDescription('Shortcode/prefisso').setRequired(true))
    .addChannelOption(o => o.setName('categoria').setDescription('Categoria canali').addChannelTypes(ChannelType.GuildCategory).setRequired(true))
    .addChannelOption(o => o.setName('archivio').setDescription('Canale archivio').setRequired(true))
    .addStringOption(o => o.setName('ticket_prefix').setDescription('Prefisso sportelli').setRequired(true))
    .addStringOption(o => o.setName('colore').setDescription('#RRGGBB').setRequired(false)),
    
  new SlashCommandBuilder()
    .setName('org-channel-create')
    .setDescription('L3+: Crea un canale nella categoria della tua organizzazione')
    .addStringOption(o => o.setName('org').setDescription('Nome o shortcode').setRequired(true))
    .addStringOption(o => o.setName('name').setDescription('Nome canale').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Tipo canale').setRequired(true).addChoices(
      { name:'testo', value:'text' },
      { name:'vocale', value:'voice' },
      { name:'forum', value:'forum' }
    ))
    .addStringOption(o => o.setName('topic').setDescription('Topic/descrizione'))
    .addIntegerOption(o => o.setName('slowmode').setDescription('Slowmode in secondi (0=off)')),
      
  new SlashCommandBuilder()
    .setName('org-channel-edit')
    .setDescription('L3+: Modifica un canale nella categoria della tua organizzazione')
    .addStringOption(o => o.setName('org').setDescription('Nome o shortcode').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Canale da modificare').setRequired(true))
    .addStringOption(o => o.setName('name').setDescription('Nuovo nome canale'))
    .addStringOption(o => o.setName('topic').setDescription('Nuovo topic/descrizione'))
    .addIntegerOption(o => o.setName('slowmode').setDescription('Slowmode in secondi (0=off)')),
        
  new SlashCommandBuilder()
    .setName('org-role-style')
    .setDescription('L1/L2: Rinomina e/o cambia colore a un ruolo gerarchico (L1–L5) della propria organizzazione')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode').setRequired(true))
    .addIntegerOption(o=>o.setName('level').setDescription('Livello (1..5)').setMinValue(1).setMaxValue(5).setRequired(true))
    .addStringOption(o=>o.setName('name').setDescription('Nuovo nome ruolo').setRequired(false))
    .addStringOption(o=>o.setName('color').setDescription('Nuovo colore #RRGGBB').setRequired(false)),

  new SlashCommandBuilder()
    .setName('org-channel-delete')
    .setDescription('L3+: Elimina un canale nella categoria della tua organizzazione')
    .addStringOption(o => o.setName('org').setDescription('Nome o shortcode').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Canale da eliminare').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Motivo (audit)')),

  new SlashCommandBuilder()
    .setName('org-role-setup')
    .setDescription('ADMIN: Crea/aggiorna i 5 ruoli Discord per l’organizzazione')
    .addStringOption(o => o.setName('org').setDescription('Nome o shortcode').setRequired(true))
    .addStringOption(o => o.setName('l1_nome').setDescription('Nome L1 (Direttore)').setRequired(true))
    .addStringOption(o => o.setName('l2_nome').setDescription('Nome L2 (Vicedirettore)').setRequired(true))
    .addStringOption(o => o.setName('l3_nome').setDescription('Nome L3').setRequired(true))
    .addStringOption(o => o.setName('l4_nome').setDescription('Nome L4').setRequired(true))
    .addStringOption(o => o.setName('l5_nome').setDescription('Nome L5').setRequired(true))
    .addStringOption(o => o.setName('l1_colore').setDescription('#RRGGBB').setRequired(false))
    .addStringOption(o => o.setName('l2_colore').setDescription('#RRGGBB').setRequired(false))
    .addStringOption(o => o.setName('l3_colore').setDescription('#RRGGBB').setRequired(false))
    .addStringOption(o => o.setName('l4_colore').setDescription('#RRGGBB').setRequired(false))
    .addStringOption(o => o.setName('l5_colore').setDescription('#RRGGBB').setRequired(false)),

  // DIREZIONE (L1 & L2): BRAND
  new SlashCommandBuilder()
    .setName('org-brand')
    .setDescription('L1/L2: Aggiorna brand/vetrina')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode').setRequired(true))
    .addStringOption(o=>o.setName('colore').setDescription('#RRGGBB'))
    .addStringOption(o=>o.setName('logo_url').setDescription('URL logo'))
    .addStringOption(o=>o.setName('banner_url').setDescription('URL banner'))
    .addStringOption(o=>o.setName('bio').setDescription('Descrizione pubblica'))
    .addStringOption(o=>o.setName('hours').setDescription('Orari di apertura'))
    .addStringOption(o=>o.setName('welcome').setDescription('Messaggio benvenuto'))
    .addStringOption(o=>o.setName('services').setDescription('Listino/servizi')),

  new SlashCommandBuilder()
    .setName('org-info')
    .setDescription('Mostra info organizzazione')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode').setRequired(true)),

  new SlashCommandBuilder()
    .setName('org-roster')
    .setDescription('L1/L2: Elenco staff con livelli')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode').setRequired(true)),

  // HR — HIRE/PROMOTE/DEMOTE/FIRE
  new SlashCommandBuilder()
    .setName('org-hire')
    .setDescription('L1/L2: Assumi un candidato')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode').setRequired(true))
    .addUserOption(o=>o.setName('candidato').setDescription('Utente').setRequired(true))
    .addIntegerOption(o=>o.setName('level').setDescription('Livello iniziale (2..5)').setMinValue(2).setMaxValue(5).setRequired(true))
    .addStringOption(o=>o.setName('template').setDescription('Titolo template contratto').setRequired(true))
    .addStringOption(o=>o.setName('salary').setDescription('Retribuzione (testo)').setRequired(false))
    .addStringOption(o=>o.setName('notes').setDescription('Note contratto').setRequired(false)),

  new SlashCommandBuilder()
    .setName('org-promote')
    .setDescription('L1/L2: Promuovi dipendente')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode').setRequired(true))
    .addUserOption(o=>o.setName('utente').setDescription('Dipendente').setRequired(true))
    .addIntegerOption(o=>o.setName('new_level').setDescription('Nuovo livello (1..5)').setMinValue(1).setMaxValue(5).setRequired(true)),

  new SlashCommandBuilder()
    .setName('org-demote')
    .setDescription('L1/L2: Retrocedi dipendente')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode').setRequired(true))
    .addUserOption(o=>o.setName('utente').setDescription('Dipendente').setRequired(true))
    .addIntegerOption(o=>o.setName('new_level').setDescription('Nuovo livello (1..5)').setMinValue(1).setMaxValue(5).setRequired(true)),

  new SlashCommandBuilder()
    .setName('org-fire')
    .setDescription('L1/L2: Licenzia dipendente (no auto-licenziamento direttore)')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode').setRequired(true))
    .addUserOption(o=>o.setName('utente').setDescription('Dipendente').setRequired(true))
    .addStringOption(o=>o.setName('reason').setDescription('Motivo').setRequired(true)),

  // CONTRATTI — TEMPLATE & FIRMA
  new SlashCommandBuilder()
    .setName('contract-template')
    .setDescription('L1/L2: Gestisci template contrattuali')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode').setRequired(true))
    .addStringOption(o=>o.setName('action').setDescription('azione').setRequired(true).addChoices(
      {name:'list', value:'list'},
      {name:'create', value:'create'},
      {name:'edit', value:'edit'},
      {name:'publish', value:'publish'},
      {name:'delete', value:'delete'}
    ))
    .addStringOption(o=>o.setName('title').setDescription('Titolo template'))
    .addIntegerOption(o=>o.setName('version').setDescription('Versione (edit/publish)'))
    .addStringOption(o=>o.setName('body').setDescription('Corpo testo con variabili')),

  new SlashCommandBuilder()
    .setName('contract-sign')
    .setDescription('Dipendente: leggi e firma un’offerta di contratto pendente')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode').setRequired(true))
    .addStringOption(o=>o.setName('offer_id').setDescription('ID offerta').setRequired(true))
    .addStringOption(o=>o.setName('decision').setDescription('accetta o rifiuta').setRequired(true).addChoices(
      {name:'accetta', value:'ACCEPT'},
      {name:'rifiuta', value:'REJECT'}
    )),
].map(c=>c.toJSON());

// ====== Ready ======
client.once('ready', async () => {
  console.log(`✅ MetroAziende attivo come ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.application.id), { body: COMMANDS });
    console.log(`Slash commands registrati: ${COMMANDS.length}`);
    console.log(`DB path: ${DB_PATH}`);
  } catch (e) {
    console.error('Command registration error:', e);
  }
});

function isOrgManagerOrAdmin(inter, org) {
  // true se Admin del server O direttore/vicedirettore dell’org
  const lvl = getMemberLevel(org.id, inter.user.id);
  return isServerAdmin(inter) || lvl === 1 || lvl === 2;
}
function isL3PlusOrAdmin(inter, orgId) {
  // true se Admin del server O L1/L2/L3 nell’org
  return isServerAdmin(inter) || isL3Plus(orgId, inter.user.id);
}

// ====== Command handlers ======
client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;
    if (!i.inGuild()) return i.reply({ content:'Usa i comandi in un server.', ephemeral:true });

    const name = i.commandName;
    const guildId = i.guild.id;

    // ADMIN: org-create
    if (name === 'org-create') {
      if (!isServerAdmin(i)) return i.reply({ content:'❌ Solo Admin del server.', ephemeral:true });
      const nome = i.options.getString('nome', true).trim();
      const shortcode = i.options.getString('shortcode', true).trim();
      const colore = i.options.getString('colore', false) || '#5865F2';
      const categoria = i.options.getChannel('categoria', true);
      const archivio  = i.options.getChannel('archivio', true);
      const ticket_prefix = i.options.getString('ticket_prefix', true).trim();

      if (categoria.type !== ChannelType.GuildCategory) return i.reply({ content:'❌ La categoria non è Category.', ephemeral:true });

      const id = uuid();
      db.prepare(`
        INSERT INTO organizations (id, guild_id, name, shortcode, primary_color, category_id, archive_id, ticket_prefix)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, guildId, nome, shortcode, colore, categoria.id, archivio.id, ticket_prefix);

      return i.reply({ content:`✅ Org **${nome}** (${shortcode}) creata.`, ephemeral:true });
    }

    // ADMIN: org-role-setup
    if (name === 'org-role-setup') {
      if (!isServerAdmin(i)) return i.reply({ content:'❌ Solo Admin del server.', ephemeral:true });
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });

      const names = [1,2,3,4,5].map(L => i.options.getString(`l${L}_nome`, L<=2)); // L1/L2 required
      const colors = [1,2,3,4,5].map(L => i.options.getString(`l${L}_colore`, false) || '#99AAB5');

      for (let L=1; L<=5; L++) {
        const nm = names[L-1];
        if (!nm) continue;
        await syncDiscordRoleForLevel(i, org, L, nm, colors[L-1]);
      }

      await addAudit(org, i.user.id, 'ROLES_SETUP', null, { levels: names });
      return i.reply({ content:`✅ Ruoli L1..L5 creati/aggiornati per **${org.name}**.`, ephemeral:true });
    }

    // BRAND: org-brand (L1/L2 o Admin)
    if (name === 'org-brand') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });
      if (!isOrgManagerOrAdmin(i, org))
        return i.reply({ content:'❌ Solo Direttore/Vicedirettore (o Admin).', ephemeral:true });

      const fields = {
        primary_color: i.options.getString('colore', false) || org.primary_color,
        logo_url: i.options.getString('logo_url', false) ?? org.logo_url,
        banner_url: i.options.getString('banner_url', false) ?? org.banner_url,
        brand_bio: i.options.getString('bio', false) ?? org.brand_bio,
        brand_hours: i.options.getString('hours', false) ?? org.brand_hours,
        brand_welcome: i.options.getString('welcome', false) ?? org.brand_welcome,
        brand_services: i.options.getString('services', false) ?? org.brand_services,
      };

      db.prepare(`
        UPDATE organizations
        SET primary_color=@primary_color, logo_url=@logo_url, banner_url=@banner_url,
            brand_bio=@brand_bio, brand_hours=@brand_hours, brand_welcome=@brand_welcome, brand_services=@brand_services,
            updated_at=datetime('now')
        WHERE id='${org.id}'
      `).run(fields);

      await addAudit(org, i.user.id, 'BRAND_UPDATE', null, fields);
      const emb = new EmbedBuilder()
        .setTitle(`${org.name} (${org.shortcode}) • Brand aggiornato`)
        .setColor(colorToInt(fields.primary_color))
        .setDescription(fields.brand_bio || '(bio vuota)')
        .addFields(
          { name:'Orari', value: fields.brand_hours || '-', inline:true },
          { name:'Servizi', value: fields.brand_services || '-', inline:true },
          { name:'Welcome', value: fields.brand_welcome || '-', inline:false },
        );
      if (fields.logo_url) emb.setThumbnail(fields.logo_url);
      if (fields.banner_url) emb.setImage(fields.banner_url);
      return i.reply({ embeds:[emb], ephemeral:true });
    }

    // L3+ (o Admin): canali
    if (name === 'org-channel-create') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });
      if (!isL3PlusOrAdmin(i, org.id)) return i.reply({ content:'❌ Solo L3/L2/L1 (o Admin).', ephemeral:true });

      const chName = i.options.getString('name', true).trim().toLowerCase().replace(/\s+/g,'-');
      const type   = i.options.getString('type', true); // text|voice|forum
      const topic  = i.options.getString('topic', false) || null;
      const slow   = i.options.getInteger('slowmode', false);
      const nsfw   = i.options.getBoolean('nsfw', false) ?? false;

      try {
        const payload = { name: chName, parent: org.category_id };
        if (type === 'text')  { payload.type = ChannelType.GuildText;  payload.topic = topic; payload.nsfw = nsfw; if (Number.isInteger(slow)) payload.rateLimitPerUser = Math.max(0, slow); }
        if (type === 'forum') { payload.type = ChannelType.GuildForum; payload.topic = topic; payload.nsfw = nsfw; }
        if (type === 'voice') { payload.type = ChannelType.GuildVoice; }

        const ch = await i.guild.channels.create(payload);
        await addAudit(org, i.user.id, 'CHANNEL_CREATE', ch.id, { name: chName, type, nsfw, slowmode: slow ?? 0, topic });
        return i.reply({ content:`✅ Creato <#${ch.id}> in **${org.name}**.`, ephemeral:true });
      } catch (e) {
        return i.reply({ content:'❌ Impossibile creare il canale (permessi/gerarchia).', ephemeral:true });
      }
    }

    if (name === 'org-channel-delete') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });
      if (!isL3PlusOrAdmin(i, org.id)) return i.reply({ content:'❌ Solo L3/L2/L1 (o Admin).', ephemeral:true });

      const ch = i.options.getChannel('channel', true);
      if (!assertChannelInOrgCategory(ch, org)) return i.reply({ content:'❌ Il canale non è nella categoria della tua org.', ephemeral:true });
      if (ch.id === org.archive_id) return i.reply({ content:'❌ Non puoi eliminare il canale archivio.', ephemeral:true });

      const reason = i.options.getString('reason', false) || 'N/D';
      try {
        const snapshot = { id: ch.id, name: ch.name, type: ch.type, parent: ch.parentId };
        await ch.delete(`Org channel delete by ${i.user.tag} — ${reason}`);
        await addAudit(org, i.user.id, 'CHANNEL_DELETE', null, { snapshot, reason });
        return i.reply({ content:`🗑️ Eliminato canale **${snapshot.name}**.`, ephemeral:true });
      } catch {
        return i.reply({ content:'❌ Non riesco a eliminare il canale.', ephemeral:true });
      }
    }

    if (name === 'org-channel-edit') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });
      if (!isL3PlusOrAdmin(i, org.id)) return i.reply({ content:'❌ Solo L3/L2/L1 (o Admin).', ephemeral:true });

      const ch = i.options.getChannel('channel', true);
      if (!assertChannelInOrgCategory(ch, org)) return i.reply({ content:'❌ Il canale non è nella categoria della tua org.', ephemeral:true });
      if (ch.id === org.archive_id) return i.reply({ content:'❌ Non puoi modificare il canale archivio.', ephemeral:true });

      const newName = i.options.getString('name', false);
      const topic   = i.options.getString('topic', false);
      const slow    = i.options.getInteger('slowmode', false);
      const nsfw    = i.options.getBoolean('nsfw', false);

      const updates = {};
      if (newName) updates.name = newName.toLowerCase().replace(/\s+/g,'-');
      if (topic !== null && ch.type === ChannelType.GuildText) updates.topic = topic;
      if (Number.isInteger(slow) && ch.type === ChannelType.GuildText) updates.rateLimitPerUser = Math.max(0, slow);
      if (typeof nsfw === 'boolean' && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildForum)) updates.nsfw = nsfw;

      if (!Object.keys(updates).length) return i.reply({ content:'ℹ️ Nessuna modifica richiesta.', ephemeral:true });

      try {
        const before = { name: ch.name, topic: ch.topic, slowmode: ch.rateLimitPerUser ?? 0, nsfw: ch.nsfw ?? false };
        await ch.edit(updates, `Org channel edit by ${i.user.tag}`);
        await addAudit(org, i.user.id, 'CHANNEL_EDIT', ch.id, { before, updates });
        return i.reply({ content:`✅ Aggiornato <#${ch.id}>.`, ephemeral:true });
      } catch {
        return i.reply({ content:'❌ Non riesco a modificare il canale.', ephemeral:true });
      }
    }

    // INFO
    if (name === 'org-info') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });
      const roles = getOrgRoles(org.id);
      const emb = new EmbedBuilder()
        .setTitle(`${org.name} (${org.shortcode})`)
        .setColor(colorToInt(org.primary_color))
        .setDescription(org.brand_bio || '(bio vuota)')
        .addFields(
          { name:'Categoria', value:`<#${org.category_id}>`, inline:true },
          { name:'Archivio', value:`<#${org.archive_id}>`, inline:true },
          { name:'Prefix', value: org.ticket_prefix, inline:true },
          { name:'Orari', value: org.brand_hours || '-', inline:true },
          { name:'Servizi', value: org.brand_services || '-', inline:true },
          { name:'Welcome', value: org.brand_welcome || '-', inline:false },
          { name:'Gerarchie', value: roles.map(r=>`L${r.level} • ${r.name}`).join('\n') || '(non configurate)', inline:false }
        );
      if (org.logo_url) emb.setThumbnail(org.logo_url);
      if (org.banner_url) emb.setImage(org.banner_url);
      return i.reply({ embeds:[emb], ephemeral:true });
    }

    // ROSTER (L1/L2 o Admin)
    if (name === 'org-roster') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });
      if (!isOrgManagerOrAdmin(i, org))
        return i.reply({ content:'❌ Solo Direttore/Vicedirettore (o Admin).', ephemeral:true });

      const rows = db.prepare(`SELECT * FROM org_members WHERE org_id=? ORDER BY level, joined_at`).all(org.id);
      const list = await Promise.all(rows.map(async r=>{
        const mem = await i.guild.members.fetch(r.user_id).catch(()=>null);
        const tag = mem ? `${mem.displayName}` : `ID:${r.user_id}`;
        return `L${r.level} — ${tag}`;
      }));
      return i.reply({ content: list.length ? list.join('\n') : '(vuoto)', ephemeral:true });
    }

    // HIRE (L1/L2 o Admin)
    if (name === 'org-hire') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });
      const actorLevel = getMemberLevel(org.id, i.user.id);
      const adminBypass = isServerAdmin(i);
      if (!adminBypass && !(actorLevel === 1 || actorLevel === 2))
        return i.reply({ content:'❌ Solo Direttore/Vicedirettore (o Admin).', ephemeral:true });

      const candidate = i.options.getUser('candidato', true);
      const level = i.options.getInteger('level', true); // 3..5
      if (!adminBypass && actorLevel === 2 && level < 3)
        return i.reply({ content:'❌ L2 può assumere solo L3..L5.', ephemeral:true });

      const title = i.options.getString('template', true).trim();
      const tpl = db.prepare(`SELECT * FROM org_contract_templates WHERE org_id=? AND title=? ORDER BY version DESC`).get(org.id, title);
      if (!tpl) return i.reply({ content:'❌ Template inesistente.', ephemeral:true });

      const salary = i.options.getString('salary', false) || null;
      const notes  = i.options.getString('notes', false) || null;

      const offerId = uuid();
      db.prepare(`
        INSERT INTO org_contract_offers (id, org_id, template_id, candidate_id, level, salary, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(offerId, org.id, tpl.id, candidate.id, level, salary, notes, i.user.id);

      await addAudit(org, i.user.id, 'HIRE_OFFER', candidate.id, { level, template:title, salary, notes, offerId, adminBypass });
      return i.reply({ content:`📄 Offerta inviata a ${candidate}: ID **${offerId}**. Il candidato usi /contract-sign.`, ephemeral:true });
    }

    // PROMOTE (L1/L2 o Admin)
    if (name === 'org-promote') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });
      const actorLevel = getMemberLevel(org.id, i.user.id);
      const adminBypass = isServerAdmin(i);
      if (!adminBypass && !(actorLevel === 1 || actorLevel === 2))
        return i.reply({ content:'❌ Solo Direttore/Vicedirettore (o Admin).', ephemeral:true });

      const user = i.options.getUser('utente', true);
      const current = getMemberLevel(org.id, user.id);
      if (!current) return i.reply({ content:'❌ Utente non è dipendente.', ephemeral:true });

      const newLevel = i.options.getInteger('new_level', true);
      if (!adminBypass && actorLevel === 2 && (newLevel < 3 || current < 3))
        return i.reply({ content:'❌ L2 non può toccare L1/L2 (né promuovere da/verso).', ephemeral:true });

      await setMemberLevel(i, org, user.id, newLevel);
      await addAudit(org, i.user.id, 'PROMOTE', user.id, { from: current, to: newLevel, adminBypass });
      return i.reply({ content:`✅ Promosso <@${user.id}> da L${current} → L${newLevel}.`, ephemeral:true });
    }

    // DEMOTE (L1/L2 o Admin)
    if (name === 'org-demote') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });
      const actorLevel = getMemberLevel(org.id, i.user.id);
      const adminBypass = isServerAdmin(i);
      if (!adminBypass && !(actorLevel === 1 || actorLevel === 2))
        return i.reply({ content:'❌ Solo Direttore/Vicedirettore (o Admin).', ephemeral:true });

      const user = i.options.getUser('utente', true);
      const current = getMemberLevel(org.id, user.id);
      if (!current) return i.reply({ content:'❌ Utente non è dipendente.', ephemeral:true });

      const newLevel = i.options.getInteger('new_level', true);
      if (!adminBypass && actorLevel === 2 && (current < 3 || newLevel < 3))
        return i.reply({ content:'❌ L2 non può toccare L1/L2.', ephemeral:true });

      await setMemberLevel(i, org, user.id, newLevel);
      await addAudit(org, i.user.id, 'DEMOTE', user.id, { from: current, to: newLevel, adminBypass });
      return i.reply({ content:`✅ Retrocesso <@${user.id}> da L${current} → L${newLevel}.`, ephemeral:true });
    }

    // ROLE STYLE (L1/L2 o Admin)
    if (name === 'org-role-style') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });

      if (!isOrgManagerOrAdmin(i, org))
        return i.reply({ content:'❌ Solo Direttore/Vicedirettore (o Admin).', ephemeral:true });

      const targetLevel = i.options.getInteger('level', true);
      const newName = (i.options.getString('name', false) || '').trim();
      let newColor = i.options.getString('color', false) || '';

      const roleRow = db.prepare(`SELECT * FROM org_roles WHERE org_id=? AND level=?`).get(org.id, targetLevel);
      if (!roleRow || !roleRow.discord_role_id)
        return i.reply({ content:'❌ Ruolo non configurato per questo livello.', ephemeral:true });

      if (!newName && !newColor)
        return i.reply({ content:'ℹ️ Nessuna modifica richiesta.', ephemeral:true });

      if (newName && newName.length > 100)
        return i.reply({ content:'❌ Nome troppo lungo (max 100).', ephemeral:true });

      if (newColor) {
        if (!isValidHexColor(newColor)) return i.reply({ content:'❌ Colore non valido. Usa #RRGGBB.', ephemeral:true });
        if (newColor[0] !== '#') newColor = '#' + newColor;
      }

      if (newName) {
        const dup = db.prepare(`SELECT 1 FROM org_roles WHERE org_id=? AND name=? AND level<>?`).get(org.id, newName, targetLevel);
        if (dup) return i.reply({ content:'❌ Esiste già un ruolo con questo nome nella tua organizzazione.', ephemeral:true });
      }

      const discordRole = await i.guild.roles.fetch(roleRow.discord_role_id).catch(()=>null);
      if (!discordRole) return i.reply({ content:'❌ Ruolo Discord non trovato (desincronizzato).', ephemeral:true });

      const updates = {};
      if (newName) updates.name = newName;
      if (newColor) updates.color = newColor;

      try {
        if (Object.keys(updates).length) {
          await discordRole.edit(updates, `Role style update by ${i.user.tag} (MetroAziende)`);
        }
      } catch (e) {
        return i.reply({ content:'❌ Non riesco a modificare il ruolo (permessi o posizione).', ephemeral:true });
      }

      const newDbName  = newName  || roleRow.name;
      const newDbColor = newColor || roleRow.color;
      db.prepare(`UPDATE org_roles SET name=?, color=? WHERE org_id=? AND level=?`)
        .run(newDbName, newDbColor, org.id, targetLevel);

      await addAudit(org, i.user.id, 'ROLE_STYLE_UPDATE', null, {
        level: targetLevel,
        from: { name: roleRow.name, color: roleRow.color },
        to:   { name: newDbName,   color: newDbColor },
        adminBypass: isServerAdmin(i)
      });

      return i.reply({
        content: `✅ Ruolo L${targetLevel} aggiornato${newName ? ` → **${newDbName}**` : ''}${newColor ? `, colore ${newDbColor}` : ''}.`,
        ephemeral: true
      });
    }

    // FIRE (L1/L2 o Admin)
    if (name === 'org-fire') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });
      const actorLevel = getMemberLevel(org.id, i.user.id);
      const adminBypass = isServerAdmin(i);
      if (!adminBypass && !(actorLevel === 1 || actorLevel === 2))
        return i.reply({ content:'❌ Solo Direttore/Vicedirettore (o Admin).', ephemeral:true });

      const user = i.options.getUser('utente', true);
      const current = getMemberLevel(org.id, user.id);
      if (!current) return i.reply({ content:'❌ Utente non è dipendente.', ephemeral:true });

      if (!adminBypass && i.user.id === user.id && actorLevel === 1) {
        return i.reply({ content:'❌ Il Direttore non può autolicenziarsi.', ephemeral:true });
      }
      if (!adminBypass && actorLevel === 2 && current < 3) {
        return i.reply({ content:'❌ L2 non può licenziare L1/L2.', ephemeral:true });
      }

      db.prepare(`DELETE FROM org_members WHERE org_id=? AND user_id=?`).run(org.id, user.id);

      const roles = getOrgRoles(org.id);
      const mem = await i.guild.members.fetch(user.id).catch(()=>null);
      if (mem) {
        for (const r of roles) {
          if (r.discord_role_id && mem.roles.cache.has(r.discord_role_id)) {
            await mem.roles.remove(r.discord_role_id).catch(()=>{});
          }
        }
      }
      const reason = i.options.getString('reason', true);
      await addAudit(org, i.user.id, 'FIRE', user.id, { from: current, reason, adminBypass });
      return i.reply({ content:`📝 Licenziato <@${user.id}> (era L${current}).`, ephemeral:true });
    }

    // TEMPLATES contratti (L1/L2 o Admin)
    if (name === 'contract-template') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });
      if (!isOrgManagerOrAdmin(i, org))
        return i.reply({ content:'❌ Solo Direttore/Vicedirettore (o Admin).', ephemeral:true });

      const action = i.options.getString('action', true);
      const title = i.options.getString('title', false);
      const version = i.options.getInteger('version', false);
      const body = i.options.getString('body', false);

      if (action === 'list') {
        const rows = db.prepare(`SELECT title, MAX(version) as maxv, SUM(CASE WHEN published=1 THEN 1 ELSE 0 END) as pub
                                 FROM org_contract_templates WHERE org_id=? GROUP BY title`).all(org.id);
        const lines = rows.map(r => `• ${r.title} (v${r.maxv}) ${r.pub? '— pubblicato':''}`);
        return i.reply({ content: lines.length? lines.join('\n'):'(nessun template)', ephemeral:true });
      }

      if (action === 'create') {
        if (!title || !body) return i.reply({ content:'❌ title e body richiesti.', ephemeral:true });
        const ver = 1;
        db.prepare(`INSERT INTO org_contract_templates (id, org_id, title, body, version, published, created_by)
                    VALUES (?, ?, ?, ?, ?, 0, ?)`)
          .run(uuid(), org.id, title, body, ver, i.user.id);
        await addAudit(org, i.user.id, 'TEMPLATE_CREATE', null, { title, version:ver, adminBypass: isServerAdmin(i) });
        return i.reply({ content:`✅ Creato template **${title}** v1.`, ephemeral:true });
      }

      if (action === 'edit') {
        if (!title || !body) return i.reply({ content:'❌ title e body richiesti.', ephemeral:true });
        const last = db.prepare(`SELECT MAX(version) as v FROM org_contract_templates WHERE org_id=? AND title=?`).get(org.id, title);
        const nextV = (last?.v || 0) + 1;
        db.prepare(`INSERT INTO org_contract_templates (id, org_id, title, body, version, published, created_by)
                    VALUES (?, ?, ?, ?, ?, 0, ?)`)
          .run(uuid(), org.id, title, body, nextV, i.user.id);
        await addAudit(org, i.user.id, 'TEMPLATE_EDIT', null, { title, version:nextV, adminBypass: isServerAdmin(i) });
        return i.reply({ content:`✏️ Nuova versione **${title}** v${nextV} creata (non pubblicata).`, ephemeral:true });
      }

      if (action === 'publish') {
        if (!title) return i.reply({ content:'❌ title richiesto.', ephemeral:true });
        let row;
        if (version) {
          row = db.prepare(`SELECT * FROM org_contract_templates WHERE org_id=? AND title=? AND version=?`)
            .get(org.id, title, version);
        } else {
          row = db.prepare(`SELECT * FROM org_contract_templates WHERE org_id=? AND title=? ORDER BY version DESC LIMIT 1`)
            .get(org.id, title);
        }
        if (!row) return i.reply({ content:'❌ Template non trovato.', ephemeral:true });
        db.prepare(`UPDATE org_contract_templates SET published=0 WHERE org_id=? AND title=?`).run(org.id, title);
        db.prepare(`UPDATE org_contract_templates SET published=1 WHERE id=?`).run(row.id);
        await addAudit(org, i.user.id, 'TEMPLATE_PUBLISH', null, { title, version: row.version, adminBypass: isServerAdmin(i) });
        return i.reply({ content:`📢 Pubblicata **${title}** v${row.version}.`, ephemeral:true });
      }

      if (action === 'delete') {
        if (!title || !version) return i.reply({ content:'❌ title e version richiesti.', ephemeral:true });
        db.prepare(`DELETE FROM org_contract_templates WHERE org_id=? AND title=? AND version=?`).run(org.id, title, version);
        await addAudit(org, i.user.id, 'TEMPLATE_DELETE', null, { title, version, adminBypass: isServerAdmin(i) });
        return i.reply({ content:`🗑️ Eliminato **${title}** v${version}.`, ephemeral:true });
      }

      return;
    }

    // SIGN contratto (invariato)
    if (name === 'contract-sign') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });

      const offerId = i.options.getString('offer_id', true).trim();
      const decision = i.options.getString('decision', true);

      const offer = db.prepare(`SELECT * FROM org_contract_offers WHERE id=? AND org_id=?`).get(offerId, org.id);
      if (!offer) return i.reply({ content:'❌ Offerta non trovata.', ephemeral:true });
      if (offer.candidate_id !== i.user.id) return i.reply({ content:'❌ Non sei il destinatario dell’offerta.', ephemeral:true });
      if (offer.status !== 'PENDING') return i.reply({ content:`ℹ️ Offerta già ${offer.status}.`, ephemeral:true });

      const tpl = db.prepare(`SELECT * FROM org_contract_templates WHERE id=?`).get(offer.template_id);
      if (!tpl) return i.reply({ content:'❌ Template collegato mancante.', ephemeral:true });

      if (decision === 'REJECT') {
        db.prepare(`UPDATE org_contract_offers SET status='REJECTED', decided_at=datetime('now') WHERE id=?`).run(offer.id);
        await addAudit(org, i.user.id, 'CONTRACT_REJECT', i.user.id, { offerId });
        return i.reply({ content:'❎ Hai rifiutato l’offerta.', ephemeral:true });
      }

      const vars = {
        ORG_NAME: org.name,
        NOME: i.member?.displayName || i.user.username,
        LIVELLO: `L${offer.level}`,
        RETRIBUZIONE: offer.salary || '',
        CLAUSOLE: '',
      };
      const body = renderContractBody(tpl.body, vars);
      const pdf = await buildPdfBuffer({
        title: tpl.title,
        body,
        orgName: org.name,
        orgColorHex: org.primary_color,
        candidateTag: i.user.tag,
        signerTag: '',
        salary: offer.salary,
        notes: offer.notes
      });

      db.prepare(`
        INSERT INTO org_contract_history (id, org_id, user_id, level, title, body_snapshot, salary, notes, signed_by_user, pdf_blob)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuid(), org.id, i.user.id, offer.level, tpl.title, body, offer.salary, offer.notes, i.user.id, pdf);

      db.prepare(`UPDATE org_contract_offers SET status='ACCEPTED', decided_at=datetime('now') WHERE id=?`).run(offer.id);

      await setMemberLevel(i, org, i.user.id, offer.level);
      await addAudit(org, i.user.id, 'CONTRACT_ACCEPT', i.user.id, { offerId, level: offer.level });

      const attach = new AttachmentBuilder(pdf, { name:`Contratto_${org.shortcode}_${i.user.username}.pdf` });
      return i.reply({ content:`✅ Offerta accettata. Benvenut* in **${org.name}** (L${offer.level}).`, files:[attach], ephemeral:true });
    }

  } catch (err) {
    console.error('Interaction error:', err);
    if (i.isRepliable()) {
      try { await i.reply({ content:`⚠️ Errore: ${err.message || 'inatteso'}`, ephemeral:true }); } catch {}
    }
  }
});
client.login(TOKEN);
