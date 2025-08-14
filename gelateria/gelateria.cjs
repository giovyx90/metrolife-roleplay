// gelateria.cjs — Gelateria Vanillatte
// Comandi IT + Scontrino HTML dinamico (rosa/bianco/crema)
// Dipendenze: npm i discord.js better-sqlite3 dotenv
// ENV: DISCORD_TOKEN, DB_PATH, APP_NAME, ORG_ID

require('dotenv').config();
const path = require('path');
const Database = require('better-sqlite3');
const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, AttachmentBuilder
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) { console.error('Manca DISCORD_TOKEN'); process.exit(1); }
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../metrocity.db');
const APP_NAME = process.env.APP_NAME || 'Gelateria Vanillatte';
const ORG_ID   = process.env.ORG_ID   || 'Gelateria';

const EXPIRY_MS_DEFAULT = 14*24*60*60*1000; // 14 giorni
const EXPIRY_SOON_MS    = 48*60*60*1000;    // 48h
const SLOT_COUNT = 50;
const STACK_SIZE = 16;

const DEFAULT_COOK_MAX = 2;
const DEFAULT_STATION_MAX = 4;
const DEFAULT_SCOOP_ML = 70;

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
const now = () => Date.now();
const d = (ts) => new Date(ts).toISOString().slice(0,10);
const todayStr = () => new Date().toISOString().slice(0,10);

// --- Tabelle gelateria esistenti ---
const GEL = {
  items:  'gel_items',
  lots:   'gel_lots',
  moves:  'gel_stock_moves',
  show:   'gel_showcase_slots',
  menu:   'gel_menu_items',
  mcomps: 'gel_menu_components',
  cmap:   'gel_components_map',
  ktix:   'gel_kitchen_tickets',
  kcons:  'gel_ticket_consumptions'
};
function tableExists(name){ try { db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get(); return true; } catch { return false; } }
function requireTables(names){
  for (const t of names){ if (!tableExists(t)) throw new Error(`Tabella mancante: ${t}. Esegui il seed o correggi i nomi.`); }
}
requireTables([GEL.items,GEL.lots,GEL.moves,GEL.show,GEL.menu,GEL.mcomps,GEL.cmap,GEL.ktix,GEL.kcons,'warehouse_slots','warehouse_items','inventory_slots','kitchen_config','economy_config','intake_log']);

const { listPlayerSlots, InventoryAddStack, InventoryRemoveStack, updatePlayerSlot } = require('../inventory-core.cjs')(db);

// --- Tabelle SCONTRINO (nuove, se mancanti) ---
db.exec(`
CREATE TABLE IF NOT EXISTS receipts(
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  customer_id TEXT,
  customer_name TEXT,
  payment_method TEXT NOT NULL,  -- CARTA | CONTANTI
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | EMESSO | ANNULLATO
  total_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  html_blob BLOB
);
CREATE TABLE IF NOT EXISTS receipt_items(
  id INTEGER PRIMARY KEY,
  receipt_id INTEGER NOT NULL,
  menu_code TEXT NOT NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  FOREIGN KEY(receipt_id) REFERENCES receipts(id) ON DELETE CASCADE
);
`);
const qRcCreate = db.prepare(`INSERT INTO receipts (guild_id, operator_id, customer_id, customer_name, payment_method, status, total_cents, created_at)
VALUES (?,?,?,?,?,'OPEN',0,?)`);
const qRcGet    = db.prepare(`SELECT * FROM receipts WHERE id=?`);
const qRcOpenBy = db.prepare(`SELECT * FROM receipts WHERE status='OPEN' AND guild_id=? AND operator_id=? ORDER BY id DESC LIMIT 1`);
const qRcSetTot = db.prepare(`UPDATE receipts SET total_cents=? WHERE id=?`);
const qRcEmit   = db.prepare(`UPDATE receipts SET status='EMESSO', html_blob=? WHERE id=?`);
const qRcCancel = db.prepare(`UPDATE receipts SET status='ANNULLATO' WHERE id=?`);
const qRiAdd    = db.prepare(`INSERT INTO receipt_items (receipt_id, menu_code, name, qty, unit_price_cents) VALUES (?,?,?,?,?)`);
const qRiList   = db.prepare(`SELECT * FROM receipt_items WHERE receipt_id=?`);
const qRiDelOne = db.prepare(`DELETE FROM receipt_items WHERE receipt_id=? AND menu_code=? LIMIT 1`);

// ---------- Prepared (magazzino/cucina/menu) ----------
const qGelGetItemBySku = db.prepare(`SELECT * FROM ${GEL.items} WHERE sku=?`);
const qGelLotsBySkuFEFO = db.prepare(`
  SELECT * FROM ${GEL.lots}
  WHERE sku=? AND qty > 0
  ORDER BY COALESCE(expires_at, 9223372036854775807) ASC, id ASC
`);
const qGelLotById = db.prepare(`SELECT * FROM ${GEL.lots} WHERE id=?`);
const qGelMovesIns = db.prepare(`
  INSERT INTO ${GEL.moves}(ts, actor, kind, sku, lot_code, from_area, to_area, delta, note)
  VALUES (?,?,?,?,?,?,?,?,?)
`);
const insGelLot = db.prepare(`INSERT INTO ${GEL.lots}
  (sku, lot_code, area, qty, unit, expires_at, created_at)
  VALUES (?,?,?,?,?,?,?)`);
const upGelLotCodeById = db.prepare(`UPDATE ${GEL.lots} SET lot_code=? WHERE id=?`);
const qShowAll   = db.prepare(`SELECT * FROM ${GEL.show} ORDER BY slot ASC`);
const qShowByLot = db.prepare(`SELECT * FROM ${GEL.show} WHERE lot_id=?`);
const qShowUpsert= db.prepare(`
  INSERT INTO ${GEL.show}(slot, lot_id, level_pct, updated_at)
  VALUES (?,?,?,?)
  ON CONFLICT(slot) DO UPDATE SET lot_id=excluded.lot_id, level_pct=excluded.level_pct, updated_at=excluded.updated_at
`);

const qMenuGet   = db.prepare(`SELECT * FROM ${GEL.menu} WHERE code=?`);
const qMenuAll   = db.prepare(`SELECT code, name, price_cents FROM ${GEL.menu} ORDER BY name ASC`);
const qMCompsAll = db.prepare(`SELECT * FROM ${GEL.mcomps} WHERE menu_code=?`);
const qCMapGet   = db.prepare(`SELECT * FROM ${GEL.cmap} WHERE component=?`);
const qScoopsForMenu = db.prepare(`SELECT COUNT(*) AS scoops FROM ${GEL.mcomps} WHERE menu_code=? AND component LIKE 'gelato_%'`);

const qKTixIns   = db.prepare(`
  INSERT INTO ${GEL.ktix}(user_id, menu_code, qty, notes, status, station, eta_sec, started_at, finished_at, assigned_to, chosen_json)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`);
const qKTixGet   = db.prepare(`SELECT * FROM ${GEL.ktix} WHERE id=?`);
const qKTixSet   = db.prepare(`UPDATE ${GEL.ktix} SET status=?, assigned_to=?, started_at=?, eta_sec=? WHERE id=?`);
const qKTixReady = db.prepare(`UPDATE ${GEL.ktix} SET status=?, finished_at=? WHERE id=?`);
const qKTixQueue = db.prepare(`SELECT * FROM ${GEL.ktix} WHERE status IN ('QUEUED','IN_PROGRESS') ORDER BY id ASC`);
const qKConsIns  = db.prepare(`INSERT INTO ${GEL.kcons}(ticket_id, lot_id, sku, qty, unit) VALUES (?,?,?,?,?)`);

