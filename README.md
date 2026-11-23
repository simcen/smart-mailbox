# smart-mailbox

Statusanzeige für einen Huber Alu 400 mit zwei oder drei Kontaktsensoren (Briefschlitz, Paketfach, optional Brieffach-Türchen).

| Datei | Zweck |
|---|---|
| `index.html`, `scenarios.js` | Simulator im Browser (ohne Server öffnen) |
| `mailbox-logic.js` | Die Logik – einzige Umsetzung, von Simulator und Dienst gemeinsam genutzt |
| `LOGIK.md` | Regeln, Schwellwerte, bekannte Grenzen |
| `test.js` | `npm test` – alle Szenarien mit 2 und 3 Sensoren |
| `service/server.js` | MQTT-Dienst: Sensor-Topics → Status + Diagnose, Home-Assistant-Discovery |
| `service/store.js` | Ablage: PostgreSQL oder JSONL-Dateien |
| `service/replay.js` | Aufgezeichnete Rohereignisse mit anderen Schwellwerten neu auswerten |
| `homeassistant/dashboard.yaml` | Diagnose-Dashboard |
| `Dockerfile`, `docker-compose.yml`, `.env.example` | Betrieb in Coolify / Docker |

## Dienst

Der Dienst abonniert die Sensor-Topics und veröffentlicht (alle retained):

- `briefkasten/status` – Status wie in `LOGIK.md` beschrieben
- `briefkasten/sitzung` – letzte Sitzung: Ablauf der Rohereignisse, erkannter Fall, Begründung, vorher/nachher
- `briefkasten/verlauf` – die letzten 12 Sitzungen
- `briefkasten/empfang` – Empfangsdiagnose: jede Meldung auf den Sensor-Topics, auch die ignorierten
- `briefkasten/batterie` – Batteriespannung pro Sensor (aus `voltage`), «schwach» unter `LOW_VOLTAGE_MV` (Standard 2850 mV)
- `briefkasten/online` – `online` / `offline`

Befehle (`briefkasten/cmd/...`), im Dashboard als Knöpfe:

- `stimmt` – letzte Erkennung bestätigen
- `real` mit `1,0` (Post ja, Paket nein) usw. – realen Inhalt melden: korrigiert den Status und markiert die letzte Sitzung als richtig oder falsch
- `brief_leer`, `paket_leer`, `alles_leer` – Status zurücksetzen

### Ablage

Meldungen, Rohereignisse, Sitzungen samt Bewertung und der Status liegen in PostgreSQL (Dienst `db` in `docker-compose.yml`, Volume `smart-mailbox-db`).
Dazu gehört jede MQTT-Meldung auf den Sensor-Topics, auch die ignorierten; Meldungs-Log und Zähler überleben damit einen Neustart.
Ohne `PGHOST`/`DATABASE_URL` schreibt der Dienst dieselben Daten als JSONL-Dateien nach `DATA_DIR`.

| Tabelle | Inhalt |
|---|---|
| `messages` | jede empfangene Sensor-Meldung mit Payload und Ergebnis |
| `events` | Zustandswechsel auf/zu |
| `sessions` | ausgewertete Sitzungen (`data`) und Bewertung (`feedback`) |
| `kv` | aktueller Status und Batteriewerte |

### Diagnose-Seite

`http://<host>:3180/` zeigt Status, Sensoren (Empfang, Batterie) und alle Sitzungen. Dort lässt sich **jede** Sitzung bewerten, nicht nur die letzte:
«Stimmt» oder «Falsch, real war: …» mit der Aktion, die wirklich passiert ist. Die Bewertung ändert den Status nicht; dafür gibt es «Status korrigieren».
Die Seite hat keine Anmeldung und gehört nur ins LAN. `/health` ist der Healthcheck.

## Funkdiagnose

Der Dienst legt jede Meldung auf den Sensor-Topics mit Empfangszeit und kompletter Payload ab (Tabelle `messages`).
Mit `TOPIC_REFERENCE` (Komma-Liste) schreibt er zusätzlich Vergleichssensoren mit, ohne sie auszuwerten, z.B. `zigbee2mqtt/w8a-tk-z08-west`.

```
curl -s 'http://<host>:3180/api/messages?since=2026-11-18T00:00:00Z' > messages.ndjson
node tools/funk-analyse.js messages.ndjson [--temp aussentemp.csv] > funk-bericht.md
```

Das Skript ermittelt pro Sensor das Lebenszeichen-Intervall, Lücken, LQI- und Spannungsverlauf, verlorene Kontaktmeldungen
(zwei gleiche Zustände hintereinander ausserhalb des Lebenszeichen-Rasters) und gleichzeitige Lücken, und ordnet das Ergebnis
dem Entscheidungsbaum Funk / Coordinator / Mechanik / Batterie zu. `--temp` nimmt eine CSV `zeit,temperatur` (z.B. Ecowitt aus Home Assistant).

## Coolify

1. Ordner in ein Git-Repository legen.
2. In Coolify neues Projekt → Ressource aus dem Repository, Build Pack **Docker Compose** (oder Dockerfile, Port 3000).
3. Umgebungsvariablen gemäss `.env.example` setzen; mindestens `MQTT_URL`, `TOPIC_SLOT`, `TOPIC_PARCEL`, bei drei Sensoren `TOPIC_LETTER`.
4. Die Volumes (`smart-mailbox-db`, `smart-mailbox-data`) legt Compose selbst an. Sie gehören zur Ressource: Wer die Ressource in Coolify löscht und neu anlegt, verliert die Daten.
5. Die Diagnose-Seite liegt auf Host-Port 3180 (Variable `HOST_PORT`); der Container selbst hört immer auf 3000.
6. Der Container muss den Broker `172.16.2.10:1883` im LAN erreichen. Eine öffentliche Domain braucht es nicht.

## Schwellwerte nachstellen

```
curl http://<host>:3180/api/events > events.jsonl
EMPTY_MIN=6 PEEK_SLOT=3 node service/replay.js events.jsonl
```
