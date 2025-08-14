// metrolife-inventory.cjs — MetroLife Inventory Bot
// Inventario 10 slot, stack 16; unici (stack_max=1) con durabilità opzionale; tutto-o-niente (no drop).
// Comandi: /inventario, /item-upsert, /item-list, /inv-add, /inv-remove, /inv-move, /inv-clear, /use
// Avvio: node metrolife-inventory.cjs
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

// ================= ENV & DB PATH (coerente con metrodesk) =================
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

// ================= DB init =================
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000);

// Catalogo oggetti + inventario slot (10 slot per utente)
db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,            -- es: apple, pickaxe_proto
  name TEXT NOT NULL,             -- es: Mela
  emoji TEXT,                     -- es: 🍎
  description TEXT,
  stack_max INTEGER NOT NULL DEFAULT 16
);

CREATE TABLE IF NOT EXISTS inventory_slots (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  slot     INTEGER NOT NULL,      -- 1..10
  item_id  TEXT,                  -- NULL = vuoto
  quantity INTEGER NOT NULL DEFAULT 0,  -- per stackabili
  instance_id TEXT,               -- per unici (UUID), NULL per stackabili
  durability INTEGER,             -- opzionale
  durability_max INTEGER,         -- opzionale
  PRIMARY KEY (guild_id, user_id, slot),
  FOREIGN KEY (item_id) REFERENCES items(id) ON UPDATE CASCADE ON DELETE SET NULL
);
`);

const qGetItem = db.prepare(`SELECT * FROM items WHERE id=?`);
const qUpsertItem = db.prepare(`
INSERT INTO items (id, name, emoji, description, stack_max)
VALUES (@id, @name, @emoji, @description, @stack_max)
ON CONFLICT(id) DO UPDATE SET
  name=excluded.name,
  emoji=excluded.emoji,
  description=excluded.description,
  stack_max=excluded.stack_max
