# MetroTrade Bot

Sistema di scambio sicuro tra due giocatori con meccanismo escrow a due fasi.

## Setup tecnico
- Dipendenze: `discord.js`, `better-sqlite3`, `dotenv`
- Avvio: `node metrotrades.cjs`
- Variabili d'ambiente: `DISCORD_TOKEN` (obbligatoria), `DB_PATH`

## Comandi principali
- `/trade-open` – avvia uno scambio con un utente
- `/trade-offer-add` – offre oggetti nella trade
- `/trade-offer-remove` – rimuove oggetti dall'offerta
- `/trade-offer-list` – mostra le offerte correnti
- `/trade-ready` – segnala che sei pronto
- `/trade-confirm` – conferma lo scambio (all-or-nothing)
- `/trade-cancel` – annulla la trade
- `/trade-info` – informazioni sulla sessione di scambio

## Uso giocatore
1. Avvia la sessione con `/trade-open @utente`.
2. Aggiungi gli oggetti con `/trade-offer-add` e quando sei pronto usa `/trade-ready`.
3. Entrambi confermano con `/trade-confirm` per completare lo scambio.

