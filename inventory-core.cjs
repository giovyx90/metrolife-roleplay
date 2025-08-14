const { randomUUID } = require('crypto');

module.exports = (db) => {
  const PLAYER_SLOTS = 10;
  const ORG_SLOTS = 50;

  const qGetItem = db.prepare('SELECT * FROM items WHERE id=?');
  const qInsertMeta = db.prepare('INSERT INTO inventory_instances_meta (instance_id, item_id, payload_json) VALUES (?,?,?)');
  const qFindUnique = db.prepare('SELECT slot, instance_id FROM inventory_slots WHERE guild_id=? AND user_id=? AND item_id=? AND instance_id IS NOT NULL');
  const qDelMeta = db.prepare('DELETE FROM inventory_instances_meta WHERE instance_id=?');

  // Player slot helpers
  const qPlayerSlots = db.prepare('SELECT slot FROM inventory_slots WHERE guild_id=? AND user_id=?');
  const qInsertPlayerSlot = db.prepare('INSERT INTO inventory_slots (guild_id, user_id, slot, item_id, quantity, instance_id, durability, durability_max) VALUES (?, ?, ?, NULL, 0, NULL, NULL, NULL)');
  const qListPlayerSlots = db.prepare('SELECT * FROM inventory_slots WHERE guild_id=? AND user_id=? ORDER BY slot');
  const qUpdatePlayerSlot = db.prepare('UPDATE inventory_slots SET item_id=?, quantity=?, instance_id=?, durability=?, durability_max=? WHERE guild_id=? AND user_id=? AND slot=?');
  const qClearPlayerSlot = db.prepare('UPDATE inventory_slots SET item_id=NULL, quantity=0, instance_id=NULL, durability=NULL, durability_max=NULL WHERE guild_id=? AND user_id=? AND slot=?');

  function ensurePlayerSlots(guildId, userId) {
    const existing = new Set(qPlayerSlots.all(guildId, userId).map(r=>r.slot));
    for (let s=1; s<=PLAYER_SLOTS; s++) if (!existing.has(s)) qInsertPlayerSlot.run(guildId, userId, s);
  }

  function listPlayerSlots(guildId, userId) {
    ensurePlayerSlots(guildId, userId);
    return qListPlayerSlots.all(guildId, userId);
  }

  function updatePlayerSlot(guildId, userId, slot, data) {
    qUpdatePlayerSlot.run(data.item_id, data.quantity, data.instance_id ?? null, data.durability ?? null, data.durability_max ?? null, guildId, userId, slot);
  }

  function clearPlayerSlot(guildId, userId, slot) {
    qClearPlayerSlot.run(guildId, userId, slot);
  }

  function InventoryAddStack({ guild_id, user_id, item_id, amount }) {
    const item = qGetItem.get(item_id);
    if (!item) throw new Error(`Item "${item_id}" inesistente nel catalogo MetroInventory`);
    const maxS = item.stack_max || 16;
    if (maxS === 1) throw new Error('Usa InventoryAddUnique per item unici');
    const slots = listPlayerSlots(guild_id, user_id);
    let remaining = amount;
    for (const s of slots) {
      if (remaining<=0) break;
      if (s.item_id===item_id && s.quantity < maxS) {
        const can = Math.min(maxS - s.quantity, remaining);
        updatePlayerSlot(guild_id, user_id, s.slot, { item_id, quantity: s.quantity + can, instance_id:null });
        remaining -= can;
      }
    }
    for (const s of slots) {
      if (remaining<=0) break;
      if (!s.item_id) {
        const put = Math.min(maxS, remaining);
        updatePlayerSlot(guild_id, user_id, s.slot, { item_id, quantity: put, instance_id:null });
        remaining -= put;
      }
    }
    if (remaining>0) throw new Error('Inventario pieno (slot insufficienti)');
  }

  function InventoryRemoveStack({ guild_id, user_id, item_id, amount }) {
    const slots = listPlayerSlots(guild_id, user_id);
    let remaining = amount;
    const stacks = slots.filter(s=>s.item_id===item_id && s.quantity>0).sort((a,b)=>a.quantity-b.quantity);
    for (const s of stacks) {
      if (remaining<=0) break;
      const take = Math.min(s.quantity, remaining);
      const newQ = s.quantity - take;
      if (newQ===0) clearPlayerSlot(guild_id, user_id, s.slot);
      else updatePlayerSlot(guild_id, user_id, s.slot, { item_id, quantity:newQ, instance_id:null });
      remaining -= take;
    }
    if (remaining>0) throw new Error('Quantità insufficiente');
  }

  function InventoryAddUnique({ guild_id, user_id, item_id, payload_json }) {
    const item = qGetItem.get(item_id);
    if (!item) throw new Error(`Item "${item_id}" inesistente nel catalogo MetroInventory`);
    const maxS = item.stack_max || 16;
    if (maxS !== 1) throw new Error('Item non marcato come unico (stack_max=1)');
    const slots = listPlayerSlots(guild_id, user_id);
    const free = slots.find(s=>!s.item_id);
    if (!free) throw new Error('Inventario pieno (nessuno slot libero)');
    const iid = randomUUID();
    updatePlayerSlot(guild_id, user_id, free.slot, { item_id, quantity:1, instance_id:iid });
    qInsertMeta.run(iid, item_id, payload_json || null);
  }

  function InventoryFindUnique(guild_id, user_id, item_id) {
    return qFindUnique.get(guild_id, user_id, item_id);
  }

  function InventoryRemoveUniqueById(guild_id, user_id, instance_id) {
    const row = db.prepare('SELECT slot FROM inventory_slots WHERE guild_id=? AND user_id=? AND instance_id=?').get(guild_id, user_id, instance_id);
    if (!row) throw new Error('Instance non trovata');
    clearPlayerSlot(guild_id, user_id, row.slot);
    qDelMeta.run(instance_id);
  }

  // Organization inventory
  db.exec(`CREATE TABLE IF NOT EXISTS org_inventory_slots (
    guild_id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    item_id TEXT,
    quantity INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, org_id, slot),
    FOREIGN KEY (item_id) REFERENCES items(id) ON UPDATE CASCADE ON DELETE SET NULL
  );`);

  const qOrgSlots = db.prepare('SELECT slot FROM org_inventory_slots WHERE guild_id=? AND org_id=?');
  const qOrgInsertSlot = db.prepare('INSERT INTO org_inventory_slots (guild_id, org_id, slot, item_id, quantity) VALUES (?, ?, ?, NULL, 0)');
  const qOrgList = db.prepare('SELECT * FROM org_inventory_slots WHERE guild_id=? AND org_id=? ORDER BY slot');
  const qOrgUpdate = db.prepare('UPDATE org_inventory_slots SET item_id=?, quantity=? WHERE guild_id=? AND org_id=? AND slot=?');
  const qOrgClear = db.prepare('UPDATE org_inventory_slots SET item_id=NULL, quantity=0 WHERE guild_id=? AND org_id=? AND slot=?');

  function ensureOrgSlots(guildId, orgId) {
    const existing = new Set(qOrgSlots.all(guildId, orgId).map(r=>r.slot));
    for (let s=1; s<=ORG_SLOTS; s++) if (!existing.has(s)) qOrgInsertSlot.run(guildId, orgId, s);
  }

  function listOrgSlots(guildId, orgId) {
    ensureOrgSlots(guildId, orgId);
    return qOrgList.all(guildId, orgId);
  }

  function OrgInventoryAddStack({ guild_id, org_id, item_id, amount }) {
    const item = qGetItem.get(item_id);
    if (!item) throw new Error(`Item "${item_id}" inesistente nel catalogo MetroInventory`);
    const maxS = item.stack_max || 16;
    if (maxS === 1) throw new Error('Item unico non supportato in magazzino');
    const slots = listOrgSlots(guild_id, org_id);
    let remaining = amount;
    for (const s of slots) {
      if (remaining<=0) break;
      if (s.item_id===item_id && s.quantity < maxS) {
        const can = Math.min(maxS - s.quantity, remaining);
        qOrgUpdate.run(item_id, s.quantity + can, guild_id, org_id, s.slot);
        remaining -= can;
      }
    }
    for (const s of slots) {
      if (remaining<=0) break;
      if (!s.item_id) {
        const put = Math.min(maxS, remaining);
        qOrgUpdate.run(item_id, put, guild_id, org_id, s.slot);
        remaining -= put;
      }
    }
    if (remaining>0) throw new Error('Magazzino pieno');
  }

  function transferPlayerToOrg({ guild_id, user_id, org_id, item_id, amount }) {
    InventoryRemoveStack({ guild_id, user_id, item_id, amount });
    OrgInventoryAddStack({ guild_id, org_id, item_id, amount });
  }

  return {
    ensurePlayerSlots,
    listPlayerSlots,
    updatePlayerSlot,
    clearPlayerSlot,
    InventoryAddStack,
    InventoryRemoveStack,
    InventoryAddUnique,
    InventoryFindUnique,
    InventoryRemoveUniqueById,
    ensureOrgSlots,
    listOrgSlots,
    OrgInventoryAddStack,
    transferPlayerToOrg,
  };
};
