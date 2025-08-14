// metro_municipio.cjs — Municipio (Tutorial + Arrivi + Registrazione + CDI — solo EMBED, no PDF)
// Avvio: node metro_municipio.cjs
// ENV: DISCORD_TOKEN (obbligatorio), DB_PATH (opzionale; default: ../metrocity.db)
//
// Dipendenze: npm i discord.js better-sqlite3 dotenv

require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials, REST, Routes, PermissionFlagsBits,
  SlashCommandBuilder, ChannelType, EmbedBuilder, Colors,
  ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const Database = require('better-sqlite3');
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
db.pragma('journal_mode', { value: 'WAL' });
db.pragma('synchronous', { value: 'NORMAL' });
db.pragma('foreign_keys', { value: 'ON' });
db.pragma('busy_timeout', { value: 5000 });

// Tabelle Municipio (+ riuso organizations/org_members da MetroAziende)
db.exec(`
CREATE TABLE IF NOT EXISTS muni_arrivals (
  id_cert TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cf TEXT NOT NULL,
  name TEXT NOT NULL,
  surname TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  birth_place TEXT NOT NULL,
  gender TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  signature_hash TEXT NOT NULL,
  tutorial_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS muni_registry (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cf TEXT NOT NULL,
  name TEXT NOT NULL,
  surname TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  birth_place TEXT NOT NULL,
  gender TEXT NOT NULL,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  registered_by TEXT NOT NULL,
  grant_bonus_done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id)
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS cdi_docs (
  id_doc TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cf TEXT NOT NULL,
  name TEXT NOT NULL,
  surname TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  birth_place TEXT NOT NULL,
  gender TEXT NOT NULL,
  emitted_at TEXT NOT NULL,
  last_review_at TEXT,
  status TEXT NOT NULL DEFAULT 'VALID', -- VALID | REVIEW_DUE | REVOKED | LOST
  issuer TEXT NOT NULL
);
`);
db.exec(`
CREATE TABLE IF NOT EXISTS muni_audit (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,               -- TUTORIAL_DONE, SELF_REGISTER, REGISTER_OK, REGISTER_FAIL, CDI_ISSUE, CERT_TRADE
  target_id TEXT,
  info TEXT,                          -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ====== Helpers comuni / Org ======
function uuid(){ return crypto.randomUUID(); }
function colorToInt(hex) {
  try { if (!hex) return Colors.Blurple; const h = hex.replace('#',''); return parseInt(h,16); } catch { return Colors.Blurple; }
}
function isServerAdmin(inter) {
  return inter.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}
// Riuso tabelle di MetroAziende (devono esistere nello stesso DB)
function ensureOrg(guildId, identifier) {
  const q = db.prepare(`SELECT * FROM organizations WHERE guild_id=? AND (name=? OR shortcode=?)`);
  return q.get(guildId, identifier, identifier);
}
function getMemberLevel(orgId, userId) {
  const row = db.prepare(`SELECT level FROM org_members WHERE org_id=? AND user_id=?`).get(orgId, userId);
  return row?.level || null;
}
// Basta essere dipendente (L1..L5)
function isMunicipioEmployee(orgId, userId) {
  const lvl = getMemberLevel(orgId, userId);
  return !!(lvl && lvl >= 1 && lvl <= 5);
}

async function addAudit(guildId, actorId, action, targetId, infoObj) {
  db.prepare(`INSERT INTO muni_audit (id, guild_id, actor_id, action, target_id, info)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(uuid(), guildId, actorId, action, targetId || null, JSON.stringify(infoObj||{}));
}

// ====== Adapter verso MetroInventory (libreria condivisa) ======
const inv = require("../inventory-core.cjs")(db);

// ====== Discord client ======
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember, Partials.User],
});

// ====== UI helpers ======
function embOk(title, color=0x2ecc71){ return new EmbedBuilder().setTitle(title).setColor(color); }
function embWarn(title, color=0xf1c40f){ return new EmbedBuilder().setTitle(title).setColor(color); }
function embErr(title, color=0xe74c3c){ return new EmbedBuilder().setTitle(title).setColor(color); }

