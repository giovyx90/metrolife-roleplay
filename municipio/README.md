# Municipio Centrale Bot

Gestione tutorial iniziale, registrazione cittadini e rilascio documenti RP.

## Setup tecnico
- Dipendenze: `discord.js`, `better-sqlite3`, `dotenv`
- Avvio: `node municipiocentrale.cjs`
- Variabili d'ambiente: `DISCORD_TOKEN` (obbligatoria), `DB_PATH`

## Comandi principali
- `/tutorial-finish` – conclude il tutorial e raccoglie i dati anagrafici
- `/municipio-self-register` – il cittadino si registra autonomamente
- `/municipio-cert-check` – verifica se un utente è registrato
- `/municipio-registra` – lo staff registra un cittadino
- `/cdi-emetti` – emette il certificato di identità

## Uso giocatore
1. Completa il tutorial con `/tutorial-finish` inserendo i dati RP.
2. Se richiesto, usa `/municipio-self-register` per registrarti.
3. Dopo l'approvazione, lo staff può emettere il tuo documento con `/cdi-emetti`.

