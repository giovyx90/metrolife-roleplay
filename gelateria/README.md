# Gelateria Vanillatte Bot

Bot Discord per gestire la gelateria Vanillatte: ordini, cucina, vetrina, magazzino pezzi e scontrini. Usa la libreria `inventory-core.cjs` per la gestione dell'inventario.

## Setup tecnico
- Dipendenze: `discord.js`, `better-sqlite3`, `dotenv`
- Libreria interna: `../inventory-core.cjs`
- Avvio: `node gelateria.cjs`
- Variabili d'ambiente: `DISCORD_TOKEN` (obbligatoria), `DB_PATH`, `APP_NAME`, `ORG_ID`

## Comandi principali
- `/magazzino-inizializza` – crea 50 slot magazzino
- `/magazzino-area` – imposta area di uno slot
- `/magazzino-deposita` – deposita pezzi dal tuo inventario
- `/magazzino-stato` – mostra i 50 slot
- `/magazzino-sposta` – sposta pezzi tra slot
- `/magazzino-prendi` – preleva un cono o una coppetta
- `/magazzino-a-player` – trasferisce pezzi dal magazzino al player
- `/player-a-magazzino` – trasferisce pezzi dal player al magazzino
- `/lotti-ricevi` – riceve lotto sfuso
- `/lotti-elenco` – elenca lotti con filtri
- `/lotti-in-scadenza` – mostra lotti in scadenza (≤48h)
- `/mappa-item` – mappa SKU gelateria a item inventario
- `/menu` – visualizza menu
- `/menu-pubblica` – pubblica menu con bottoni
- `/ordina` – crea ticket cucina
- `/cucina-coda` – mostra coda ordini
- `/cucina-prendi` – prendi ticket (consuma ingredienti)
- `/cucina-gusto` – aggiunge un gusto al cono/coppetta (3 s per scoop)
- `/vetrina-livelli` – livelli della vetrina
- `/vetrina-monta` – associa lotto a slot vetrina
- `/economia-configura` – configura cap sfusi (staff RP)
- `/tutorial` – guida rapida con embed
- `/scontrino` – gestione scontrino (crea, aggiungi righe, emetti)

## Tutorial giocatore
1. Preleva il contenitore con `/magazzino-prendi cono|coppetta`.
2. Aggiungi i gusti uno alla volta con `/cucina-gusto <gusto>` (3 s per scoop).
3. Scambia l'oggetto farcito con il cliente tramite MetroTrades.
4. Se serve, emetti lo scontrino con `/scontrino` dopo lo scambio.