// ====== Slash Commands ======
const COMMANDS = [
  // 1) Fine tutorial → crea item certificato_arrivo + 100euro
  new SlashCommandBuilder()
    .setName('tutorial-finish')
    .setDescription('Crea il Certificato di Arrivo e un bonus €100')
    .addStringOption(o=>o.setName('nome').setDescription('Nome RP').setRequired(true))
    .addStringOption(o=>o.setName('cognome').setDescription('Cognome RP').setRequired(true))
    .addStringOption(o=>o.setName('data_nascita').setDescription('YYYY-MM-DD').setRequired(true))
    .addStringOption(o=>o.setName('luogo_nascita').setDescription('Luogo di nascita').setRequired(true))
    .addStringOption(o=>o.setName('genere').setDescription('Genere').setRequired(true).addChoices(
      { name:'Maschio', value:'Maschio' },
      { name:'Femmina', value:'Femmina' },
      { name:'Altro',   value:'Altro' }
    )),

  // Auto-registrazione (una tantum) — dà certificato_arrivo + 100euro se mancanti
  new SlashCommandBuilder()
    .setName('municipio-self-register')
    .setDescription('Auto-registrazione una-tantum (solo per utenti già nel server)')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode del Municipio').setRequired(true))
    .addStringOption(o=>o.setName('nome').setDescription('Nome RP').setRequired(true))
    .addStringOption(o=>o.setName('cognome').setDescription('Cognome RP').setRequired(true))
    .addStringOption(o=>o.setName('data_nascita').setDescription('YYYY-MM-DD').setRequired(true))
    .addStringOption(o=>o.setName('luogo_nascita').setDescription('Luogo di nascita').setRequired(true))
    .addStringOption(o=>o.setName('genere').setDescription('Genere').setRequired(true).addChoices(
      { name:'Maschio', value:'Maschio' },
      { name:'Femmina', value:'Femmina' },
      { name:'Altro',   value:'Altro' }
    )),

  // 2) Segretario/dipendente: controlla certificato in proprio inventario
  new SlashCommandBuilder()
    .setName('municipio-cert-check')
    .setDescription('Dipendente Municipio: mostra i dati del tuo certificato_arrivo (se lo possiedi)')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode organizzazione (Municipio)').setRequired(true)),

  // 3) Registrazione ufficiale: usa certificato nell’inventario del dipendente, cambia nickname, archivia EMBED
  new SlashCommandBuilder()
    .setName('municipio-registra')
    .setDescription('Dipendente Municipio: registra cittadino usando un certificato_arrivo in tuo possesso')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode organizzazione (Municipio)').setRequired(true))
    .addUserOption(o=>o.setName('cittadino').setDescription('Utente da registrare').setRequired(true)),

  // 4) Emissione CDI come item (no PDF)
  new SlashCommandBuilder()
    .setName('cdi-emetti')
    .setDescription('Dipendente Municipio: emetti una Carta d’Identità (item cdi)')
    .addStringOption(o=>o.setName('org').setDescription('Nome o shortcode organizzazione (Municipio)').setRequired(true))
    .addUserOption(o=>o.setName('cittadino').setDescription('Utente registrato').setRequired(true)),

].map(c=>c.toJSON());