const qSlotSet = db.prepare(`INSERT INTO warehouse_slots(org_id, slot_idx, area, capacity)
VALUES (?,?,?,?) ON CONFLICT(org_id,slot_idx) DO UPDATE SET area=excluded.area, capacity=excluded.capacity`);
const qSlotGet = db.prepare(`SELECT * FROM warehouse_slots WHERE org_id=? AND slot_idx=?`);
const qSlotList= db.prepare(`SELECT * FROM warehouse_slots WHERE org_id=? ORDER BY slot_idx`);
const qWItemGet= db.prepare(`SELECT * FROM warehouse_items WHERE org_id=? AND slot_idx=?`);
const qWItemUp = db.prepare(`INSERT INTO warehouse_items(org_id, slot_idx, sku, lot_id, qty, unit, created_at)
VALUES (?,?,?,?,?,?,?) ON CONFLICT(org_id,slot_idx) DO UPDATE SET sku=excluded.sku, lot_id=excluded.lot_id, qty=excluded.qty, unit=excluded.unit`);
const qWItemDel= db.prepare(`DELETE FROM warehouse_items WHERE org_id=? AND slot_idx=?`);
const qWarehousePZ_ANY = db.prepare(`
  SELECT wi.org_id, wi.slot_idx, wi.sku, wi.lot_id, wi.qty, wi.unit, ws.area
  FROM warehouse_items wi
  JOIN warehouse_slots ws ON ws.org_id=wi.org_id AND ws.slot_idx=wi.slot_idx
  WHERE wi.org_id=? AND wi.sku=? AND wi.qty>0
  ORDER BY (ws.area='CUCINA') DESC, (ws.area='VETRINA') DESC, wi.slot_idx ASC
`);
const qItemStackMax = db.prepare(`SELECT stack_max FROM items WHERE id=?`);
const qItemRow = db.prepare(`SELECT * FROM items WHERE id=?`);
const qItemIns = db.prepare(`INSERT INTO items(id,name,emoji,description,stack_max) VALUES (?,?,?,?,?)`);

const qMapGet = db.prepare(`SELECT item_id FROM gel_item_map WHERE sku=?`);

const qKConfGet = db.prepare(`SELECT * FROM kitchen_config WHERE org_id=?`);
const qEGet = db.prepare(`SELECT * FROM economy_config WHERE org_id=?`);
const qEUp  = db.prepare(`UPDATE economy_config SET economy_enabled=?, default_lot_ml=?, daily_cap_ml=?, max_lot_ml=? WHERE org_id=?`);
const qIntakeGet = db.prepare(`SELECT ml_total FROM intake_log WHERE date_str=? AND org_id=?`);
const qIntakeUp  = db.prepare(`INSERT INTO intake_log(date_str, org_id, ml_total)
VALUES (?,?,?) ON CONFLICT(date_str,org_id) DO UPDATE SET ml_total = ml_total + excluded.ml_total`);

const qLotsBase = db.prepare(`SELECT id, sku, lot_code, area, qty, unit, expires_at
  FROM ${GEL.lots}
  ORDER BY COALESCE(expires_at, 9223372036854775807) ASC, id ASC`);

const qActiveFlavors = db.prepare(`
  SELECT gi.sku, gi.name, SUM(gl.qty) AS avail
  FROM ${GEL.items} gi
  JOIN ${GEL.lots} gl ON gl.sku = gi.sku
  WHERE gi.kind='BATCH' AND gl.qty > 0
  GROUP BY gi.sku, gi.name
  ORDER BY gi.name ASC
`);

// ---------- Helpers ----------
function emb(title, desc){ return new EmbedBuilder().setTitle(`${APP_NAME} • ${title}`).setDescription(desc).setColor(0xE68AA3).setTimestamp(new Date()); }
function ensureSlots(){ const tx = db.transaction(()=>{ for (let i=1;i<=SLOT_COUNT;i++) qSlotSet.run(ORG_ID, i, 'BACKSTORE', STACK_SIZE);}); tx(); }
function stackCap(item_id){ const r = qItemStackMax.get(item_id); return r ? r.stack_max : 16; }
function econClamp(mlRequested){
  const cfg = qEGet.get(ORG_ID);
  const t = todayStr();
  const already = qIntakeGet.get(t, ORG_ID)?.ml_total || 0;
  const maxLot = cfg.max_lot_ml || 8000;
  const dailyCap = cfg.daily_cap_ml || 24000;
  const defaultLot = cfg.default_lot_ml || 6000;
  const req = mlRequested ?? defaultLot;
  const remaining = Math.max(0, dailyCap - already);
  const clamped = Math.max(0, Math.min(req, maxLot, remaining));
  if (clamped>0) qIntakeUp.run(t, ORG_ID, clamped);
  return { cfg, clamped, remainingBefore: remaining, requested: req };
}
function updateShowLevel(lotId, consumedMl){
  const slot = qShowByLot.get(lotId);
  if (!slot) return;
  const current = slot.level_pct || 100;
  const capMl = 4000;
  const next = Math.max(0, current - Math.round((consumedMl/capMl)*100));
  qShowUpsert.run(slot.slot, lotId, next, now());
}
function consumePZ_FEFO({ sku, qty, area, actor, ticketId }){
  const rows = qWarehousePZ_ANY.all(ORG_ID, sku);
  let rem = qty;
  const tx = db.transaction(()=>{
    for (const r of rows){
      if (rem<=0) break;
      const take = Math.min(rem, r.qty);
      const newQty = r.qty - take;
      if (newQty<=0) qWItemDel.run(ORG_ID, r.slot_idx);
      else qWItemUp.run(ORG_ID, r.slot_idx, r.sku, r.lot_id||null, newQty, r.unit, now());
      qGelMovesIns.run(now(), actor, 'CONSUME', sku, '-', r.area, null, -take, `ticket#${ticketId}`);
      rem -= take;
    }
    if (rem>0) throw new Error(`Stock pezzi insufficiente ${sku} (mancano ${rem})`);
  }); tx();
}
function consumeBulkFEFO({ sku, qty, area, actor, ticketId }){
  const lots = qGelLotsBySkuFEFO.all(sku);
  let rem = qty;
  const upLot = db.prepare(`UPDATE ${GEL.lots} SET qty = qty - ? WHERE id=? AND qty >= ?`);
  const tx = db.transaction(()=>{
    for (const l of lots){
      if (rem<=0) break;
      const take = Math.min(rem, l.qty);
      const res = upLot.run(take, l.id, take);
      if (res.changes===0) continue;
      qGelMovesIns.run(now(), actor, 'CONSUME', sku, l.lot_code, l.area, null, -take, `ticket#${ticketId}`);
      if ((l.unit==='ml' || l.unit==='g')) updateShowLevel(l.id, take);
      qKConsIns.run(ticketId, l.id, sku, take, l.unit);
      rem -= take;
    }
    if (rem>0) throw new Error(`Stock sfuso insufficiente ${sku} (mancano ${rem})`);
  }); tx();
}
function estimateEta(menu, qty, notes, loadBanco){
  let eta = menu.base_time_sec || 45;
  try { const a = JSON.parse(menu.allergens||'[]'); if (a.length) eta += 10; } catch {}
  if ((notes||'').toLowerCase().includes('topping caldo')) eta += 15;
  if (qty>1) eta += Math.round(eta*0.6*(qty-1));
  if (loadBanco>0) eta += loadBanco*8;
  return eta;
}

// ===== Inventario player (usa inventory-core) =====
function getPlayerTotal(guildId, userId, itemId){
  return listPlayerSlots(guildId, userId).filter(r=>r.item_id===itemId).reduce((a,b)=>a+(b.quantity||0),0);
}
function giveToPlayer(guildId, userId, itemId, qty, preferredSlot=null){
  if (preferredSlot){
    let rem = qty;
    const slots = listPlayerSlots(guildId, userId);
    const cap = stackCap(itemId);
    const pref = slots.find(s=>s.slot===preferredSlot);
    if (pref){
      if (!pref.item_id){
        const put = Math.min(cap, rem);
        updatePlayerSlot(guildId, userId, preferredSlot, { item_id, quantity: put });
        rem -= put;
      } else if (pref.item_id===itemId && pref.quantity < cap){
        const can = Math.min(cap - pref.quantity, rem);
        updatePlayerSlot(guildId, userId, preferredSlot, { item_id, quantity: pref.quantity + can });
        rem -= can;
      }
    }
    if (rem>0) InventoryAddStack({ guild_id:guildId, user_id:userId, item_id, amount: rem });
  } else {
    InventoryAddStack({ guild_id:guildId, user_id:userId, item_id, amount: qty });
  }
}
function takeFromPlayer(guildId, userId, itemId, qty){
  InventoryRemoveStack({ guild_id:guildId, user_id:userId, item_id, amount: qty });
}
function ensureMenuAsItem(menuCode){
  const id = menuCode; // stesso nome del menu (es. "coppetta_2g")
  let it = qItemRow.get(id);
  if (!it){
    const mi = qMenuGet.get(menuCode);
    const name = mi ? mi.name : menuCode;
    qItemIns.run(id, name, '🍨', 'Gelato farcito (da consegnare via trade)', 16);
  }
  return id;
}

