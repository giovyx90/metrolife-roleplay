# MetroInventories Bot

Inventario a 10 slot con stack e oggetti unici, usato da altri servizi della città.

## Setup tecnico
- Dipendenze: `discord.js`, `better-sqlite3`, `dotenv`
- Avvio: `node metroinventories.cjs`
- Variabili d'ambiente: `DISCORD_TOKEN` (obbligatoria), `DB_PATH`

## Comandi principali
- `/inventario` – mostra il tuo inventario
- `/item-upsert` – crea o modifica un tipo di oggetto
- `/item-list` – elenco oggetti disponibili
- `/inv-add` – aggiunge oggetti a un utente
- `/inv-remove` – rimuove oggetti da un utente
- `/inv-move` – sposta oggetti tra slot
- `/inv-clear` – svuota l'inventario di un utente
- `/use` – usa un oggetto (consumo o diminuzione durabilità)

## Uso giocatore
1. Gli admin definiscono gli oggetti con `/item-upsert`.
2. Usa `/inventario` per vedere gli slot e `/use` per consumare o equipaggiare un oggetto.

