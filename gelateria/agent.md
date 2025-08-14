Gelateria Vanillatte — agent.md

Scopo: guida operativa per lo staff della gelateria su Discord (MetroLife City). Qui trovi ruoli, flussi, comandi e procedure per servire gelati, gestire vetrina/magazzino e emettere scontrini.

⸻

1) Ruoli & permessi
	•	👮‍♂️ Admin RP (fuori azienda): setup iniziale, ricezione sfusi straordinaria, economia futura, mapping SKU↔item. Usano solo comandi amministrativi (non di servizio).
	•	🧭 L1 Direttore / L2 Vice: coordinano turni, ricette, vetrina, controlli stock, scontrini.
	•	👨‍🍳 L3 Capo Turno (Chef) / L4 Responsabile Banco: operatività completa (coda, servizio, vetrina, magazzino pezzi, scontrini).
	•	🍦 L5 Gelataio: può “cucinare” (servire), cioè prendere ticket e preparare; può usare lo scontrino.

Nota: setup/autogive rimangono agli Admin RP. La direzione e lo staff gestiscono solo l’operatività interna.

⸻

2) Flusso servizio (ordine → consegna)
	1.	Cliente ordina dal menu (bottoni) o comando /ordina (con scelta gusti se richiesti).
	2.	Coda: /cucina-coda per vedere i ticket.
	3.	Presa in carico: /cucina-prendi ticket:<id>
	•	Scala automaticamente pezzi (coppette, cucchiaini…) dal magazzino dell’org (qualsiasi area).
	•	Scala scoop dai lotti sfusi in FEFO.
	4.	Consegna al banco: scambia l’item con il cliente tramite MetroTrades.
	5.	Se serve, emetti lo scontrino con `/scontrino`.

⸻

3) Scontrino (bozza → emissione)
	1.	Crea bozza: /scontrino crea metodo:<carta|contanti> [cliente|nome_cliente]
	2.	Aggiungi righe: /scontrino aggiungi menu:<menu_code> quantita:<n> [prezzo_cents]
	3.	Controlla: /scontrino mostra
	4.	Emetti: /scontrino emetti → allega file pdf dall'HTML brand Vanillatte (rosa/bianco/crema)
	5.	Annulla (se serve): /scontrino annulla

Prezzi: se il menu_code esiste in listino, si usa price_cents; altrimenti specifica prezzo_cents.

⸻

4) Vetrina & lotti sfusi
	•	Ricevi lotti (solo Admin RP): /lotti-ricevi sku:<gelato_*> [qty_ml] [scadenza YYYY-MM-DD] [area]
	•	Scadenza default 14 giorni; FEFO automatico.
	•	Elenco lotti: /lotti-elenco [sku] [area] [pubblica:true]
	•	In scadenza: /lotti-in-scadenza
	•	Monta vaschetta in vetrina: /vetrina-monta slot:<1..18> lot_id:<id>
	•	Livelli vetrina: /vetrina-livelli

Convenzioni SKU: gelato_<gusto> (es. gelato_fiordilatte, gelato_nocciola, gelato_cioccolato).

⸻

5) Magazzino pezzi (coppette, cucchiaini, coni)
	•	Inizializza slot (Admin RP una volta): /magazzino-inizializza
	•	Area slot: /magazzino-area slot:<n> area:<BACKSTORE|CUCINA|VETRINA|BAR_FRIGO>
	•	Deposita (dal TUO inventario): /magazzino-deposita slot:<n> sku:<pack_*> quantita:<1..16>
	•	Stato: /magazzino-stato  • Sposta: /magazzino-sposta da:<n> a:<n> quantita:<q>
	•	WH→Player: /magazzino-a-player player:@utente wh_slot:<n> quantita:<q>
	•	Player→WH: /player-a-magazzino player:@utente slot_player:<n> quantita:<q> wh_slot:<n>

Mappa pezzi: collega sku (pz) a item_id dell’inventario player con /mappa-item sku:<pack_*> item_id:<id>. Stack 16 per slot (auto-distribuzione su più slot).

⸻

6) Menu & ordini
	•	Vedi menu: /menu
	•	Pubblica menu (bottoni): /menu-pubblica (prende le prime 5 voci con pulsante “Ordina”).
	•	Ordina manuale: /ordina menu:<code> [gusti:csv] [note]

menu_code = nome item finale consegnato (es. coppetta_2g).

⸻

7) Checklist turno

Apertura
	•	Controlla vetrina: /vetrina-livelli (livelli ≥30%).
	•	Verifica lotti attivi: /lotti-elenco area:VETRINA solo_attivi:true.
	•	Magazzino pezzi OK: /magazzino-stato (coppette, cucchiaini, coni).
	•	Pubblica o verifica menu nel canale.

Durante
	•	Usa /cucina-coda e prendi i ticket appena creati.
	•	Se mancano pezzi: /magazzino-deposita (dal tuo inventario).
	•	Se finiscono i gusti → segnala allo Staff RP (rifornimento lotti).

Chiusura
	•	Controlla lotti in scadenza: /lotti-in-scadenza.
	•	Scarica residui o annota necessità di rifornimento.

⸻

8) Risoluzione problemi
	•	“Stock pezzi insufficiente …” → deposita pezzi nel WH o trasferisci da player.
	•	“Stock sfuso insufficiente …” → chiedi allo Staff RP un nuovo lotto e montalo in vetrina.
	•	“Manca mapping SKU→item_id …” → usa /mappa-item.
	•	“Inventario pieno” (gelataio o cliente) → libera slot o riduci quantità.
	•	Errore FK su consumi → assicurati che la tabella gel_ticket_consumptions referenzi gel_kitchen_tickets.

⸻

9) Convenzioni & dati
	•	Tutti i codici minuscoli.
	•	SKU pezzi: pack_<nome> (es. pack_coppetta_media, pack_cucchiaino).
	•	Item finale = menu_code (es. coppetta_2g).
	•	FEFO per lotti sfusi; scadenza 14 giorni.

⸻

10) Privacy & sicurezza
	•	Evita info personali nei canali pubblici; lo scontrino permette nome_cliente manuale.
	•	Usa comandi con risposte ephemeral quando contengono dettagli interni.

⸻

11) Roadmap sintetica
	•	Integrazione Banca (POS/contanti) → legare scontrino a pagamento.
	•	Comando ritira-ordine (ritiro item dal cliente + chiusura fiscale).
	•	Esportazione PDF e firma degli scontrini.
	•	Allarmi stock vetrina/pezzi con ping automatico.
	•	Ricettario staff-only e report vendite.

⸻

Glossario
	•	FEFO: First-Expire, First-Out (consumo lotti con scadenza più prossima).
	•	SKU: identificatore articolo/vaschetta.
	•	menu_code: codice listino e nome dell’item finale consegnato (es. coppetta_2g).
	•	pz / ml / g: unità per pezzi/sfusi.