// ====== TEMPLATE SCONTRINO HTML (rosa/crema/bianco) ======
const INVOICE_HTML = (payload) => `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Fattura / Scontrino - ${escapeHtml(payload.headerTitle || 'Gelateria Vanillatte')}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;background:#fff8f4;color:#333;margin:0;padding:0}
  .wrap{max-width:740px;margin:24px auto;background:#fff;border:2px solid #f5c6d6;border-radius:14px;overflow:hidden}
  .top{padding:20px 24px;border-bottom:2px solid #f5c6d6;text-align:center}
  .brand{font-size:26px;margin:0;color:#e68aa3;font-weight:700}
  .sub{margin:6px 0 0;color:#666}
  .meta{display:flex;gap:24px;flex-wrap:wrap;padding:16px 24px}
  .meta div{flex:1 1 200px;background:#fff8fb;border:1px solid #f5c6d6;border-radius:10px;padding:10px}
  .meta b{color:#d46a8c}
  table{width:100%;border-collapse:collapse;margin:0 0 8px}
  th,td{border:1px solid #f5c6d6;padding:10px;text-align:left}
  th{background:#ffeef4;color:#d46a8c}
  tfoot td{border:none;padding:8px 0 18px}
  .total{font-size:18px;text-align:right;color:#d46a8c}
  .foot{background:#fff8fb;border-top:2px solid #f5c6d6;padding:14px 24px;text-align:center;color:#888;font-size:12px}
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <h1 class="brand">${escapeHtml(payload.brand || 'Gelateria Vanillatte')}</h1>
    <p class="sub">${escapeHtml(payload.docTitle || 'Fattura / Scontrino')}</p>
  </div>
  <div class="meta">
    <div><b>Data</b><br>${escapeHtml(payload.date)}</div>
    <div><b>Cliente</b><br>${escapeHtml(payload.customer || '—')}</div>
    <div><b>Pagamento</b><br>${escapeHtml(payload.payment || '—')}</div>
    <div><b>Emesso da</b><br>${escapeHtml(payload.operator || '—')}</div>
  </div>
  <div style="padding:0 24px 8px">
  <table>
    <thead><tr><th>Prodotto</th><th>Quantità</th><th>Prezzo (€)</th><th>Totale (€)</th></tr></thead>
    <tbody>
      ${payload.items.map(row => `
        <tr>
          <td>${escapeHtml(row.name)}</td>
          <td>${row.qty}</td>
          <td>${formatEuro(row.unit_cents)}</td>
          <td>${formatEuro(row.unit_cents * row.qty)}</td>
        </tr>`).join('')}
    </tbody>
  </table>
  <div class="total">Totale: <b>${formatEuro(payload.total_cents)}</b></div>
  </div>
  <div class="foot">Grazie per aver scelto Vanillatte • Pagabile in contanti o con carta</div>
</div>
</body>
</html>`;
function formatEuro(cents){ return (cents/100).toFixed(2).replace('.',','); }
function escapeHtml(s){ return String(s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ---------- Discord ----------
const client = new Client({ intents:[GatewayIntentBits.Guilds], partials:[Partials.GuildMember] });

// ===== Comandi in IT =====
const commands = [

  // ==== Magazzino (pezzi) ====
  new SlashCommandBuilder().setName('magazzino-inizializza').setDescription('Inizializza 50 slot (stack 16)').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('magazzino-area').setDescription('Imposta area di uno slot')
    .addIntegerOption(o=>o.setName('slot').setDescription('1..50').setRequired(true))
    .addStringOption(o=>o.setName('area').setDescription('BACKSTORE|CUCINA|VETRINA|BAR_FRIGO').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('magazzino-deposita').setDescription('Deposita (pz) in uno slot (dal TUO inventario)')
    .addIntegerOption(o=>o.setName('slot').setDescription('1..50').setRequired(true))
    .addStringOption(o=>o.setName('sku').setDescription('SKU da gel_items, unit pz').setRequired(true))
    .addIntegerOption(o=>o.setName('quantita').setDescription('1..16').setRequired(true))
    .addIntegerOption(o=>o.setName('lot_id').setDescription('lot id (opzionale)'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('magazzino-stato').setDescription('Mostra 50 slot'),
  new SlashCommandBuilder().setName('magazzino-sposta').setDescription('Sposta tra slot')
    .addIntegerOption(o=>o.setName('da').setDescription('slot sorgente').setRequired(true))
    .addIntegerOption(o=>o.setName('a').setDescription('slot destinazione').setRequired(true))
    .addIntegerOption(o=>o.setName('quantita').setDescription('quantità').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('magazzino-prendi').setDescription('Prendi un contenitore (cono/coppetta)')
    .addStringOption(o=>o.setName('tipo').setDescription('cono o coppetta').setRequired(true)
      .addChoices({ name:'cono', value:'cono' }, { name:'coppetta', value:'coppetta' })),
  new SlashCommandBuilder().setName('magazzino-a-player').setDescription('Warehouse → Player (pezzi, distribuisce su più slot)')
    .addUserOption(o=>o.setName('player').setDescription('Player').setRequired(true))
    .addIntegerOption(o=>o.setName('wh_slot').setDescription('Slot magazzino').setRequired(true))
    .addIntegerOption(o=>o.setName('quantita').setDescription('Quantità (1..n)').setRequired(true))
    .addIntegerOption(o=>o.setName('slot_preferito').setDescription('Slot preferito (opzionale)'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('player-a-magazzino').setDescription('Player → Warehouse (pezzi, legge multi-slot)')
    .addUserOption(o=>o.setName('player').setDescription('Player').setRequired(true))
    .addIntegerOption(o=>o.setName('slot_player').setDescription('Slot player (usato per capire item)').setRequired(true))
    .addIntegerOption(o=>o.setName('quantita').setDescription('Quantità (1..n)').setRequired(true))
    .addIntegerOption(o=>o.setName('wh_slot').setDescription('Slot magazzino').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ==== Lotti sfusi ====
  new SlashCommandBuilder().setName('lotti-ricevi').setDescription('Ricevi lotto sfuso (lot_code numerico)')
    .addStringOption(o=>o.setName('sku').setDescription('SKU sfuso (ml/g)').setRequired(true))
    .addStringOption(o=>o.setName('lot_code').setDescription('Solo numeri; se vuoto, useremo il lot_id'))
    .addIntegerOption(o=>o.setName('qty_ml').setDescription('Richiesti (ml); verrà clamped'))
    .addStringOption(o=>o.setName('scadenza').setDescription('YYYY-MM-DD'))
    .addStringOption(o=>o.setName('area').setDescription('BACKSTORE|CUCINA|VETRINA|BAR_FRIGO')),
  new SlashCommandBuilder().setName('lotti-elenco').setDescription('Elenco lotti (filtri opzionali)')
    .addStringOption(o=>o.setName('sku').setDescription('SKU da filtrare'))
    .addStringOption(o=>o.setName('area').setDescription('BACKSTORE|CUCINA|VETRINA|BAR_FRIGO'))
    .addIntegerOption(o=>o.setName('max').setDescription('Numero max righe (default 25)'))
    .addBooleanOption(o=>o.setName('solo_attivi').setDescription('Solo qty>0 (default sì)'))
    .addBooleanOption(o=>o.setName('pubblica').setDescription('Posta nel canale (default: true)')),
  new SlashCommandBuilder().setName('lotti-in-scadenza').setDescription('Lotti in scadenza (≤48h)'),

  // ==== Mappa SKU ↔ item player (per pezzi) ====
  new SlashCommandBuilder().setName('mappa-item').setDescription('Mappa SKU gelateria a item_id inventario player')
    .addStringOption(o=>o.setName('sku').setDescription('SKU da gel_items').setRequired(true))
    .addStringOption(o=>o.setName('item_id').setDescription('ID da items (inventario player)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ==== Menu / Ordini / Cucina ====
  new SlashCommandBuilder().setName('menu').setDescription('Vedi il menu gelateria'),
  new SlashCommandBuilder().setName('menu-pubblica').setDescription('Pubblica il menu nel canale con bottoni').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('ordina').setDescription('Crea ticket cucina (qty=1)')
    .addStringOption(o=>o.setName('menu').setDescription('Codice menu').setRequired(true))
    .addStringOption(o=>o.setName('gusti').setDescription('CSV: es. gelato_fiordilatte,gelato_nocciola'))
    .addStringOption(o=>o.setName('note').setDescription('Note per il banco')),
  new SlashCommandBuilder().setName('cucina-coda').setDescription('Mostra coda'),
  new SlashCommandBuilder().setName('cucina-prendi').setDescription('Prendi ticket (consumo)')
    .addIntegerOption(o=>o.setName('ticket').setDescription('ID ticket').setRequired(true)),
  new SlashCommandBuilder().setName('cucina-gusto').setDescription('Aggiungi un gusto al tuo cono/coppetta')
    .addStringOption(o=>o.setName('gusto').setDescription('es. nocciola').setRequired(true)),
  new SlashCommandBuilder().setName('vetrina-livelli').setDescription('Mostra vetrina'),
  new SlashCommandBuilder().setName('vetrina-monta').setDescription('Associa lot a slot vetrina')
    .addIntegerOption(o=>o.setName('slot').setDescription('1..18').setRequired(true))
    .addIntegerOption(o=>o.setName('lot_id').setDescription('ID lotto').setRequired(true)),

  // ==== Economia (se serve) ====
  new SlashCommandBuilder().setName('economia-configura').setDescription('Configura cap sfusi (staff RP)')
    .addIntegerOption(o=>o.setName('attiva').setDescription('0=OFF, 1=ON').setRequired(true))
    .addIntegerOption(o=>o.setName('lotto_default_ml').setDescription('Default per lotto (ml)'))
    .addIntegerOption(o=>o.setName('cap_giornaliero_ml').setDescription('Cap giornaliero (ml)'))
    .addIntegerOption(o=>o.setName('lotto_max_ml').setDescription('Max per lotto (ml)'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // ==== Tutorial ====
  new SlashCommandBuilder().setName('tutorial').setDescription('Guida rapida (embed + bottoni)'),

  // ==== SCONTRINO (subcomandi) ====
  new SlashCommandBuilder().setName('scontrino').setDescription('Gestione scontrino')
    .addSubcommand(sc=>sc.setName('crea').setDescription('Crea bozza scontrino')
      .addStringOption(o=>o.setName('metodo').setDescription('carta | contanti').setRequired(true).addChoices(
        {name:'carta', value:'CARTA'},{name:'contanti', value:'CONTANTI'}))
      .addUserOption(o=>o.setName('cliente').setDescription('Cliente (opzionale)'))
      .addStringOption(o=>o.setName('nome_cliente').setDescription('Nome cliente (opzionale)')))
    .addSubcommand(sc=>sc.setName('aggiungi').setDescription('Aggiungi voce di menu alla bozza')
      .addIntegerOption(o=>o.setName('id').setDescription('ID scontrino (se omesso: ultimo tuo OPEN)'))
      .addStringOption(o=>o.setName('menu').setDescription('Codice menu (es. coppetta_2g)').setRequired(true))
      .addIntegerOption(o=>o.setName('quantita').setDescription('Quantità').setRequired(true))
      .addIntegerOption(o=>o.setName('prezzo_cents').setDescription('Override prezzo (cent)')))
    .addSubcommand(sc=>sc.setName('mostra').setDescription('Mostra bozza corrente')
      .addIntegerOption(o=>o.setName('id').setDescription('ID scontrino (se omesso: ultimo tuo OPEN)')))
    .addSubcommand(sc=>sc.setName('rimuovi').setDescription('Rimuovi una riga')
      .addIntegerOption(o=>o.setName('id').setDescription('ID scontrino (se omesso: ultimo tuo OPEN)'))
      .addStringOption(o=>o.setName('menu').setDescription('Codice menu').setRequired(true)))
    .addSubcommand(sc=>sc.setName('emetti').setDescription('Emetti scontrino (allega HTML)')
      .addIntegerOption(o=>o.setName('id').setDescription('ID scontrino (se omesso: ultimo tuo OPEN)')))
    .addSubcommand(sc=>sc.setName('annulla').setDescription('Annulla bozza')
      .addIntegerOption(o=>o.setName('id').setDescription('ID scontrino (se omesso: ultimo tuo OPEN)')))
];

client.once('ready', async ()=>{
  console.log(`${APP_NAME} online: ${client.user.tag}`);
  const rest = new REST({version:'10'}).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.application.id), { body: commands });
    console.log(`Slash IT registrati: ${commands.length}`);
  } catch(e){ console.error('Reg error', e); }
});

// ---------- Interaction handler ----------
client.on('interactionCreate', async (i)=>{
  try{
    // Bottoni acquisto / tutorial / select gusti
    if (i.isButton()){
      const id = i.customId;
      if (id.startsWith('buy:')){
        const code = id.split(':')[1];
        const mi = qMenuGet.get(code);
        if (!mi) return i.reply({ content:'Articolo non disponibile.', ephemeral:true });
        const scoops = qScoopsForMenu.get(code)?.scoops || 0;
        if (scoops===0){
          const tid = qKTixIns.run(i.user.id, code, 1, '', 'QUEUED', 'BANCO', null, null, null, null, '{}').lastInsertRowid;
          return i.reply({ content:`✅ Ordine creato (#${tid}) per **${mi.name}**.`, ephemeral:true });
        }
        const flavors = qActiveFlavors.all();
        if (!flavors.length) return i.reply({ content:'Nessun gusto disponibile 😢', ephemeral:true });
        const sel = new StringSelectMenuBuilder()
          .setCustomId(`pick:${code}:${scoops}`)
          .setPlaceholder(`Scegli ${scoops} gusto/i`)
          .setMinValues(scoops).setMaxValues(scoops)
          .addOptions(...flavors.slice(0,25).map(f=>({ label:`${f.name} (${Math.floor(f.avail)} ml)`, value:f.sku })));
        const row = new ActionRowBuilder().addComponents(sel);
        return i.reply({ content:`Seleziona ${scoops} gusto/i per **${mi.name}**:`, components:[row], ephemeral:true });
      }
      if (id.startsWith('tut:')){
        const [, uid, action, pstr] = id.split(':');
        if (i.user.id !== uid) return i.reply({ content:'Questi controlli non sono tuoi.', ephemeral:true });
        const cur = parseInt(pstr,10)||0;
        if (action==='close') return i.update({ content:'Tutorial chiuso.', embeds:[], components:[] });
        const next = action==='prev' ? Math.max(0,cur-1) : Math.min(4,cur+1);
        const pages = tutorialPages();
        return i.update({ embeds:[pages[next]], components:[tutorialRow(next, uid)] });
      }
      return;
    }

    if (i.isStringSelectMenu()){
      if (i.customId.startsWith('pick:')){
        const [, code, scoopsStr] = i.customId.split(':');
        const scoops = parseInt(scoopsStr, 10) || 0;
        const picked = i.values || [];
        if (picked.length !== scoops) return i.reply({ content:`Seleziona esattamente ${scoops} gusto/i.`, ephemeral:true });
        const chosen = JSON.stringify({ gusti: picked });
        const tid = qKTixIns.run(i.user.id, code, 1, '', 'QUEUED', 'BANCO', null, null, null, null, chosen).lastInsertRowid;
        return i.update({ content:`✅ Ordine #${tid} creato — Gusti: ${picked.join(', ')}`, components:[] });
      }
      return;
    }

    if (!i.isChatInputCommand()) return;
    if (!i.inGuild()) return i.reply({ content:'Usa i comandi in server.', ephemeral:true });

    const name = i.commandName;

    // ===== MAGAZZINO =====
    if (name==='magazzino-inizializza'){
      ensureSlots();
      return i.reply({ embeds:[emb('Magazzino', '50 slot pronti (stack 16)')], ephemeral:true });
    }
    if (name==='magazzino-area'){
      const slot = i.options.getInteger('slot', true);
      const area = i.options.getString('area', true).toUpperCase();
      if (!['BACKSTORE','CUCINA','VETRINA','BAR_FRIGO'].includes(area)) return i.reply({ content:'Area non valida', ephemeral:true });
      qSlotSet.run(ORG_ID, slot, area, STACK_SIZE);
      return i.reply({ embeds:[emb('Magazzino', `Slot ${slot} → **${area}**`)], ephemeral:true });
    }
    if (name==='magazzino-deposita'){
      const slot = i.options.getInteger('slot', true);
      const sku  = i.options.getString('sku', true).trim();
      const qty  = i.options.getInteger('quantita', true);
      const lotId= i.options.getInteger('lot_id') ?? null;

      const it = qGelGetItemBySku.get(sku);
      if (!it) return i.reply({ content:'SKU non trovato in gel_items', ephemeral:true });
      if (it.unit !== 'pz') return i.reply({ content:'Questo comando carica solo pezzi (unità pz)', ephemeral:true });
      if (qty<1) return i.reply({ content:`Quantità minima 1`, ephemeral:true });

      const s = qSlotGet.get(ORG_ID, slot); if (!s) return i.reply({ content:'Slot non inizializzato', ephemeral:true });
      const cur = qWItemGet.get(ORG_ID, slot);
      if (cur && cur.sku !== sku) return i.reply({ content:`Slot occupato da ${cur.sku}`, ephemeral:true });

      // Deve provenire dall'inventario del chiamante
      const map = qMapGet.get(sku);
      if (!map) return i.reply({ content:`Manca mapping SKU→item_id per ${sku} (usa /mappa-item)`, ephemeral:true });
      const have = getPlayerTotal(i.guildId, i.user.id, map.item_id);
      if (have < qty) return i.reply({ content:`Non hai abbastanza \`${map.item_id}\` (hai ${have}, servono ${qty})`, ephemeral:true });

      const cap = s.capacity;
      const newQty = Math.min(cap, (cur?.qty||0)+qty);

      const tx = db.transaction(()=>{
        takeFromPlayer(i.guildId, i.user.id, map.item_id, qty);
        qWItemUp.run(ORG_ID, slot, sku, lotId, newQty, 'pz', now());
      }); tx();

      return i.reply({ embeds:[emb('Magazzino', `#${slot}: ${sku} ×${newQty}${lotId?` • lot#${lotId}`:''} (presi dal tuo inventario)`)], ephemeral:true });
    }
    if (name==='magazzino-stato'){
      ensureSlots();
      const slots = qSlotList.all(ORG_ID);
      const lines = slots.map(s=>{
        const w = qWItemGet.get(ORG_ID, s.slot_idx);
        if (!w) return `#${String(s.slot_idx).padStart(2,'0')} [${s.area}] — (vuoto)`;
        return `#${String(s.slot_idx).padStart(2,'0')} [${s.area}] ${w.sku} ×${w.qty}/${s.capacity}${w.lot_id?` • lot#${w.lot_id}`:''}`;
      });
      return i.reply({ embeds:[emb('Magazzino (50 slot)', lines.join('\n'))], ephemeral:true });
    }
    if (name==='magazzino-sposta'){
      const from = i.options.getInteger('da', true);
      const to   = i.options.getInteger('a', true);
      const qty  = i.options.getInteger('quantita', true);
      const a = qWItemGet.get(ORG_ID, from);
      if (!a || a.qty<=0) return i.reply({ content:'Sorgente vuota', ephemeral:true });
      const b = qWItemGet.get(ORG_ID, to);
      if (b && b.sku !== a.sku) return i.reply({ content:`Destinazione occupata da ${b.sku}`, ephemeral:true });
      const cap = qSlotGet.get(ORG_ID, to)?.capacity || STACK_SIZE;
      const take = Math.min(qty, a.qty);
      const tx = db.transaction(()=>{
        const newA = a.qty - take;
        if (newA<=0) qWItemDel.run(ORG_ID, from);
        else qWItemUp.run(ORG_ID, from, a.sku, a.lot_id, newA, 'pz', now());
        const newB = Math.min(cap, (b?.qty||0)+take);
        qWItemUp.run(ORG_ID, to, a.sku, a.lot_id, newB, 'pz', now());
      }); tx();
      return i.reply({ embeds:[emb('Magazzino', `Spostato ${a.sku} ×${take}: ${from} → ${to}`)], ephemeral:true });
    }
    if (name==='magazzino-prendi'){
      const tipo = i.options.getString('tipo', true);
      const sku = tipo==='cono' ? 'pack_cono' : 'pack_coppetta_media';
      const itemId = ensureMenuAsItem(`${tipo}_vuoto`);
      try {
        consumePZ_FEFO({ sku, qty:1, area:'CUCINA', actor:i.user.id, ticketId:0 });
        giveToPlayer(i.guildId, i.user.id, itemId, 1);
      } catch(e){
        return i.reply({ content:`❌ ${e.message}`, ephemeral:true });
      }
      return i.reply({ embeds:[emb('Magazzino', `${tipo} preso`)], ephemeral:true });
    }
    if (name==='magazzino-a-player'){
      const user = i.options.getUser('player', true);
      const wh_slot = i.options.getInteger('wh_slot', true);
      const qty = i.options.getInteger('quantita', true);
      const preferred = i.options.getInteger('slot_preferito') || null;
      const w = qWItemGet.get(ORG_ID, wh_slot);
      if (!w || w.qty<=0) return i.reply({ content:'Slot warehouse vuoto', ephemeral:true });
      const map = qMapGet.get(w.sku);
      if (!map) return i.reply({ content:`Manca mapping SKU→item_id per ${w.sku} (usa /mappa-item)`, ephemeral:true });
      const give = Math.min(qty, w.qty);
      try {
        const tx = db.transaction(()=>{
          const left = w.qty - give;
          if (left<=0) qWItemDel.run(ORG_ID, wh_slot);
          else qWItemUp.run(ORG_ID, wh_slot, w.sku, w.lot_id||null, left, 'pz', now());
          giveToPlayer(i.guildId, user.id, map.item_id, give, preferred);
          qGelMovesIns.run(now(), i.user.id, 'TRANSFER', w.sku, '-', 'WAREHOUSE', 'PLAYER', -give, `to ${user.id}`);
        }); tx();
      } catch(e){
        if (e.message.includes('Inventario pieno')){
          return i.reply({ content:`Inventario di <@${user.id}> pieno per ${give} \`${map.item_id}\`.`, ephemeral:true });
        }
        throw e;
      }
      return i.reply({ embeds:[emb('Trasferimento', `${w.sku} ×${give} → <@${user.id}> (multi-slot)`)], ephemeral:true });
    }
    if (name==='player-a-magazzino'){
      const user = i.options.getUser('player', true);
      const pslot = i.options.getInteger('slot_player', true);
      const qty = i.options.getInteger('quantita', true);
      const wh_slot = i.options.getInteger('wh_slot', true);
      const g = i.guildId;
      const p = listPlayerSlots(g, user.id).find(s=>s.slot===pslot);
      if (!p || !p.item_id || p.quantity<=0) return i.reply({ content:'Slot player vuoto', ephemeral:true });
      const skuRow = db.prepare(`SELECT sku FROM gel_item_map WHERE item_id=?`).get(p.item_id);
      if (!skuRow) return i.reply({ content:`Nessun SKU mappato per ${p.item_id}. Usa /mappa-item`, ephemeral:true });
      const sku = skuRow.sku;
      const w = qWItemGet.get(ORG_ID, wh_slot);
      if (w && w.sku !== sku) return i.reply({ content:`WH ${wh_slot} occupato da ${w.sku}`, ephemeral:true });
      const cap = qSlotGet.get(ORG_ID, wh_slot)?.capacity || STACK_SIZE;
      const take = Math.min(qty, getPlayerTotal(g, user.id, p.item_id));
      if (take<=0) return i.reply({ content:`Il player non ha abbastanza ${p.item_id}`, ephemeral:true });
      const tx = db.transaction(()=>{
        takeFromPlayer(g, user.id, p.item_id, take);
        const newW = Math.min(cap, (w?.qty||0) + take);
        qWItemUp.run(ORG_ID, wh_slot, sku, w?.lot_id||null, newW, 'pz', now());
        qGelMovesIns.run(now(), i.user.id, 'TRANSFER', sku, '-', 'PLAYER', 'WAREHOUSE', take, `from ${user.id}`);
      }); tx();
      return i.reply({ embeds:[emb('Trasferimento', `<@${user.id}> → WH ${wh_slot}: ${sku} ×${take}`)], ephemeral:true });
    }

    // ===== LOTTI =====
    if (name==='lotti-ricevi'){
      const sku = i.options.getString('sku', true).trim();
      const lot_code_input = i.options.getString('lot_code') || null;
      const qty_req  = i.options.getInteger('qty_ml') ?? null;
      const scad     = i.options.getString('scadenza');
      const area     = (i.options.getString('area') || 'CUCINA').toUpperCase();
      if (!['BACKSTORE','CUCINA','VETRINA','BAR_FRIGO','SCARTI'].includes(area)) return i.reply({ content:'Area non valida', ephemeral:true });
      const it = qGelGetItemBySku.get(sku);
      if (!it) return i.reply({ content:'SKU non trovato in gel_items', ephemeral:true });
      if (!(it.unit==='ml' || it.unit==='g')) return i.reply({ content:'Questo comando è per sfusi (ml/g)', ephemeral:true });
      const econ = qEGet.get(ORG_ID);
      if (econ.economy_enabled){ return i.reply({ content:'Economia attiva: ricezione centralizzata (futuro).', ephemeral:true }); }
      const clamp = econClamp(qty_req);
      if (clamp.clamped<=0) return i.reply({ content:`Cap giornaliero raggiunto.`, ephemeral:true });
      const exp = scad ? Date.parse(scad+'T00:00:00Z') : now()+EXPIRY_MS_DEFAULT;
      let lid=null, lotCodeFinal=null;
      const tx = db.transaction(()=>{
        const info = insGelLot.run(sku, '0', area, clamp.clamped, it.unit, exp, now());
        lid = info.lastInsertRowid;
        const numeric = lot_code_input && /^\d+$/.test(lot_code_input.trim()) ? lot_code_input.trim() : String(lid);
        lotCodeFinal = numeric;
        upGelLotCodeById.run(lotCodeFinal, lid);
        qGelMovesIns.run(now(), i.user.id, 'RECEIVE', sku, lotCodeFinal, null, area, clamp.clamped, 'lotto sfuso');
      }); tx();
      return i.reply({ embeds:[emb('Lotti ricevuti', `• SKU: **${sku}**\n• lot_id: \`${lid}\`\n• lot_code: \`${lotCodeFinal}\`\n• Scadenza: **${d(exp)}**\n• Area: **${area}** (${clamp.clamped} ${it.unit})`)] });
    }
    if (name === 'lotti-elenco'){
      const sku   = i.options.getString('sku')?.trim() || null;
      const area  = i.options.getString('area')?.toUpperCase() || null;
      const max   = i.options.getInteger('max') ?? 25;
      const only  = i.options.getBoolean('solo_attivi');
      const pub   = i.options.getBoolean('pubblica') ?? true;
      let rows = qLotsBase.all();
      if (sku)  rows = rows.filter(r => r.sku === sku);
      if (area) rows = rows.filter(r => r.area === area);
      if (only === undefined || only === true) rows = rows.filter(r => r.qty > 0);
      rows = rows.slice(0, Math.max(1, Math.min(200, max)));
      if (!rows.length) return i.reply({ content:'Nessun lotto trovato.', ephemeral:!pub });
      const lines = rows.map(r => `#${String(r.id).padStart(4,'0')} • ${r.sku} • lot:${r.lot_code} • ${r.qty}${r.unit} • ${r.area}${r.expires_at?` • scad ${d(r.expires_at)}`:''}`);
      const e = emb(`Lotti trovati (${rows.length})`, lines.join('\n'));
      return pub ? i.reply({ embeds:[e] }) : i.reply({ embeds:[e], ephemeral:true });
    }
    if (name==='lotti-in-scadenza'){
      const limit = now()+EXPIRY_SOON_MS;
      const rows = db.prepare(`SELECT * FROM ${GEL.lots} WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at ASC`).all(limit);
      if (!rows.length) return i.reply({ content:'Nessun lotto in scadenza ≤48h', ephemeral:true });
      const lines = rows.map(r=>`• ${r.sku} — lot ${r.lot_code} — scad ${d(r.expires_at)} — ${r.qty}${r.unit} in ${r.area}`);
      return i.reply({ embeds:[emb('In scadenza (≤48h)', lines.join('\n'))] });
    }

    // ===== Mappatura pezzi =====
    if (name==='mappa-item'){
      const sku = i.options.getString('sku', true).trim();
      const item_id = i.options.getString('item_id', true).trim();
      if (!qGelGetItemBySku.get(sku)) return i.reply({ content:'SKU inesistente in gel_items', ephemeral:true });
      db.prepare(`INSERT INTO gel_item_map(sku,item_id) VALUES(?,?) ON CONFLICT(sku) DO UPDATE SET item_id=excluded.item_id`).run(sku, item_id);
      return i.reply({ embeds:[emb('Mappatura', `Collegato:\n• ${sku} → \`${item_id}\``)] , ephemeral:true});
    }

    // ===== MENU & ORDINI =====
    if (name==='menu'){
      const rows = qMenuAll.all();
      if (!rows.length) return i.reply({ content:'Il menu è ancora vuoto 😅', ephemeral:true });
      const lines = rows.map(r=>`• **${r.name}** — \`${r.code}\` — € ${(r.price_cents/100).toFixed(2)}`);
      return i.reply({ embeds:[emb('Menu', lines.join('\n'))], ephemeral:true });
    }
    if (name==='menu-pubblica'){
      const rows = qMenuAll.all();
      if (!rows.length) return i.reply({ content:'Il menu è ancora vuoto 😅', ephemeral:true });
      const lines = rows.map(r=>`• **${r.name}** — € ${(r.price_cents/100).toFixed(2)}`).join('\n');
      const maxBtns = 5;
      const chunk = rows.slice(0, maxBtns);
      const row = new ActionRowBuilder().addComponents(
        ...chunk.map(r => new ButtonBuilder().setCustomId(`buy:${r.code}`).setLabel(`Ordina: ${r.name}`).setStyle(ButtonStyle.Primary))
      );
      await i.reply({ content:'Menu pubblicato.', ephemeral:true });
      return i.channel.send({ embeds:[emb('🍦 Menu Gelateria', lines)], components:[row] });
    }
    if (name==='ordina'){
      const code = i.options.getString('menu', true).trim();
      const gustiCsv = i.options.getString('gusti') || '';
      const note = i.options.getString('note') || '';
      if (!qMenuGet.get(code)) return i.reply({ content:'Menu non trovato', ephemeral:true });
      let chosen = '{}';
      if (gustiCsv.trim()){
        const arr = gustiCsv.split(',').map(s=>s.trim()).filter(Boolean);
        chosen = JSON.stringify({ gusti: arr });
      }
      const id = qKTixIns.run(i.user.id, code, 1, note, 'QUEUED', 'BANCO', null, null, null, null, chosen).lastInsertRowid;
      return i.reply({ embeds:[emb('Ordine', `Ticket **#${id}** creato per \`${code}\`${note?`\nNote: ${note}`:''}`)], ephemeral:true });
    }
    if (name==='cucina-coda'){
      const rows = qKTixQueue.all();
      if (!rows.length) return i.reply({ content:'Coda vuota', ephemeral:true });
      const lines = rows.map(t=>{
        const rem = (t.started_at && t.eta_sec) ? Math.max(0, Math.ceil((t.started_at + t.eta_sec*1000 - now())/1000)) : null;
        return `#${t.id} ${t.menu_code} ×${t.qty} • ${t.status}${t.assigned_to?` • 👤 <@${t.assigned_to}>`:''}${t.eta_sec?` • ETA ${rem??t.eta_sec}s`:''}${t.notes?` • ${t.notes}`:''}`;
      });
      return i.reply({ embeds:[emb('Coda banco', lines.join('\n'))], ephemeral:true });
    }
    if (name==='cucina-prendi'){
      const ticketId = i.options.getInteger('ticket', true);
      const t = qKTixGet.get(ticketId);
      if (!t || t.status!=='QUEUED') return i.reply({ content:'Ticket non disponibile', ephemeral:true });

      const conf = qKConfGet.get(ORG_ID) || { cook_max_active:DEFAULT_COOK_MAX, station_max_active:DEFAULT_STATION_MAX, scoop_ml:DEFAULT_SCOOP_ML };
      const byCook = db.prepare(`SELECT COUNT(*) AS n FROM ${GEL.ktix} WHERE status='IN_PROGRESS' AND assigned_to=?`).get(i.user.id)?.n || 0;
      const byStat = db.prepare(`SELECT COUNT(*) AS n FROM ${GEL.ktix} WHERE status='IN_PROGRESS' AND station=?`).get(t.station)?.n || 0;
      if (byCook >= (conf.cook_max_active)) return i.reply({ content:'Limite cuoco raggiunto', ephemeral:true });
      if (byStat >= (conf.station_max_active)) return i.reply({ content:'Stazione piena', ephemeral:true });

      const menu = qMenuGet.get(t.menu_code);
      const comps= qMCompsAll.all(t.menu_code);
      const scoop_ml = conf.scoop_ml;
      let eta = estimateEta(menu, t.qty, t.notes, byStat);

      const tx = db.transaction(()=>{
        // Gusti scelti
        let handledGelato = false;
        try {
          const chosen = JSON.parse(t.chosen_json || '{}');
          const chosenFlavors = Array.isArray(chosen.gusti) ? chosen.gusti : [];
          if (chosenFlavors.length){
            const scoopsPerUnit = qScoopsForMenu.get(t.menu_code)?.scoops || chosenFlavors.length;
            for (let q=0; q<t.qty; q++){
              for (let s=0; s<scoopsPerUnit; s++){
                const sku = chosenFlavors[s % chosenFlavors.length];
                consumeBulkFEFO({ sku, qty: scoop_ml, area: 'VETRINA', actor: i.user.id, ticketId });
              }
            }
            handledGelato = true;
          }
        } catch {}

        // Packaging + gelato statico (se non scelto)
        for (const c of comps){
          const map = qCMapGet.get(c.component);
          if (!map) continue;
          const it = qGelGetItemBySku.get(map.sku);
          if (!it) throw new Error(`SKU ${map.sku} non trovato`);
          if (/^gelato_\d+$/i.test(c.component) && handledGelato) continue;
          const needUnits = c.qty_unit * t.qty;
          if (it.unit === 'pz'){
            const pz = Math.ceil((map.unit_to_pz || 1) * needUnits);
            consumePZ_FEFO({ sku: map.sku, qty: pz, area: 'CUCINA', actor: i.user.id, ticketId });
          } else {
            const ml = Math.ceil((map.unit_to_ml || scoop_ml) * needUnits);
            consumeBulkFEFO({ sku: map.sku, qty: ml, area: 'CUCINA', actor: i.user.id, ticketId });
          }
        }
        qKTixSet.run('IN_PROGRESS', i.user.id, now(), eta, ticketId);
      }); try { tx(); } catch(e){ return i.reply({ content:`❌ ${e.message}`, ephemeral:true }); }

      return i.reply({ embeds:[emb('Cucina', `Ticket **#${ticketId}** preso • ETA ~ ${eta}s`)], ephemeral:true });
    }
    if (name==='cucina-gusto'){
      const gusto = i.options.getString('gusto', true).toLowerCase();
      const sku = gusto.startsWith('gelato_') ? gusto : `gelato_${gusto}`;
      const conf = qKConfGet.get(ORG_ID) || { scoop_ml: DEFAULT_SCOOP_ML };
      try {
        consumeBulkFEFO({ sku, qty: conf.scoop_ml || DEFAULT_SCOOP_ML, area:'VETRINA', actor:i.user.id, ticketId:0 });
      } catch(e){
        return i.reply({ content:`❌ ${e.message}`, ephemeral:true });
      }
      await i.deferReply({ ephemeral:true });
      await new Promise(r=>setTimeout(r, 3000));
      const slots = listPlayerSlots(i.guildId, i.user.id);
      const cone = slots.find(s=>s.item_id==='cono_farcito' || s.item_id==='cono_vuoto');
      const cup  = slots.find(s=>s.item_id==='coppetta_farcita' || s.item_id==='coppetta_vuota');
      if (!cone && !cup) return i.editReply({ content:'Serve un cono o una coppetta in mano.' });
      if (cone){
        if (cone.item_id==='cono_vuoto'){
          takeFromPlayer(i.guildId, i.user.id, 'cono_vuoto', 1);
          giveToPlayer(i.guildId, i.user.id, ensureMenuAsItem('cono_farcito'), 1, cone.slot);
        }
        return i.editReply({ embeds:[emb('Cucina', `Aggiunto ${gusto} al cono`)] });
      }
      if (cup){
        if (cup.item_id==='coppetta_vuota'){
          takeFromPlayer(i.guildId, i.user.id, 'coppetta_vuota', 1);
          giveToPlayer(i.guildId, i.user.id, ensureMenuAsItem('coppetta_farcita'), 1, cup.slot);
        }
        return i.editReply({ embeds:[emb('Cucina', `Aggiunto ${gusto} alla coppetta`)] });
      }
    }

    // ===== VETRINA =====
    if (name==='vetrina-livelli'){
      const slots = qShowAll.all();
      if (!slots.length) return i.reply({ content:'Vetrina vuota', ephemeral:true });
      const lines = slots.map(s=>{
        const lot = s.lot_id ? qGelLotById.get(s.lot_id) : null;
        return `V${s.slot}: ${lot ? `#${lot.id} • ${lot.sku} • lot ${lot.lot_code} • scad ${lot.expires_at?d(lot.expires_at):'—'}` : '—'} • livello ${s.level_pct||0}%`;
      });
      return i.reply({ embeds:[emb('Vetrina', lines.join('\n'))], ephemeral:true });
    }
    if (name==='vetrina-monta'){
      const slot = i.options.getInteger('slot', true);
      const lot_id = i.options.getInteger('lot_id', true);
      const lot = qGelLotById.get(lot_id);
      if (!lot) return i.reply({ content:'lot_id non trovato', ephemeral:true });
      qShowUpsert.run(slot, lot_id, 100, now());
      qGelMovesIns.run(now(), i.user.id, 'MOUNT', lot.sku, lot.lot_code, null, 'VETRINA', 0, `slot V${slot}`);
      return i.reply({ embeds:[emb('Vetrina', `Slot **${slot}** equipaggiato con **#${lot.id} ${lot.sku}**`)], ephemeral:true });
    }

    // ===== ECONOMIA (staff RP) =====
    if (name==='economia-configura'){
      const en  = i.options.getInteger('attiva', true);
      const def = i.options.getInteger('lotto_default_ml') ?? null;
      const day = i.options.getInteger('cap_giornaliero_ml') ?? null;
      const max = i.options.getInteger('lotto_max_ml') ?? null;
      const cur = qEGet.get(ORG_ID);
      qEUp.run(en?1:0, def??cur.default_lot_ml, day??cur.daily_cap_ml, max??cur.max_lot_ml, ORG_ID);
      const n = qEGet.get(ORG_ID);
      return i.reply({ embeds:[emb('Economia', `attiva=${n.economy_enabled} • default=${n.default_lot_ml} • cap=${n.daily_cap_ml} • max=${n.max_lot_ml}`)], ephemeral:true });
    }

    // ===== TUTORIAL =====
    if (name==='tutorial'){
      const pages = tutorialPages();
      await i.reply({ embeds:[pages[0]], components:[tutorialRow(0, i.user.id)], ephemeral:true });
      return;
    }

    // ===== SCONTRINO =====
    if (name==='scontrino'){
      const sub = i.options.getSubcommand();

      if (sub==='crea'){
        const metodo = i.options.getString('metodo', true); // CARTA | CONTANTI
        const clienteUser = i.options.getUser('cliente');
        const nomeCliente = i.options.getString('nome_cliente') || (clienteUser ? `${clienteUser.username}` : null);
        const info = qRcCreate.run(i.guildId, i.user.id, clienteUser?.id || null, nomeCliente || null, metodo, now());
        const rid = info.lastInsertRowid;
        return i.reply({ embeds:[emb('Scontrino', `Bozza creata: **#${rid}** • Metodo: **${metodo}**${nomeCliente?`\nCliente: **${nomeCliente}**`:''}\nUsa \`/scontrino aggiungi\` per inserire prodotti.`)], ephemeral:true });
      }

      if (sub==='aggiungi'){
        const sid = i.options.getInteger('id') || qRcOpenBy.get(i.guildId, i.user.id)?.id;
        if (!sid) return i.reply({ content:'Nessuna bozza aperta. Usa `/scontrino crea`.', ephemeral:true });
        const r = qRcGet.get(sid); if (!r || r.status!=='OPEN') return i.reply({ content:'Bozza non trovata o non OPEN.', ephemeral:true });
        const menu_code = i.options.getString('menu', true).trim();
        const qty = i.options.getInteger('quantita', true);
        const override = i.options.getInteger('prezzo_cents') ?? null;
        const mi = qMenuGet.get(menu_code);
        if (!mi && !override) return i.reply({ content:'Codice menu non trovato. Specifica `prezzo_cents` oppure usa un codice valido.', ephemeral:true });
        const name = mi?.name || menu_code;
        const price = override ?? (mi?.price_cents || 0);
        qRiAdd.run(sid, menu_code, name, qty, price);
        const items = qRiList.all(sid);
        const tot = items.reduce((a,x)=>a + x.qty*x.unit_price_cents, 0);
        qRcSetTot.run(tot, sid);
        return i.reply({ embeds:[emb('Scontrino', `Aggiunto: **${name}** ×${qty} @€ ${(price/100).toFixed(2)}\nTotale parziale: € ${(tot/100).toFixed(2)}`)], ephemeral:true });
      }

      if (sub==='mostra'){
        const sid = i.options.getInteger('id') || qRcOpenBy.get(i.guildId, i.user.id)?.id;
        if (!sid) return i.reply({ content:'Nessuna bozza aperta. Usa `/scontrino crea`.', ephemeral:true });
        const r = qRcGet.get(sid); if (!r) return i.reply({ content:'Scontrino non trovato.', ephemeral:true });
        const items = qRiList.all(sid);
        if (!items.length) return i.reply({ content:'Bozza vuota. Usa `/scontrino aggiungi`.', ephemeral:true });
        const lines = items.map(x=>`• ${x.name} ×${x.qty} — € ${((x.unit_price_cents*x.qty)/100).toFixed(2)}`);
        return i.reply({ embeds:[emb(`Scontrino #${sid} — ${r.payment_method}`, `${lines.join('\n')}\n\nTotale: **€ ${(r.total_cents/100).toFixed(2)}**`)], ephemeral:true });
      }

      if (sub==='rimuovi'){
        const sid = i.options.getInteger('id') || qRcOpenBy.get(i.guildId, i.user.id)?.id;
        if (!sid) return i.reply({ content:'Nessuna bozza aperta.', ephemeral:true });
        const r = qRcGet.get(sid); if (!r || r.status!=='OPEN') return i.reply({ content:'Bozza non trovata o non OPEN.', ephemeral:true });
        const menu_code = i.options.getString('menu', true).trim();
        const del = qRiDelOne.run(sid, menu_code);
        const items = qRiList.all(sid);
        const tot = items.reduce((a,x)=>a + x.qty*x.unit_price_cents, 0);
        qRcSetTot.run(tot, sid);
        return i.reply({ embeds:[emb('Scontrino', del.changes? `Riga rimossa. Totale: € ${(tot/100).toFixed(2)}` : 'Nessuna riga trovata con quel codice.')], ephemeral:true });
      }

      if (sub==='annulla'){
        const sid = i.options.getInteger('id') || qRcOpenBy.get(i.guildId, i.user.id)?.id;
        if (!sid) return i.reply({ content:'Nessuna bozza aperta.', ephemeral:true });
        qRcCancel.run(sid);
        return i.reply({ embeds:[emb('Scontrino', `Bozza **#${sid}** annullata.`)], ephemeral:true });
      }

      if (sub==='emetti'){
        const sid = i.options.getInteger('id') || qRcOpenBy.get(i.guildId, i.user.id)?.id;
        if (!sid) return i.reply({ content:'Nessuna bozza aperta.', ephemeral:true });
        const r = qRcGet.get(sid); if (!r || r.status!=='OPEN') return i.reply({ content:'Bozza non trovata o già emessa.', ephemeral:true });
        const items = qRiList.all(sid);
        if (!items.length) return i.reply({ content:'Bozza vuota. Aggiungi prodotti prima di emettere.', ephemeral:true });

        const html = INVOICE_HTML({
          headerTitle: `Scontrino #${sid}`,
          brand: APP_NAME,
          docTitle: 'Scontrino',
          date: d(now()),
          customer: r.customer_name || (r.customer_id ? `ID:${r.customer_id}` : ''),
          payment: r.payment_method,
          operator: i.user.username,
          items: items.map(x=>({ name:x.name, qty:x.qty, unit_cents:x.unit_price_cents })),
          total_cents: items.reduce((a,x)=>a + x.qty*x.unit_price_cents, 0)
        });

        qRcEmit.run(Buffer.from(html, 'utf8'), sid);
        const file = new AttachmentBuilder(Buffer.from(html, 'utf8'), { name:`scontrino_${sid}.html` });
        await i.reply({ content:`🧾 Scontrino **#${sid}** emesso • Totale: € ${(r.total_cents/100).toFixed(2)} • Metodo: **${r.payment_method}**`, files:[file] });
        return;
      }
    }

  }catch(e){
    console.error('Err:', e);
    try { if (i.isRepliable()) await i.reply({ content:`Errore: ${e.message}`, ephemeral:true }); } catch{}
  }
});

// ---------- Tutorial (breve IT) ----------
function tutorialPages(){
  const p = [];
  p.push(new EmbedBuilder().setTitle(`${APP_NAME} • 1/5 — Lotti & Vetrina`)
    .setColor(0xE68AA3).setDescription([
      '• Ricevi sfuso: `/lotti-ricevi sku:gelato_fiordilatte area:VETRINA qty_ml:4000`',
      '• Elenco lotti: `/lotti-elenco pubblica:true`',
      '• Monta vaschetta: `/vetrina-monta slot:1 lot_id:<id>`',
      '• Stato vetrina: `/vetrina-livelli`'
    ].join('\n')).setTimestamp(new Date()));
  p.push(new EmbedBuilder().setTitle(`${APP_NAME} • 2/5 — Menu & Ordini`)
    .setColor(0xE68AA3).setDescription([
      '• Vedi menu: `/menu`',
      '• Pubblica menu con bottoni: `/menu-pubblica`',
      '• Ordina manuale: `/ordina menu:coppetta_2g gusti:gelato_fiordilatte,gelato_nocciola`'
    ].join('\n')).setTimestamp(new Date()));
  p.push(new EmbedBuilder().setTitle(`${APP_NAME} • 3/5 — Cucina`)
    .setColor(0xE68AA3).setDescription([
      '• Coda: `/cucina-coda`',
      '• Prendi: `/cucina-prendi ticket:<id>` → scala packaging e scoop (FEFO).',
      '• Gusti: `/cucina-gusto nocciola` → 3s per scoop, ripeti per ogni gusto.'
    ].join('\n')).setTimestamp(new Date()));
  p.push(new EmbedBuilder().setTitle(`${APP_NAME} • 4/5 — Magazzino pezzi`)
    .setColor(0xE68AA3).setDescription([
      '• Deposita dal tuo inventario: `/magazzino-deposita slot:11 sku:pack_coppetta_media quantita:16`',
      '• Stato/sposta: `/magazzino-stato`, `/magazzino-sposta`',
      '• WH→Player: `/magazzino-a-player player:@nome wh_slot:11 quantita:8`'
    ].join('\n')).setTimestamp(new Date()));
  p.push(new EmbedBuilder().setTitle(`${APP_NAME} • 5/5 — Scontrino`)
    .setColor(0xE68AA3).setDescription([
      '• Crea bozza: `/scontrino crea metodo:contanti nome_cliente:"Mario"`',
      '• Aggiungi righe: `/scontrino aggiungi menu:coppetta_2g quantita:2`',
      '• Mostra: `/scontrino mostra`  • Emetti: `/scontrino emetti` (allega HTML)',
    ].join('\n')).setTimestamp(new Date()));
  return p;
}
function tutorialRow(page, uid){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tut:${uid}:prev:${page}`).setLabel('◀︎').setStyle(ButtonStyle.Secondary).setDisabled(page<=0),
    new ButtonBuilder().setCustomId(`tut:${uid}:close:${page}`).setLabel('Chiudi').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`tut:${uid}:next:${page}`).setLabel('▶︎').setStyle(ButtonStyle.Primary).setDisabled(page>=4)
  );
}

// ---------- Login ----------
client.login(TOKEN);
