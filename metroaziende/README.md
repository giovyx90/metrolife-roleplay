# MetroAziende Bot

Gestione organizzazioni cittadine: canali, ruoli, brand e contratti di assunzione.

## Setup tecnico
- Dipendenze: `discord.js`, `better-sqlite3`, `pdfkit`, `dotenv`
- Avvio: `node metroaziende.cjs`
- Variabili d'ambiente: `DISCORD_TOKEN` (obbligatoria), `DB_PATH`

## Comandi principali
- `/org-create` – crea una nuova organizzazione
- `/org-channel-create` – crea canali per l'organizzazione
- `/org-channel-edit` – modifica canali esistenti
- `/org-channel-delete` – elimina un canale
- `/org-role-style` – cambia nome/colore ruoli
- `/org-role-setup` – imposta ruoli L1–L5
- `/org-brand` – aggiorna colori e testi pubblici
- `/org-info` – informazioni sull'organizzazione
- `/org-roster` – elenco membri con livello
- `/org-hire` – invia offerta di contratto
- `/org-promote` – promuove un membro
- `/org-demote` – retrocede un membro
- `/org-fire` – licenzia un membro
- `/contract-template` – gestisce template dei contratti
- `/contract-sign` – il candidato accetta/rifiuta l'offerta

## Uso giocatore
1. Il direttore crea la struttura con `/org-create` e configura ruoli e canali.
2. Per assumere un utente, usa `/org-hire` e attendi la firma tramite `/contract-sign`.
3. Aggiorna il brand dell'azienda con `/org-brand`.