`);
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
const qClearAll = db.prepare(`
UPDATE inventory_slots
SET item_id=NULL, quantity=0, instance_id=NULL, durability=NULL, durability_max=NULL
WHERE guild_id=? AND user_id=?
`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember, Partials.User],
});

const ADMIN_CHECK = (member) =>
  member.permissions.has(PermissionFlagsBits.ManageGuild) || member.permissions.has(PermissionFlagsBits.Administrator);

const SLOTS_TOTAL = 10;

function ensureSlots(guildId, userId) {
  const rows = qGetSlots.all(guildId, userId);
  const missing = new Set(Array.from({length:SLOTS_TOTAL}, (_,i)=>i+1));
  for (const r of rows) missing.delete(r.slot);
  for (const s of missing) qInsertEmptySlot.run(guildId, userId, s);
}

function shortId(s) { return s ? s.slice(0, 6).toUpperCase() : ''; }

function getItemsMap() {
  const map = new Map();
  for (const it of qListItems.all()) map.set(it.id, it);
  return map;
}

function renderInventoryEmbed(guild, user, slots, itemsMap) {
  const grid = Array.from({length:SLOTS_TOTAL}, (_,i)=>{
    const r = slots.find(x=>x.slot===i+1);
    if (!r || !r.item_id) return '⬜';
    const it = itemsMap.get(r.item_id);
    const emoji = it?.emoji || '📦';
    if (it?.stack_max === 1) {
      const dur = (r.durability!=null && r.durability_max!=null) ? ` (${r.durability}/${r.durability_max})` : '';
      return `${emoji}#${shortId(r.instance_id)}${dur}`;
    } else {
      return `${emoji}×${r.quantity}`;
    }
  });

  const lines = [
    grid.slice(0,5).join(' | '),
    grid.slice(5,10).join(' | ')
  ];

  const emb = new EmbedBuilder()
    .setTitle(`Inventario di ${user.displayName || user.username}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Slot: 10 • Stack: 16 (default) • Unici: stack_max=1 (durabilità opzionale)' })
    .setColor(0x2b6cb0);

  const details = [];
  for (const r of slots) {
    if (!r.item_id) continue;
    const it = itemsMap.get(r.item_id);
    const name = it?.name || r.item_id;
    const emoji = it?.emoji || '📦';
    if (it?.stack_max === 1) {
      const dur = (r.durability!=null && r.durability_max!=null) ? ` • Dur: ${r.durability}/${r.durability_max}` : '';
      details.push(`S${r.slot}: ${emoji} ${name} • ID ${shortId(r.instance_id)}${dur}`);
    } else {
      details.push(`S${r.slot}: ${emoji} ${name} × ${r.quantity}`);
    }
  }
  if (details.length) emb.addFields({ name:'Dettagli', value: details.join('\n') });
  return emb;
}

// —— Logica di stacking (tutto-o-niente, no drop) ——

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
      if (free.length < qty) return { ok:false, reason:'Inventario pieno (mancano slot per oggetti unici)' };
      for (let i=0;i<qty;i++) {
        const slotNo = free[i];
        const iid = crypto.randomUUID();
        qUpdateSlot.run(item.id, 1, iid,
          durability ?? null, durabilityMax ?? null,
          guildId, userId, slotNo);
      }
      return { ok:true };
    } else {
      let remaining = qty;
      const bySlot = new Map(slots.map(s=>[s.slot, {...s}]));
      for (const s of slots) {
        if (remaining<=0) break;
        if (s.item_id === item.id && s.quantity < maxStack) {
          const can = Math.min(maxStack - s.quantity, remaining);
          s.quantity += can;
          remaining -= can;
          bySlot.set(s.slot, s);
        }
      }
      if (remaining > 0) {
        for (const s of slots) {
          if (remaining<=0) break;
          if (!s.item_id) {
            const put = Math.min(maxStack, remaining);
            s.item_id = item.id;
            s.quantity = put;
            s.instance_id = null;
            s.durability = null;
            s.durability_max = null;
            remaining -= put;
            bySlot.set(s.slot, s);
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

function removeItemsAtomic({ guildId, userId, itemId, qty }) {
  if (qty <= 0) return { ok:false, reason:'Quantità non valida' };
  const item = qGetItem.get(itemId);
  if (!item) return { ok:false, reason:'Item inesistente' };
  ensureSlots(guildId, userId);
  const slots = qGetSlots.all(guildId, userId);
  const tx = db.transaction(() => {
    if (item.stack_max === 1) {
      const having = slots.filter(s=>s.item_id===itemId).map(s=>s.slot);
      if (having.length < qty) return { ok:false, reason:'Non possiedi abbastanza esemplari' };
      for (let i=0;i<qty;i++) qClearSlot.run(guildId, userId, having[i]);
      return { ok:true };
    } else {
      let need = qty;
      const owned = slots.filter(s=>s.item_id===itemId && s.quantity>0).sort((a,b)=>a.quantity-b.quantity);
      const total = owned.reduce((acc,s)=>acc+s.quantity, 0);
      if (total < need) return { ok:false, reason:'Quantità insufficiente' };
      for (const s of owned) {
        if (need<=0) break;
        const take = Math.min(s.quantity, need);
        const newQ = s.quantity - take;
        need -= take;
        if (newQ === 0) qClearSlot.run(guildId, userId, s.slot);
        else qUpdateSlot.run(s.item_id, newQ, null, null, null, guildId, userId, s.slot);
      }
      return { ok:true };
    }
  });
  return tx();
}

// Compatta tutti gli stack di un item (riempie da slot bassi verso alti)
function compactStacks({ guildId, userId, itemId }) {
  const item = qGetItem.get(itemId);
  if (!item || item.stack_max === 1) return;
  ensureSlots(guildId, userId);
  const tx = db.transaction(() => {
    const slots = qGetSlots.all(guildId, userId);
    const owned = slots.filter(s=>s.item_id===itemId && s.quantity>0).sort((a,b)=>a.slot-b.slot);
    const total = owned.reduce((acc,s)=>acc+s.quantity, 0);
    for (const s of owned) qClearSlot.run(guildId, userId, s.slot);
    let remaining = total;
    for (const s of slots) {
      if (remaining<=0) break;
      if (!s.item_id) {
        const put = Math.min(item.stack_max, remaining);
        qUpdateSlot.run(itemId, put, null, null, null, guildId, userId, s.slot);
        remaining -= put;
      }
    }
  });
  tx();
}

// ================= Slash Commands =================
const COMMANDS = [
  // /inventario → solo il proprio (nessuna opzione)
  new SlashCommandBuilder()
    .setName('inventario')
    .setDescription('Mostra il tuo inventario (5×2)'),
  new SlashCommandBuilder()
    .setName('item-upsert')
    .setDescription('Crea/aggiorna un oggetto del catalogo (admin)')
    .addStringOption(o=>o.setName('id').setDescription('ID univoco (es: apple)').setRequired(true))
    .addStringOption(o=>o.setName('nome').setDescription('Nome visualizzato').setRequired(true))
    .addStringOption(o=>o.setName('emoji').setDescription('Emoji es: 🍎'))
    .addStringOption(o=>o.setName('descrizione').setDescription('Descrizione'))
    .addIntegerOption(o=>o.setName('stack_max').setDescription('Max per slot (1=unico, default 16)')),
  new SlashCommandBuilder()
    .setName('item-list')
    .setDescription('Elenca gli oggetti definiti nel catalogo'),
  new SlashCommandBuilder()
    .setName('inv-add')
    .setDescription('Aggiunge oggetti nell’inventario di un utente (admin)')
    .addUserOption(o=>o.setName('utente').setDescription('Utente').setRequired(true))
    .addStringOption(o=>o.setName('item_id').setDescription('ID oggetto').setRequired(true))
    .addIntegerOption(o=>o.setName('quantita').setDescription('Quantità (default 1)'))
    .addIntegerOption(o=>o.setName('durabilita').setDescription('Durabilità corrente (solo per unici, opzionale)'))
    .addIntegerOption(o=>o.setName('durabilita_max').setDescription('Durabilità massima (solo per unici, opzionale)')),
  new SlashCommandBuilder()
    .setName('inv-remove')
    .setDescription('Rimuove oggetti dall’inventario di un utente (admin)')
    .addUserOption(o=>o.setName('utente').setDescription('Utente').setRequired(true))
    .addStringOption(o=>o.setName('item_id').setDescription('ID oggetto').setRequired(true))
    .addIntegerOption(o=>o.setName('quantita').setDescription('Quantità (default 1)')),
  new SlashCommandBuilder()
    .setName('inv-move')
    .setDescription('Sposta una quantità da uno slot a un altro')
    .addIntegerOption(o=>o.setName('da').setDescription('Slot sorgente (1..10)').setRequired(true))
    .addIntegerOption(o=>o.setName('a').setDescription('Slot destinazione (1..10)').setRequired(true))
    .addIntegerOption(o=>o.setName('quantita').setDescription('Quantità (solo stackabili)'))
    .addUserOption(o=>o.setName('utente').setDescription('Utente (default: te)')),
  new SlashCommandBuilder()
    .setName('inv-clear')
    .setDescription('Svuota completamente l’inventario di un utente (admin)')
    .addUserOption(o=>o.setName('utente').setDescription('Utente').setRequired(true)),
  new SlashCommandBuilder()
    .setName('use')
    .setDescription('Usa un oggetto da uno slot (consuma quantità o durabilità)')
    .addIntegerOption(o=>o.setName('slot').setDescription('Slot (1..10)').setRequired(true))
    .addIntegerOption(o=>o.setName('quantita').setDescription('Per stackabili: default 1. Per unici: decremento durabilità')),
].map(c=>c.toJSON());

// ================= Register & handlers =================
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

    if (name === 'inventario') {
      const target = i.user; // SOLO proprio inventario
      ensureSlots(g.id, target.id);
      const slots = qGetSlots.all(g.id, target.id);
      const itemsMap = getItemsMap();
      const emb = renderInventoryEmbed(g, (await g.members.fetch(target.id)).user, slots, itemsMap);
      return i.reply({ embeds:[emb], ephemeral:true });
    }

    if (name === 'item-upsert') {
      if (!ADMIN_CHECK(i.member)) return i.reply({ content:'❌ Solo admin.', ephemeral:true });
      const id = i.options.getString('id', true).trim();
      const nome = i.options.getString('nome', true).trim();
      const emoji = i.options.getString('emoji') || null;
      const desc = i.options.getString('descrizione') || null;
      const stackMax = i.options.getInteger('stack_max') ?? 16;
      if (stackMax < 1) return i.reply({ content:'❌ stack_max deve essere ≥ 1.', ephemeral:true });
      qUpsertItem.run({ id, name:nome, emoji, description:desc, stack_max: stackMax });
      return i.reply({ content:`✅ Item **${id}** salvato: ${emoji||''} ${nome} (stack_max=${stackMax})`, ephemeral:true });
    }

    if (name === 'item-list') {
      const items = qListItems.all();
      if (!items.length) return i.reply({ content:'(vuoto) Nessun item definito.', ephemeral:true });
      const lines = items.map(it=>`• ${it.emoji||'📦'} **${it.id}** — ${it.name} (stack_max=${it.stack_max})`);
      return i.reply({ content: lines.join('\n'), ephemeral:true });
    }

    if (name === 'inv-add') {
      if (!ADMIN_CHECK(i.member)) return i.reply({ content:'❌ Solo admin.', ephemeral:true });
      const target = i.options.getUser('utente', true);
      const itemId = i.options.getString('item_id', true).trim();
      const qty = i.options.getInteger('quantita') ?? 1;
      const dur = i.options.getInteger('durabilita') ?? null;
      const durMax = i.options.getInteger('durabilita_max') ?? null;

      const res = addItemsAtomic({ guildId: g.id, userId: target.id, itemId, qty, durability: dur, durabilityMax: durMax });
      if (!res.ok) return i.reply({ content:`❌ ${res.reason}`, ephemeral:true });

      if (qGetItem.get(itemId)?.stack_max > 1) compactStacks({ guildId:g.id, userId:target.id, itemId });

      const slots = qGetSlots.all(g.id, target.id);
      const emb = renderInventoryEmbed(g, (await g.members.fetch(target.id)).user, slots, getItemsMap());
      return i.reply({ content:`✅ Aggiunti ${qty} di **${itemId}** a ${target}`, embeds:[emb], ephemeral:true });
    }

    if (name === 'inv-remove') {
      if (!ADMIN_CHECK(i.member)) return i.reply({ content:'❌ Solo admin.', ephemeral:true });
      const target = i.options.getUser('utente', true);
      const itemId = i.options.getString('item_id', true).trim();
      const qty = i.options.getInteger('quantita') ?? 1;

      const res = removeItemsAtomic({ guildId: g.id, userId: target.id, itemId, qty });
      if (!res.ok) return i.reply({ content:`❌ ${res.reason}`, ephemeral:true });

      if (qGetItem.get(itemId)?.stack_max > 1) compactStacks({ guildId:g.id, userId:target.id, itemId });

      const slots = qGetSlots.all(g.id, target.id);
      const emb = renderInventoryEmbed(g, (await g.members.fetch(target.id)).user, slots, getItemsMap());
      return i.reply({ content:`🗑️ Rimossi ${qty} di **${itemId}** da ${target}`, embeds:[emb], ephemeral:true });
    }

    if (name === 'inv-move') {
      // se specificato 'utente' e non sei tu → serve admin
      const target = i.options.getUser('utente') || i.user;
      if (target.id !== i.user.id && !ADMIN_CHECK(i.member))
        return i.reply({ content:'❌ Solo admin può spostare slot di altri.', ephemeral:true });

      const from = i.options.getInteger('da', true);
      const to   = i.options.getInteger('a', true);
      const qty  = i.options.getInteger('quantita') ?? undefined;

      const res = moveBetweenSlots({ guildId:g.id, userId:target.id, from, to, qty });
      if (!res.ok) return i.reply({ content:`❌ ${res.reason}`, ephemeral:true });

      const slots = qGetSlots.all(g.id, target.id);
      const emb = renderInventoryEmbed(g, (await g.members.fetch(target.id)).user, slots, getItemsMap());
      return i.reply({ content:`↔️ Spostato slot ${from} → ${to}${qty?` (qty ${qty})`:''}.`, embeds:[emb], ephemeral:true });
    }

    if (name === 'inv-clear') {
      if (!ADMIN_CHECK(i.member)) return i.reply({ content:'❌ Solo admin.', ephemeral:true });
      const target = i.options.getUser('utente', true);
      qClearAll.run(g.id, target.id);
      ensureSlots(g.id, target.id);
      const slots = qGetSlots.all(g.id, target.id);
      const emb = renderInventoryEmbed(g, (await g.members.fetch(target.id)).user, slots, getItemsMap());
      return i.reply({ content:`🧹 Inventario di ${target} svuotato.`, embeds:[emb], ephemeral:true });
    }

    if (name === 'use') {
      const slotNo = i.options.getInteger('slot', true);
      const amount = i.options.getInteger('quantita') ?? 1;
      if (slotNo < 1 || slotNo > 10) return i.reply({ content:'❌ Slot fuori range (1..10).', ephemeral:true });

      ensureSlots(g.id, i.user.id);
      const slots = qGetSlots.all(g.id, i.user.id);
      const s = slots.find(x=>x.slot===slotNo);
      if (!s || !s.item_id) return i.reply({ content:'❌ Lo slot è vuoto.', ephemeral:true });

      const item = qGetItem.get(s.item_id);
      if (!item) return i.reply({ content:'❌ Item non trovato nel catalogo.', ephemeral:true });

      if (item.stack_max === 1) {
        if (s.durability==null || s.durability_max==null)
          return i.reply({ content:'❌ Questo oggetto non ha durabilità e non può essere usato.', ephemeral:true });
        const dec = Math.max(1, amount);
        const newDur = Math.max(0, s.durability - dec);
        if (newDur === 0) {
          qClearSlot.run(g.id, i.user.id, slotNo);
          return i.reply({ content:`🛠️ L’oggetto si è rotto (durabilità 0).`, ephemeral:true });
        } else {
          qUpdateSlot.run(s.item_id, 1, s.instance_id, newDur, s.durability_max, g.id, i.user.id, slotNo);
          return i.reply({ content:`🛠️ Durabilità: ${newDur}/${s.durability_max}.`, ephemeral:true });
        }
      } else {
        const dec = Math.max(1, amount);
        if (s.quantity < dec) return i.reply({ content:`❌ Quantità insufficiente (hai ${s.quantity}).`, ephemeral:true });

        const newQ = s.quantity - dec;
        if (newQ === 0) qClearSlot.run(g.id, i.user.id, slotNo);
        else qUpdateSlot.run(s.item_id, newQ, null, null, null, g.id, i.user.id, slotNo);

        compactStacks({ guildId:g.id, userId:i.user.id, itemId: s.item_id });

        const emb = renderInventoryEmbed(g, (await g.members.fetch(i.user.id)).user, qGetSlots.all(g.id, i.user.id), getItemsMap());
        return i.reply({ content:`✅ Usato ${dec} × ${item.name}.`, embeds:[emb], ephemeral:true });
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    if (i.isRepliable()) {
      try { await i.reply({ content:'⚠️ Errore inatteso.', ephemeral:true }); } catch {}
    }
  }
});

// —— Move tra slot (riusa sopra) ——
function moveBetweenSlots({ guildId, userId, from, to, qty }) {
  if (from===to) return { ok:false, reason:'Slot identici' };
  if (from<1 || from>10 || to<1 || to>10) return { ok:false, reason:'Slot fuori range' };
  ensureSlots(guildId, userId);
  const slots = qGetSlots.all(guildId, userId);
  const sFrom = slots.find(s=>s.slot===from);
  const sTo   = slots.find(s=>s.slot===to);
  if (!sFrom || !sFrom.item_id) return { ok:false, reason:'Slot sorgente vuoto' };

  const item = qGetItem.get(sFrom.item_id);
  const maxStack = item?.stack_max || 16;

  const tx = db.transaction(() => {
    if (maxStack === 1) {
      if (sTo.item_id) return { ok:false, reason:'Slot destinazione occupato' };
      qUpdateSlot.run(sFrom.item_id, 1, sFrom.instance_id, sFrom.durability, sFrom.durability_max, sFrom.guild_id, sFrom.user_id, to);
      qClearSlot.run(sFrom.guild_id, sFrom.user_id, from);
      return { ok:true };
    } else {
      const moveQty = Math.max(1, Math.min(qty ?? sFrom.quantity, sFrom.quantity));
      if (!sTo.item_id) {
        qUpdateSlot.run(sFrom.item_id, moveQty, null, null, null, sFrom.guild_id, sFrom.user_id, to);
        const rem = sFrom.quantity - moveQty;
        if (rem===0) qClearSlot.run(sFrom.guild_id, sFrom.user_id, from);
        else qUpdateSlot.run(sFrom.item_id, rem, null, null, null, sFrom.guild_id, sFrom.user_id, from);
        return { ok:true };
      }
      if (sTo.item_id === sFrom.item_id) {
        const can = Math.min(maxStack - sTo.quantity, moveQty);
        if (can<=0) return { ok:false, reason:'Stack destinazione pieno' };
        qUpdateSlot.run(sTo.item_id, sTo.quantity + can, null, null, null, sTo.guild_id, sTo.user_id, to);
        const rem = sFrom.quantity - can;
        if (rem===0) qClearSlot.run(sFrom.guild_id, sFrom.user_id, from);
        else qUpdateSlot.run(sFrom.item_id, rem, null, null, null, sFrom.guild_id, sFrom.user_id, from);
        return { ok:true };
      }
      return { ok:false, reason:'Slot destinazione occupato da altro oggetto' };
    }
  });

  return tx();
}

client.login(TOKEN);
