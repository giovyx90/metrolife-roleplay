// metrolife-trade.cjs — MetroLife Trade Bot (escrow 2 fasi, all-or-nothing, no drop)
// Comandi: /trade-open, /trade-offer-add, /trade-offer-remove, /trade-offer-list, /trade-ready, /trade-confirm, /trade-cancel, /trade-info
// Avvio: node metrolife-trade.cjs
// ENV: DISCORD_TOKEN (obbligatorio), DB_PATH (opzionale; default: ../metrocity.db)
// Dep: npm i discord.js better-sqlite3 dotenv

require('dotenv').config();

const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder
} = require('discord.js');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('❌ Manca DISCORD_TOKEN nel .env'); process.exit(1); }

function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  const parent = path.resolve(process.cwd(), '..', 'metrocity.db');
  const here   = path.resolve(process.cwd(), 'metrocity.db');
  if (fs.existsSync(parent)) return parent;
  return parent;
}
const DB_PATH = resolveDbPath();

// DB
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// TABELLE INVENTARIO già presenti (items, inventory_slots).
// TABELLE TRADE
db.exec(`
CREATE TABLE IF NOT EXISTS trade_sessions (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  a_id TEXT NOT NULL,
  b_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'CREATED', -- CREATED | LOCKED | FINALIZED | CANCELLED
  a_ready INTEGER NOT NULL DEFAULT 0,
  b_ready INTEGER NOT NULL DEFAULT 0,
  a_confirm INTEGER NOT NULL DEFAULT 0,
  b_confirm INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trade_offers (
  session_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  PRIMARY KEY (session_id, from_user_id, item_id),
  FOREIGN KEY (session_id) REFERENCES trade_sessions(id) ON DELETE CASCADE
);

-- Oggetti spostati in escrow (tolti dall'inventario durante LOCKED)
CREATE TABLE IF NOT EXISTS trade_escrow (
  session_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,  -- stackabili: quantità
  instance_id TEXT,                     -- unici: se valorizzato, quantity deve essere 1
  durability INTEGER,
  durability_max INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trade_escrow_sess ON trade_escrow(session_id);
`);

const qGetItem = db.prepare(`SELECT * FROM items WHERE id=?`);
const qListItems = db.prepare(`SELECT * FROM items ORDER BY id`);
const qGetSlots = db.prepare(`SELECT * FROM inventory_slots WHERE guild_id=? AND user_id=? ORDER BY slot`);
const qInsertEmptySlot = db.prepare(`
INSERT INTO inventory_slots (guild_id, user_id, slot, item_id, quantity, instance_id, durability, durability_max)
VALUES (?, ?, ?, NULL, 0, NULL, NULL, NULL)
`);
const qUpdateSlot = db.prepare(`
UPDATE inventory_slots
SET item_id=?, quantity=?, instance_id=?, durability=?, durability_max=?
WHERE guild_id=? AND user_id=? AND slot=?
`);
const qClearSlot = db.prepare(`
UPDATE inventory_slots
SET item_id=NULL, quantity=0, instance_id=NULL, durability=NULL, durability_max=NULL
WHERE guild_id=? AND user_id=? AND slot=?
`);

const qCreateSession = db.prepare(`
INSERT INTO trade_sessions (id, guild_id, a_id, b_id) VALUES (?, ?, ?, ?)
`);

const qFindActiveForUser = db.prepare(`
SELECT * FROM trade_sessions
WHERE guild_id=? AND status IN ('CREATED','LOCKED') AND (a_id=? OR b_id=?)
`);

const qGetSession = db.prepare(`SELECT * FROM trade_sessions WHERE id=?`);
const qSetStatus = db.prepare(`UPDATE trade_sessions SET status=?, updated_at=datetime('now') WHERE id=?`);
const qSetReady = db.prepare(`
UPDATE trade_sessions
SET a_ready = CASE WHEN a_id=? THEN ? ELSE a_ready END,
    b_ready = CASE WHEN b_id=? THEN ? ELSE b_ready END,
    updated_at=datetime('now')
WHERE id=?
`);
const qResetReadyAndConfirm = db.prepare(`
UPDATE trade_sessions SET a_ready=0, b_ready=0, a_confirm=0, b_confirm=0, updated_at=datetime('now') WHERE id=?
`);
const qConfirm = db.prepare(`
UPDATE trade_sessions
SET a_confirm = CASE WHEN a_id=? THEN 1 ELSE a_confirm END,
    b_confirm = CASE WHEN b_id=? THEN 1 ELSE b_confirm END,
    updated_at=datetime('now')
WHERE id=?
`);