// ====== Ready ======
client.once('ready', async () => {
  console.log(`✅ Municipio attivo come ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.application.id), { body: COMMANDS });
    console.log(`Slash commands registrati: ${COMMANDS.length}`);
    console.log(`DB path: ${DB_PATH}`);
  } catch (e) {
    console.error('Command registration error:', e);
  }
});

// ====== Interaction handlers ======
client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;
    if (!i.inGuild()) return i.reply({ content:'Usa i comandi nel server.', ephemeral:true });

    const name = i.commandName;
    const guildId = i.guild.id;

    // 0) /tutorial-finish — consegna certificato_arrivo + 100euro
    if (name === 'tutorial-finish') {
      const nome = i.options.getString('nome', true).trim();
      const cognome = i.options.getString('cognome', true).trim();
      const birth_date = i.options.getString('data_nascita', true).trim();
      const birth_place = i.options.getString('luogo_nascita', true).trim();
      const gender = i.options.getString('genere', true);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birth_date))
        return i.reply({ content:'❌ data_nascita deve essere YYYY-MM-DD', ephemeral:true });

      const cf = `@${i.user.username}`;
      const id_cert = uuid();
      const issued_at = new Date().toISOString();
      const sig = crypto.createHash('sha256').update(`${i.user.id}|${issued_at}|${nome}|${cognome}`).digest('hex');

      // Arrivals (lookup)
      db.prepare(`INSERT INTO muni_arrivals (id_cert, guild_id, user_id, cf, name, surname, birth_date, birth_place, gender, issued_at, signature_hash, tutorial_version)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id_cert, guildId, i.user.id, cf, nome, cognome, birth_date, birth_place, gender, issued_at, sig, '1.0.0');

      // Items via MetroInventory
      try {
        // certificato_arrivo (UNICO)
        inv.InventoryAddUnique({
          guild_id: guildId, user_id: i.user.id, item_id: 'certificato_arrivo',
          payload_json: {
            type:'arrival_certificate',
            id_cert, cf, name:nome, surname:cognome, birth_date, birth_place, gender, issued_at,
            signature_hash: sig, tutorial_version:'1.0.0'
          }
        });
        // 100euro (stack)
        inv.InventoryAddStack({ guild_id: guildId, user_id: i.user.id, item_id: '100euro', amount: 1 });
      } catch (e) {
        await addAudit(guildId, i.user.id, 'TUTORIAL_DONE', i.user.id, { id_cert, cf, items_error: e.message });
        return i.reply({ content:'⚠️ Errore consegna oggetti. Riprova il comando.', ephemeral:true });
      }

      await addAudit(guildId, i.user.id, 'TUTORIAL_DONE', i.user.id, { id_cert, cf });

      const emb = embOk('Tutorial completato!')
        .setDescription('Hai ricevuto nell’inventario:\n• **Certificato di Arrivo** *(certificato_arrivo)*\n• **Banconota €100** *(100euro)*\n\nProssimo passo: consegna il certificato a un **dipendente del Municipio** tramite **/trade**.');
      return i.reply({ embeds:[emb], ephemeral:true });
    }

    // 1) /municipio-self-register — una tantum, consegna oggetti se non consegnati
    if (name === 'municipio-self-register') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata (Municipio).', ephemeral:true });

      const nome = i.options.getString('nome', true).trim();
      const cognome = i.options.getString('cognome', true).trim();
      const birth_date = i.options.getString('data_nascita', true).trim();
      const birth_place = i.options.getString('luogo_nascita', true).trim();
      const gender = i.options.getString('genere', true);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birth_date))
        return i.reply({ content:'❌ data_nascita deve essere YYYY-MM-DD.', ephemeral:true });

      const cf = `@${i.user.username}`;
      const reg = db.prepare(`SELECT * FROM muni_registry WHERE guild_id=? AND user_id=?`).get(guildId, i.user.id);

      if (!reg) {
        db.prepare(`INSERT INTO muni_registry (guild_id, user_id, cf, name, surname, birth_date, birth_place, gender, registered_by, grant_bonus_done)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
          .run(guildId, i.user.id, cf, nome, cognome, birth_date, birth_place, gender, i.user.id);
      } else if (reg.grant_bonus_done) {
        return i.reply({ content:'ℹ️ Sei già registrat*. Per modifiche rivolgiti al Municipio.', ephemeral:true });
      }

      // Nickname
      try { const mem = await i.guild.members.fetch(i.user.id); await mem.setNickname(`${nome} ${cognome}`, 'Self-register anagrafe'); } catch {}

      // Consegna oggetti
      try {
        const issued_at = new Date().toISOString();
        const id_cert = uuid();
        const sig = crypto.createHash('sha256').update(`${i.user.id}|${issued_at}|${nome}|${cognome}`).digest('sha256').digest('hex');
        inv.InventoryAddUnique({
          guild_id:guildId, user_id:i.user.id, item_id:'certificato_arrivo',
          payload_json:{
            type:'arrival_certificate',
            id_cert, cf, name:nome, surname:cognome, birth_date, birth_place, gender,
            issued_at, signature_hash:sig, tutorial_version:'self-1.0'
          }
        });
        inv.InventoryAddStack({ guild_id:guildId, user_id:i.user.id, item_id:'100euro', amount:1 });

        db.prepare(`UPDATE muni_registry SET grant_bonus_done=1 WHERE guild_id=? AND user_id=?`).run(guildId, i.user.id);
      } catch (e) {
        return i.reply({ content:'⚠️ Registrato, ma errore nella consegna oggetti. Ripeti il comando per ritentare.', ephemeral:true });
      }

      await addAudit(guildId, i.user.id, 'SELF_REGISTER', i.user.id, { cf, name:nome, surname:cognome });

      const emb = new EmbedBuilder()
        .setTitle('Registrazione completata')
        .setColor(0x2ecc71)
        .setDescription(
          `• Display name aggiornato a **${nome} ${cognome}**.\n` +
          `• Oggetti ricevuti: **certificato_arrivo** + **100euro**.\n` +
          `La **Carta d’Identità** verrà emessa da un dipendente del Municipio.`
        );
      return i.reply({ embeds:[emb], ephemeral:true });
    }

    // 2) /municipio-cert-check — dipendente qualsiasi
    if (name === 'municipio-cert-check') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata (Municipio).', ephemeral:true });

      if (!isMunicipioEmployee(org.id, i.user.id))
        return i.reply({ content:'❌ Devi essere un dipendente del Municipio (L1–L5).', ephemeral:true });

      const cert = inv.InventoryFindUnique(guildId, i.user.id, 'certificato_arrivo');
      if (!cert) {
        return i.reply({
          embeds:[embWarn('Nessun certificato in tuo possesso').setDescription('Ricevi il **certificato_arrivo** via /trade prima di registrare.')],
          ephemeral:true
        });
      }

      const m = cert.meta || {};
      const emb = new EmbedBuilder()
        .setTitle('Certificato in tuo possesso')
        .setColor(0xf1c40f)
        .addFields(
          { name:'ID Certificato', value: m.id_cert || '-', inline:true },
          { name:'CF', value: m.cf || '-', inline:true },
          { name:'Nome', value: m.name || '-', inline:true },
          { name:'Cognome', value: m.surname || '-', inline:true },
          { name:'Data nascita', value: m.birth_date || '-', inline:true },
          { name:'Luogo nascita', value: m.birth_place || '-', inline:true },
          { name:'Genere', value: m.gender || '-', inline:true }
        )
        .setFooter({ text:'Usa /municipio-registra per confermare e archiviare.' });

      return i.reply({ embeds:[emb], ephemeral:true });
    }

    // 3) /municipio-registra — dipendente qualsiasi
    if (name === 'municipio-registra') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });

      if (!isMunicipioEmployee(org.id, i.user.id))
        return i.reply({ content:'❌ Devi essere un dipendente del Municipio (L1–L5).', ephemeral:true });

      const target = i.options.getUser('cittadino', true);

      const cert = inv.InventoryFindUnique(guildId, i.user.id, 'certificato_arrivo');
      if (!cert) return i.reply({ content:'❌ Non hai un certificato_arrivo nel tuo inventario.', ephemeral:true });

      const meta = cert.meta || {};
      const { cf, name: nameRP, surname: surnameRP, birth_date, birth_place, gender } = meta;
      if (!(cf && nameRP && surnameRP && birth_date && birth_place && gender))
        return i.reply({ content:'❌ Certificato non valido/incompleto.', ephemeral:true });

      const targetCf = `@${target.username}`;
      if (cf !== targetCf)
        return i.reply({ content:`❌ Il CF nel certificato (${cf}) non combacia con il cittadino selezionato (${targetCf}).`, ephemeral:true });

      // Scrivi/aggiorna registro
      db.prepare(`INSERT OR REPLACE INTO muni_registry (guild_id, user_id, cf, name, surname, birth_date, birth_place, gender, registered_by, grant_bonus_done)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT grant_bonus_done FROM muni_registry WHERE guild_id=? AND user_id=?),0))`)
        .run(guildId, target.id, cf, nameRP, surnameRP, birth_date, birth_place, gender, i.user.id, guildId, target.id);

      // Archivia in canale Archivio (embed)
      try {
        const arch = await client.channels.fetch(org.archive_id);
        if (arch?.isTextBased()) {
          const embLog = new EmbedBuilder()
            .setTitle('Archivio • Registrazione Cittadino')
            .setColor(colorToInt(org.primary_color))
            .addFields(
              { name:'Cittadino', value:`<@${target.id}>`, inline:true },
              { name:'Registrato da', value:`<@${i.user.id}>`, inline:true },
              { name:'Nome RP', value:`${nameRP} ${surnameRP}`, inline:true },
              { name:'CF', value: cf, inline:true }
            ).setTimestamp(new Date());
          await arch.send({ embeds:[embLog] });
        }
      } catch {}

            // Consuma certificato dal registrante
      inv.InventoryRemoveUniqueById(guildId, i.user.id, cert.instance_id);

      // Aggiorna nickname
      try { const mem = await i.guild.members.fetch(target.id); await mem.setNickname(`${nameRP} ${surnameRP}`, 'Registrazione anagrafe'); } catch {}

      await addAudit(guildId, i.user.id, 'REGISTER_OK', target.id, { cf, name: nameRP, surname: surnameRP });

      const emb = embOk('Registrazione completata')
        .setDescription(`Display name aggiornato a **${nameRP} ${surnameRP}**.\nCertificato archiviato nel canale di Archivio.`);
      return i.reply({ embeds:[emb], ephemeral:true });
    }

    // 4) /cdi-emetti — dipendente qualsiasi
    if (name === 'cdi-emetti') {
      const ident = i.options.getString('org', true).trim();
      const org = ensureOrg(guildId, ident);
      if (!org) return i.reply({ content:'❌ Organizzazione non trovata.', ephemeral:true });

      if (!isMunicipioEmployee(org.id, i.user.id))
        return i.reply({ content:'❌ Devi essere un dipendente del Municipio (L1–L5).', ephemeral:true });

      const target = i.options.getUser('cittadino', true);
      const reg = db.prepare(`SELECT * FROM muni_registry WHERE guild_id=? AND user_id=?`).get(guildId, target.id);
      if (!reg) return i.reply({ content:'❌ Utente non presente nel registro. Esegui prima /municipio-registra.', ephemeral:true });

      const id_doc = uuid();
      const emitted_at = new Date().toISOString();

      // Salva documento CDI (solo DB)
      db.prepare(`INSERT INTO cdi_docs (id_doc, guild_id, user_id, cf, name, surname, birth_date, birth_place, gender, emitted_at, last_review_at, status, issuer)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'VALID', ?)`)
        .run(id_doc, guildId, target.id, reg.cf, reg.name, reg.surname, reg.birth_date, reg.birth_place, reg.gender, emitted_at, i.user.id);

      // Item CDI (UNICO) → nel cittadino
      try {
        inv.InventoryAddUnique({
          guild_id: guildId,
          user_id: target.id,
          item_id: 'cdi',
          payload_json: {
            type:'identity_card',
            id_doc, cf: reg.cf,
            name: reg.name, surname: reg.surname,
            birth_date: reg.birth_date, birth_place: reg.birth_place, gender: reg.gender,
            emitted_at, last_review_at: null, status:'VALID', issuer: i.user.id
          }
        });
      } catch (e) {
        await addAudit(guildId, i.user.id, 'CDI_ISSUE', target.id, { id_doc, error: e.message });
        return i.reply({ content:'❌ Errore consegna item CDI (inventario pieno?).', ephemeral:true });
      }

      // Archivio (embed)
      try {
        const arch = await client.channels.fetch(org.archive_id);
        if (arch?.isTextBased()) {
          const embLog = new EmbedBuilder()
            .setTitle('Archivio • Emissione Carta d’Identità')
            .setColor(0x16a34a)
            .addFields(
              { name:'Cittadino', value:`<@${target.id}>`, inline:true },
              { name:'ID Documento', value: id_doc, inline:true },
              { name:'Emessa da', value:`<@${i.user.id}>`, inline:true }
            ).setTimestamp(new Date());
          await arch.send({ embeds:[embLog] });
        }
      } catch {}

      await addAudit(guildId, i.user.id, 'CDI_ISSUE', target.id, { id_doc });

      const emb = embOk('Carta d’Identità emessa')
        .setDescription(`Consegnata a <@${target.id}> come item **cdi** (stato: VALID).`);
      return i.reply({ embeds:[emb], ephemeral:true });
    }
      await addAudit(guildId, i.user.id, 'CERT_TRADE', to.id, { from: from.id, to: to.id, id_cert: payload.id_cert });
      return i.reply({ embeds:[embOk('Trade simulato').setDescription(`Certificato trasferito da <@${from.id}> a <@${to.id}>.`)], ephemeral:true });
    }

  } catch (err) {
    console.error('Interaction error:', err);
    if (i.isRepliable()) {
      try { await i.reply({ content:`⚠️ Errore: ${err.message || 'inatteso'}`, ephemeral:true }); } catch {}
    }
  }
});

// ====== TUTORIAL (facoltativo) ======
db.exec(`
CREATE TABLE IF NOT EXISTS municipio_tutorial (
  user_id TEXT PRIMARY KEY,
  step INTEGER NOT NULL DEFAULT 1,
  completed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
`);

const tutorialSteps = [
  { title: 'Benvenuto a MetroLife City', desc: 'Questa è la sezione Off-RP: leggi con calma e fai domande se serve.' },
  { title: 'Regole di Base', desc: '**Metagame** no, **NoFear** sì, **Powergame** no. Segui sempre lo spirito RP.' },
  { title: 'Mondo di gioco', desc: 'Lavori, politica, FdO e crime: tutto è regolato e influenzato dai cittadini.' },
  { title: 'Dati Anagrafici', desc: 'Scegli Nome, Cognome, Data e Luogo di nascita, e Genere (Maschio/Femmina/Altro).' }
];

client.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  if (i.commandName !== 'tutorial') return;

  const row = db.prepare(`SELECT * FROM municipio_tutorial WHERE user_id=?`).get(i.user.id);
  if (row?.completed) {
    return i.reply({ content: '✅ Hai già completato il tutorial.', ephemeral: true });
  }
  const step = row?.step || 1;
  const embed = new EmbedBuilder()
    .setTitle(tutorialSteps[step-1].title)
    .setDescription(tutorialSteps[step-1].desc)
    .setColor(Colors.Blurple)
    .setFooter({ text: `Step ${step}/${tutorialSteps.length}` });

  return i.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`tutorial_next_${step}`).setLabel('Avanti').setStyle(ButtonStyle.Primary)
    )],
    ephemeral: true
  });
});

client.on('interactionCreate', async i => {
  if (!i.isButton()) return;
  if (!i.customId.startsWith('tutorial_next_')) return;

  const current = parseInt(i.customId.split('_')[2], 10);
  let next = current + 1;

  if (next > tutorialSteps.length) {
    db.prepare(`INSERT INTO municipio_tutorial (user_id, step, completed, completed_at)
                VALUES (?, ?, 1, datetime('now'))
                ON CONFLICT(user_id) DO UPDATE SET completed=1, completed_at=datetime('now')`)
      .run(i.user.id, current);
    return i.update({ content: '🎉 Tutorial completato! Ora esegui **/tutorial-finish** per ricevere certificato e 100€.', embeds: [], components: [] });
  } else {
    db.prepare(`INSERT INTO municipio_tutorial (user_id, step, completed)
                VALUES (?, ?, 0)
                ON CONFLICT(user_id) DO UPDATE SET step=?, completed=0`)
      .run(i.user.id, next, next);
    const embed = new EmbedBuilder()
      .setTitle(tutorialSteps[next-1].title)
      .setDescription(tutorialSteps[next-1].desc)
      .setColor(Colors.Blurple)
      .setFooter({ text: `Step ${next}/${tutorialSteps.length}` });
    return i.update({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`tutorial_next_${next}`).setLabel('Avanti').setStyle(ButtonStyle.Primary)
      )]
    });
  }
});

client.login(TOKEN);
