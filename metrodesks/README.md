# MetroDesk Bot

Sistema sportelli multi-tenant con transcript e gestione code.

## Setup tecnico
- Dipendenze: `discord.js`, `better-sqlite3`, `dotenv`
- Avvio: `node metrodesk.cjs`
- Variabili d'ambiente: `DISCORD_TOKEN` (obbligatoria), `DB_PATH`

## Comandi principali
- `/tenant-add` – registra un'azienda con categoria canali e ruoli
- `/tenant-list` – elenca aziende registrate
- `/tenant-remove` – rimuove un'azienda
- `/desk-open` – apre uno sportello per un cliente
- `/desk-close` – chiude lo sportello, salvando transcript

## Uso giocatore
1. Registra l'azienda con `/tenant-add`.
2. Gli operatori aprono uno sportello con `/desk-open` e interagiscono con il cliente.
3. Alla fine, chiudono con `/desk-close` per archiviare la conversazione.