const qOfferUpsert = db.prepare(`
INSERT INTO trade_offers (session_id, from_user_id, item_id, quantity)
VALUES (?, ?, ?, ?)
ON CONFLICT(session_id, from_user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity
`);
const qOfferRemove = db.prepare(`
UPDATE trade_offers SET quantity = quantity - ?
WHERE session_id=? AND from_user_id=? AND item_id=?
`);
const qOfferCleanupZero = db.prepare(`
DELETE FROM trade_offers WHERE session_id=? AND quantity <= 0
`);
const qGetOffers = db.prepare(`SELECT * FROM trade_offers WHERE session_id=? ORDER BY from_user_id, item_id`);

const qEscrowInsert = db.prepare(`
INSERT INTO trade_escrow (session_id, from_user_id, item_id, quantity, instance_id, durability, durability_max)
VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const qEscrowBySession = db.prepare(`SELECT * FROM trade_escrow WHERE session_id=?`);
const qEscrowDeleteSession = db.prepare(`DELETE FROM trade_escrow WHERE session_id=?`);

function ensureSlots(guildId, userId) {
  const rows = qGetSlots.all(guildId, userId);
  const missing = new Set(Array.from({length:10}, (_,i)=>i+1));
  for (const r of rows) missing.delete(r.slot);
  for (const s of missing) qInsertEmptySlot.run(guildId, userId, s);
}

function getItemsMap() {
  const map = new Map();
  for (const it of qListItems.all()) map.set(it.id, it);
  return map;
}

// ====== Algoritmi inventario (duplicati qui per indipendenza dal bot inventario) ======

function addItemsAtomic({ guildId, userId, itemId, qty, durability, durabilityMax }) {
  if (qty <= 0) return { ok:false, reason:'Quantità non valida' };
  const item = qGetItem.get(itemId);
  if (!item) return { ok:false, reason:'Item inesistente' };

  ensureSlots(guildId, userId);
  const slots = qGetSlots.all(guildId, userId);
  const maxStack = item.stack_max || 16;

  const tx = db.transaction(() => {
    if (maxStack === 1) {
      const free = slots.filter(s=>!s.item_id).map(s=>s.slot);
      if (free.length < qty) return { ok:false, reason:'Inventario pieno (slot unici insufficienti)' };
      for (let i=0;i<qty;i++) {
        const slotNo = free[i];
        const iid = crypto.randomUUID();
        qUpdateSlot.run(item.id, 1, iid, durability ?? null, durabilityMax ?? null, guildId, userId, slotNo);
      }
      return { ok:true };
    } else {
      let remaining = qty;
      const bySlot = new Map(slots.map(s=>[s.slot, {...s}]));
      for (const s of slots) {
        if (remaining<=0) break;
        if (s.item_id === item.id && s.quantity < maxStack) {
          const can = Math.min(maxStack - s.quantity, remaining);
          s.quantity += can; remaining -= can; bySlot.set(s.slot, s);
        }
      }
      if (remaining > 0) {
        for (const s of slots) {
          if (remaining<=0) break;
          if (!s.item_id) {
            const put = Math.min(maxStack, remaining);
            s.item_id = item.id; s.quantity = put;
            s.instance_id = null; s.durability = null; s.durability_max = null;
            remaining -= put; bySlot.set(s.slot, s);
          }
        }
      }
      if (remaining > 0) return { ok:false, reason:'Inventario pieno (slot insufficienti per lo stack)' };
      for (const s of bySlot.values()) {
        qUpdateSlot.run(s.item_id, s.quantity, s.instance_id, s.durability, s.durability_max, guildId, userId, s.slot);
      }
      return { ok:true };
    }
  });

  return tx();
}

// Dry-run: verifica se TUTTI gli oggetti possono entrare
function canReceiveAll({ guildId, userId, incoming }) {
  ensureSlots(guildId, userId);
  const slots = qGetSlots.all(guildId, userId).map(s=>({...s}));
  const itemsMap = getItemsMap();

  // Clona stato locale e simula
  const findFreeSlots = () => slots.filter(s=>!s.item_id);
  const applyStackable = (itemId, qty) => {
    const it = itemsMap.get(itemId); const max = it?.stack_max || 16;
    if (max === 1) return false;
    let remaining = qty;
    for (const s of slots) {
      if (remaining<=0) break;
      if (s.item_id === itemId && s.quantity < max) {
        const can = Math.min(max - s.quantity, remaining);
        s.quantity += can; remaining -= can;
      }
    }
    if (remaining > 0) {
      for (const s of slots) {
        if (remaining<=0) break;
        if (!s.item_id) {
          const put = Math.min(max, remaining);
          s.item_id = itemId; s.quantity = put;
          s.instance_id = null; s.durability = null; s.durability_max = null;
          remaining -= put;
        }
      }
    }
    return remaining === 0;
  };

  // Prima assegna gli unici (occupano slot interi)
  const uniques = [];
  const stacks = new Map();
  for (const x of incoming) {
    const it = itemsMap.get(x.item_id);
    if (!it) return false;
    if (it.stack_max === 1) {
      // x.quantity è il numero di esemplari
      for (let k=0;k<x.quantity;k++) uniques.push(x);
    } else {
      stacks.set(x.item_id, (stacks.get(x.item_id)||0) + x.quantity);
    }
  }
  // Unici: servono N slot liberi
  const freeCount = findFreeSlots().length;
  if (freeCount < uniques.length) return false;
  // Riserva virtualmente slot per unici
  let toReserve = uniques.length;
  for (const s of slots) {
    if (toReserve<=0) break;
    if (!s.item_id) { s.item_id = '__RESERVED__'; toReserve--; }
  }
  // Stackabili
  for (const [itemId, qty] of stacks.entries()) {
    if (!applyStackable(itemId, qty)) return false;
  }
  return true;
}

// Rimuove da inventario verso ESCROW (per un offerente); tutto in transaction
function moveOfferToEscrow({ sessionId, guildId, fromUserId, offers }) {
  const tx = db.transaction(() => {
    const itemsMap = getItemsMap();
    const slots = qGetSlots.all(guildId, fromUserId);

    // 1) Verifica disponibilità
    for (const off of offers) {
      const it = itemsMap.get(off.item_id);
      if (!it) return { ok:false, reason:`Item inesistente: ${off.item_id}` };
      if (it.stack_max === 1) {
        const have = slots.filter(s=>s.item_id===off.item_id).length;
        if (have < off.quantity) return { ok:false, reason:`Oggetti unici insufficienti: ${off.item_id}` };
      } else {
        const have = slots.filter(s=>s.item_id===off.item_id).reduce((a,s)=>a+s.quantity,0);
        if (have < off.quantity) return { ok:false, reason:`Quantità insufficiente: ${off.item_id}` };
      }
    }

    // 2) Sposta in escrow e rimuovi dall'inventario
    for (const off of offers) {
      const it = itemsMap.get(off.item_id);
      if (it.stack_max === 1) {
        let need = off.quantity;
        for (const s of slots) {
          if (need<=0) break;
          if (s.item_id === off.item_id && s.instance_id) {
            qEscrowInsert.run(sessionId, fromUserId, s.item_id, 1, s.instance_id, s.durability, s.durability_max);
            qClearSlot.run(guildId, fromUserId, s.slot);
            s.item_id = null; s.instance_id = null; s.quantity = 0; s.durability=null; s.durability_max=null;
            need--;
          }
        }
      } else {
        let need = off.quantity;
        // ordina per stack piccoli → svuota prima i parziali
        const stacks = slots.filter(s=>s.item_id===off.item_id && s.quantity>0).sort((a,b)=>a.quantity-b.quantity);
        for (const s of stacks) {
          if (need<=0) break;
          const take = Math.min(need, s.quantity);
          qEscrowInsert.run(sessionId, fromUserId, off.item_id, take, null, null, null);
          const newQ = s.quantity - take;
          need -= take;
          if (newQ===0) { qClearSlot.run(guildId, fromUserId, s.slot); s.item_id=null; s.quantity=0; }
          else { qUpdateSlot.run(s.item_id, newQ, null, null, null, guildId, fromUserId, s.slot); s.quantity=newQ; }
        }
        if (need>0) return { ok:false, reason:`Errore interno escrow per ${off.item_id}` };
      }
    }
    return { ok:true };
  });
  return tx();
}

// Aggiunge dal gruppo ESCROW al destinatario
function deliverEscrowTo({ sessionId, guildId, toUserId, fromUserId }) {
  const rows = qEscrowBySession.all(sessionId).filter(e=>e.from_user_id===fromUserId);
  const tx = db.transaction(() => {
    // prepariamo incoming aggregati per canReceiveAll
    const agg = new Map(); // item_id -> count (unici contati come N esemplari)
    for (const e of rows) {
      const key = e.item_id;
      if (e.instance_id) agg.set(key, (agg.get(key)||0) + 1);
      else agg.set(key, (agg.get(key)||0) + e.quantity);
    }
    const incoming = Array.from(agg.entries()).map(([item_id, quantity])=>({ item_id, quantity }));
    if (!canReceiveAll({ guildId, userId: toUserId, incoming })) return { ok:false, reason:'Spazio inventario insufficiente al destinatario' };

    // inserisci
    for (const e of rows) {
      if (e.instance_id) {
        // unico: serve slot libero
        ensureSlots(guildId, toUserId);
        const slots = qGetSlots.all(guildId, toUserId);
        const free = slots.find(s=>!s.item_id);
        if (!free) return { ok:false, reason:'Slot libero mancante per un oggetto unico' };
        qUpdateSlot.run(e.item_id, 1, e.instance_id, e.durability, e.durability_max, guildId, toUserId, free.slot);
      } else {
        const res = addItemsAtomic({ guildId, userId: toUserId, itemId: e.item_id, qty: e.quantity });
        if (!res.ok) return { ok:false, reason: res.reason || 'Errore inserimento stack' };
      }
    }
    return { ok:true };
  });
  return tx();
}

function renderTradeEmbed(sess, offers, users, itemsMap) {
  const a = users.get(sess.a_id), b = users.get(sess.b_id);
  const aList = offers.filter(o=>o.from_user_id===sess.a_id);
  const bList = offers.filter(o=>o.from_user_id===sess.b_id);
  const fmt = (arr) => arr.length ? arr.map(o=>{
    const it = itemsMap.get(o.item_id);
    const em = it?.emoji || '📦';
    return `${em} ${it?.name||o.item_id} × ${o.quantity}`;
  }).join('\n') : '—';
  const emb = new EmbedBuilder()
    .setTitle(`Trade #${sess.id.slice(0,6).toUpperCase()} — ${a?.displayName||'A'} ↔ ${b?.displayName||'B'}`)
    .addFields(
      { name:`Offerta di ${a?.displayName||'A'}`, value: fmt(aList), inline:true },
      { name:`Offerta di ${b?.displayName||'B'}`, value: fmt(bList), inline:true },
    )
    .addFields(
      { name:'Stato', value: `**${sess.status}** • A_ready:${sess.a_ready} • B_ready:${sess.b_ready} • A_conf:${sess.a_confirm} • B_conf:${sess.b_confirm}` }
    )
    .setColor(sess.status==='LOCKED'?0xd69e2e: sess.status==='FINALIZED'?0x38a169: sess.status==='CANCELLED'?0xe53e3e: 0x2b6cb0);
  return emb;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember, Partials.User],
});

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('trade-open')
    .setDescription('Apri una sessione di scambio con un utente')
    .addUserOption(o=>o.setName('utente').setDescription('Partner di scambio').setRequired(true)),

  // REQUIRED prima (item_id), poi opzionali (quantita, sessione)
  new SlashCommandBuilder()
    .setName('trade-offer-add')
    .setDescription('Aggiunge alla tua offerta un item (quantità cumulativa)')
    .addStringOption(o=>o.setName('item_id').setDescription('ID oggetto').setRequired(true))
    .addIntegerOption(o=>o.setName('quantita').setDescription('Quantità (default 1)'))
    .addStringOption(o=>o.setName('sessione').setDescription('ID trade (se hai più trade aperti)')),

  // REQUIRED prima (item_id), poi opzionali (quantita, sessione)
  new SlashCommandBuilder()
    .setName('trade-offer-remove')
    .setDescription('Rimuove quantità dalla tua offerta')
    .addStringOption(o=>o.setName('item_id').setDescription('ID oggetto').setRequired(true))
    .addIntegerOption(o=>o.setName('quantita').setDescription('Quantità (default 1)'))
    .addStringOption(o=>o.setName('sessione').setDescription('ID trade (se hai più trade aperti)')),

  new SlashCommandBuilder()
    .setName('trade-offer-list')
    .setDescription('Mostra offerte correnti')
    .addStringOption(o=>o.setName('sessione').setDescription('ID trade')),

  new SlashCommandBuilder()
    .setName('trade-ready')
    .setDescription('Segnala che sei pronto a bloccare le offerte (escrow)')
    .addStringOption(o=>o.setName('sessione').setDescription('ID trade')),

  new SlashCommandBuilder()
    .setName('trade-confirm')
    .setDescription('Conferma finale (dopo il lock)')
    .addStringOption(o=>o.setName('sessione').setDescription('ID trade')),

  new SlashCommandBuilder()
    .setName('trade-cancel')
    .setDescription('Annulla il trade (sblocca eventuale escrow)')
    .addStringOption(o=>o.setName('sessione').setDescription('ID trade')),

  new SlashCommandBuilder()
    .setName('trade-info')
    .setDescription('Dettagli della sessione')
    .addStringOption(o=>o.setName('sessione').setDescription('ID trade')),
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

