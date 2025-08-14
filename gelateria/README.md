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
- `/cucina-pronto` – segnala ticket pronto
- `/cucina-autopronto` – pronto automatico dopo tempo
- `/vetrina-livelli` – livelli della vetrina
- `/vetrina-monta` – associa lotto a slot vetrina
- `/economia-configura` – configura cap sfusi (staff RP)
- `/tutorial` – guida rapida con embed
- `/scontrino` – gestione scontrino (crea, aggiungi righe, emetti)

## Tutorial giocatore
1. Visualizza il menu con `/menu` e ordina con `/ordina`.
2. Lo staff vede la coda con `/cucina-coda`, prende l'ordine con `/cucina-prendi` e consegna con `/cucina-pronto`.
3. Per pagare, usa `/scontrino` per creare ed emettere lo scontrino.

