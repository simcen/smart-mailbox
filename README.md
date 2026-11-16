# smart-mailbox

Statusanzeige für einen Huber Alu 400 mit zwei oder drei Kontaktsensoren (Briefschlitz, Paketfach, optional Brieffach-Türchen).

| Datei | Zweck |
|---|---|
| `index.html`, `scenarios.js` | Simulator im Browser (ohne Server öffnen) |
| `mailbox-logic.js` | Die Logik – einzige Umsetzung, von Simulator und Dienst gemeinsam genutzt |
| `LOGIK.md` | Regeln, Schwellwerte, bekannte Grenzen |
| `test.js` | `npm test` – alle Szenarien mit 2 und 3 Sensoren |
| `service/server.js` | MQTT-Dienst: Sensor-Topics → Status + Diagnose, Home-Assistant-Discovery |
| `service/replay.js` | Aufgezeichnete Rohereignisse mit anderen Schwellwerten neu auswerten |
| `homeassistant/dashboard.yaml` | Diagnose-Dashboard |
| `Dockerfile`, `docker-compose.yml`, `.env.example` | Betrieb in Coolify / Docker |

## Dienst

Der Dienst abonniert die Sensor-Topics und veröffentlicht (alle retained):

- `briefkasten/status` – Status wie in `LOGIK.md` beschrieben
- `briefkasten/sitzung` – letzte Sitzung: Ablauf der Rohereignisse, erkannter Fall, Begründung, vorher/nachher
- `briefkasten/verlauf` – die letzten 12 Sitzungen
- `briefkasten/empfang` – Empfangsdiagnose: jede Meldung auf den Sensor-Topics, auch die ignorierten
- `briefkasten/online` – `online` / `offline`

Befehle (`briefkasten/cmd/...`), im Dashboard als Knöpfe:

- `stimmt` – letzte Erkennung bestätigen
- `real` mit `1,0` (Post ja, Paket nein) usw. – realen Inhalt melden: korrigiert den Status und markiert die letzte Sitzung als richtig oder falsch
- `brief_leer`, `paket_leer`, `alles_leer` – Status zurücksetzen

Im Volume `/data` liegen `events.jsonl` (alle Rohereignisse), `sessions.jsonl` (Sitzungen samt Rückmeldung) und `state.json` (Status über Neustarts).
Ohne Home Assistant zeigt `http://<host>:3180/` dieselbe Diagnose als Tabelle; `/health` ist der Healthcheck.

## Coolify

1. Ordner in ein Git-Repository legen.
2. In Coolify neues Projekt → Ressource aus dem Repository, Build Pack **Docker Compose** (oder Dockerfile, Port 3000).
3. Umgebungsvariablen gemäss `.env.example` setzen; mindestens `MQTT_URL`, `TOPIC_SLOT`, `TOPIC_PARCEL`, bei drei Sensoren `TOPIC_LETTER`.
4. Persistenten Speicher auf `/data` einhängen.
5. Die Diagnose-Seite liegt auf Host-Port 3180 (Variable `HOST_PORT`); der Container selbst hört immer auf 3000.
6. Der Container muss den Broker `172.16.2.10:1883` im LAN erreichen. Eine öffentliche Domain braucht es nicht.

## Schwellwerte nachstellen

```
curl http://<host>:3180/api/events > events.jsonl
EMPTY_MIN=6 PEEK_SLOT=3 node service/replay.js events.jsonl
```