client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;
    if (!i.inGuild()) return i.reply({ content:'Usa i comandi in un server.', ephemeral:true });

    const g = i.guild;
    const name = i.commandName;

    const itemsMap = getItemsMap();
    const users = new Map();
    const fetchUser = async (uid) => {
      if (users.has(uid)) return users.get(uid);
      const m = await g.members.fetch(uid).catch(()=>null);
      if (m) users.set(uid, m.user);
      return m?.user;
    };

    function pickSessionFor(userId, explicitId) {
      if (explicitId) return qGetSession.get(explicitId);
      return qFindActiveForUser.get(g.id, userId, userId);
    }

    if (name === 'trade-open') {
      const other = i.options.getUser('utente', true);
      if (other.id === i.user.id) return i.reply({ content:'❌ Non puoi aprire un trade con te stess*.', ephemeral:true });

      // impedisci più trade attivi per utente
      if (qFindActiveForUser.get(g.id, i.user.id, i.user.id))
        return i.reply({ content:'❌ Hai già un trade attivo.', ephemeral:true });
      if (qFindActiveForUser.get(g.id, other.id, other.id))
        return i.reply({ content:'❌ L’altro utente ha già un trade attivo.', ephemeral:true });

      const id = crypto.randomUUID();
      qCreateSession.run(id, g.id, i.user.id, other.id);
      const sess = qGetSession.get(id);
      const emb = renderTradeEmbed(sess, [], users, itemsMap);
      return i.reply({ content:`📦 Trade creato con ${other}. ID: \`${id}\``, embeds:[emb], ephemeral:true });
    }

    if (name === 'trade-offer-add') {
      const sess = pickSessionFor(i.user.id, i.options.getString('sessione') || undefined);
      if (!sess) return i.reply({ content:'❌ Nessun trade attivo trovato.', ephemeral:true });
      if (sess.status !== 'CREATED') return i.reply({ content:'❌ Non si possono modificare le offerte in questo stato.', ephemeral:true });
      const itemId = i.options.getString('item_id', true).trim();
      const qty = i.options.getInteger('quantita') ?? 1;
      const it = qGetItem.get(itemId);
      if (!it) return i.reply({ content:'❌ Item inesistente.', ephemeral:true });
      if (qty <= 0) return i.reply({ content:'❌ Quantità non valida.', ephemeral:true });

      const from = i.user.id;
      qOfferUpsert.run(sess.id, from, itemId, qty);
      const offers = qGetOffers.all(sess.id);
      const emb = renderTradeEmbed(sess, offers, users, itemsMap);
      return i.reply({ content:`✅ Aggiunta offerta: ${it.emoji||'📦'} ${it.name} × ${qty}`, embeds:[emb], ephemeral:true });
    }

    if (name === 'trade-offer-remove') {
      const sess = pickSessionFor(i.user.id, i.options.getString('sessione') || undefined);
      if (!sess) return i.reply({ content:'❌ Nessun trade attivo trovato.', ephemeral:true });
      if (sess.status !== 'CREATED') return i.reply({ content:'❌ Non si possono modificare le offerte in questo stato.', ephemeral:true });
      const itemId = i.options.getString('item_id', true).trim();
      const qty = i.options.getInteger('quantita') ?? 1;

      qOfferRemove.run(qty, sess.id, i.user.id, itemId);
      qOfferCleanupZero.run(sess.id);
      const offers = qGetOffers.all(sess.id);
      const emb = renderTradeEmbed(sess, offers, users, itemsMap);
      return i.reply({ content:`✂️ Rimosso dalla tua offerta: ${itemId} × ${qty}`, embeds:[emb], ephemeral:true });
    }

    if (name === 'trade-offer-list' || name === 'trade-info') {
      const sess = pickSessionFor(i.user.id, i.options.getString('sessione') || undefined);
      if (!sess) return i.reply({ content:'❌ Nessun trade attivo trovato.', ephemeral:true });
      const offers = qGetOffers.all(sess.id);
      const emb = renderTradeEmbed(sess, offers, users, itemsMap);
      return i.reply({ embeds:[emb], ephemeral:true });
    }

    if (name === 'trade-ready') {
      const sess = pickSessionFor(i.user.id, i.options.getString('sessione') || undefined);
      if (!sess) return i.reply({ content:'❌ Nessun trade attivo trovato.', ephemeral:true });
      if (sess.status !== 'CREATED') return i.reply({ content:'❌ Stato non valido per il ready.', ephemeral:true });

      // set ready=true per caller
      const isA = sess.a_id === i.user.id;
      qSetReady.run(sess.a_id, isA?1:sess.a_ready, sess.b_id, isA?sess.b_ready:1, sess.id);
      const refreshed = qGetSession.get(sess.id);

      // se entrambi ready → tenta LOCK
      if (refreshed.a_ready && refreshed.b_ready) {
        // prendi offerte di A e B
        const offers = qGetOffers.all(refreshed.id);
        const aOffers = offers.filter(o=>o.from_user_id===refreshed.a_id);
        const bOffers = offers.filter(o=>o.from_user_id===refreshed.b_id);

        // move to escrow
        const escA = moveOfferToEscrow({ sessionId: refreshed.id, guildId:g.id, fromUserId: refreshed.a_id, offers: aOffers });
        const escB = moveOfferToEscrow({ sessionId: refreshed.id, guildId:g.id, fromUserId: refreshed.b_id, offers: bOffers });

        if (!escA.ok || !escB.ok) {
          // rollback qualsiasi escrow già creato
          rollbackEscrowToOwners(refreshed.id, g.id);
          qResetReadyAndConfirm.run(refreshed.id);
          const reason = escA.ok ? escB.reason : escA.reason;
          const emb = renderTradeEmbed(qGetSession.get(refreshed.id), offers, users, itemsMap);
          return i.reply({ content:`❌ Lock fallito: ${reason}`, embeds:[emb], ephemeral:true });
        }

        qSetStatus.run('LOCKED', refreshed.id);
        const emb = renderTradeEmbed(qGetSession.get(refreshed.id), offers, users, itemsMap);
        return i.reply({ content:'🔒 Offerte bloccate in escrow. Usate /trade-confirm per finalizzare.', embeds:[emb], ephemeral:true });
      }

      const offers = qGetOffers.all(sess.id);
      const emb = renderTradeEmbed(qGetSession.get(sess.id), offers, users, itemsMap);
      return i.reply({ content:'👍 Pront*.', embeds:[emb], ephemeral:true });
    }

    if (name === 'trade-confirm') {
      const sess = pickSessionFor(i.user.id, i.options.getString('sessione') || undefined);
      if (!sess) return i.reply({ content:'❌ Nessun trade attivo trovato.', ephemeral:true });
      if (sess.status !== 'LOCKED') return i.reply({ content:'❌ Puoi confermare solo quando il trade è LOCKED.', ephemeral:true });

      qConfirm.run(sess.a_id, sess.b_id, sess.id);
      const refreshed = qGetSession.get(sess.id);

      if (refreshed.a_confirm && refreshed.b_confirm) {
        // Finalizza: verifica capienza destinatari
        const okA = deliverEscrowTo({ sessionId: refreshed.id, guildId:g.id, toUserId: refreshed.a_id, fromUserId: refreshed.b_id });
        const okB = deliverEscrowTo({ sessionId: refreshed.id, guildId:g.id, toUserId: refreshed.b_id, fromUserId: refreshed.a_id });

        if (!okA.ok || !okB.ok) {
          rollbackEscrowToOwners(refreshed.id, g.id);
          qSetStatus.run('CANCELLED', refreshed.id);
          const reason = !okA.ok ? okA.reason : okB.reason;
          const emb = renderTradeEmbed(qGetSession.get(refreshed.id), qGetOffers.all(refreshed.id), users, itemsMap);
          return i.reply({ content:`❌ Finalizzazione fallita: ${reason}. Trade annullato.`, embeds:[emb], ephemeral:true });
        }

        qEscrowDeleteSession.run(refreshed.id);
        qSetStatus.run('FINALIZED', refreshed.id);
        const emb = renderTradeEmbed(qGetSession.get(refreshed.id), qGetOffers.all(refreshed.id), users, itemsMap);
        return i.reply({ content:'✅ Trade completato.', embeds:[emb], ephemeral:true });
      }

      const emb = renderTradeEmbed(refreshed, qGetOffers.all(refreshed.id), users, itemsMap);
      return i.reply({ content:'☑️ Confermato. In attesa dell’altro utente.', embeds:[emb], ephemeral:true });
    }

    if (name === 'trade-cancel') {
      const sess = pickSessionFor(i.user.id, i.options.getString('sessione') || undefined);
      if (!sess) return i.reply({ content:'❌ Nessun trade attivo trovato.', ephemeral:true });
      if (sess.status === 'FINALIZED' || sess.status === 'CANCELLED')
        return i.reply({ content:`ℹ️ Il trade è già ${sess.status}.`, ephemeral:true });

      rollbackEscrowToOwners(sess.id, g.id);
      qSetStatus.run('CANCELLED', sess.id);
      return i.reply({ content:'🛑 Trade annullato.', ephemeral:true });
    }

  } catch (err) {
    console.error('Trade interaction error:', err);
    if (i.isRepliable()) {
      try { await i.reply({ content:'⚠️ Errore inatteso.', ephemeral:true }); } catch {}
    }
  }
});

// Ritorna l'escrow agli owner (su cancel/fail)
function rollbackEscrowToOwners(sessionId, guildId) {
  const rows = qEscrowBySession.all(sessionId);
  const tx = db.transaction(() => {
    for (const e of rows) {
      if (e.instance_id) {
        // unico → re-inserisci come oggetto unico
        ensureSlots(guildId, e.from_user_id);
        const slots = qGetSlots.all(guildId, e.from_user_id);
        const free = slots.find(s=>!s.item_id);
        if (!free) throw new Error('Rollback: slot mancante per unico'); // non dovrebbe accadere
        qUpdateSlot.run(e.item_id, 1, e.instance_id, e.durability, e.durability_max, guildId, e.from_user_id, free.slot);
      } else if (e.quantity>0) {
        const res = addItemsAtomic({ guildId, userId:e.from_user_id, itemId:e.item_id, qty:e.quantity });
        if (!res.ok) throw new Error('Rollback addItemsAtomic fallito');
      }
    }
    qEscrowDeleteSession.run(sessionId);
  });
  tx();
}

client.login(TOKEN);
