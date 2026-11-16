# Briefkasten-Logik (Huber Alu 400)

Zwei (oder drei) Aqara-Kontaktsensoren liefern nur «Klappe auf / zu». Was im Kasten liegt, muss daraus abgeleitet werden.
Diese Datei beschreibt die Regeln, die in `mailbox-logic.js` umgesetzt und im Simulator (`index.html`) testbar sind.

## Eingänge

| Signal | Quelle | Pflicht |
|---|---|---|
| `slot` auf/zu | Sensor an der Briefschlitz-Klappe | ja |
| `parcel` auf/zu | Sensor an der Paketfach-Klappe | ja |
| `letter` auf/zu | Sensor am Brieffach-Türchen | optional, siehe unten |
| Bewohner in der Nähe | Haustürkontakt, Präsenz, Heimkommen (Loxone/HA) | empfohlen |
| Uhrzeit | Zustellfenster 05:00–07:00 (Frühzustellung Zeitung) und 11:30–14:30 (Pöstler) | ja |

Das Präsenzsignal ist der grösste Hebel: Ein einzelner Kontakt am Paketfach kann «Paket rein» und «Paket raus» nicht unterscheiden. Ohne Präsenzsignal funktioniert die Logik, markiert aber mehr Ergebnisse als «vermutet».

## Ausgänge (MQTT `briefkasten/status`, retained)

- `brieffach`: `leer` / `post`, dazu `brieffach_einwuerfe` und `brieffach_unsicher`
- `paketfach`: `leer` / `belegt`, dazu `paketfach_anzahl` und `paketfach_unsicher`
- `alarm_schlitz_blockiert`, `alarm_paketfach_offen`
- `letztes_ereignis`, `konfidenz` (`sicher` / `vermutet`)

## Grundprinzip: Sitzungen statt Einzelereignisse

Die erste Klappenbewegung startet eine Sitzung. Sie endet, wenn beide Klappen zu sind und 10 s nichts mehr passiert.
Erst dann wird entschieden, anhand von: Anzahl und Dauer der Öffnungen pro Klappe, Präsenz, Zustellfenster und bisherigem Status.
So wird «Klappe dreimal bewegt» ein Einwurf und «Schlitz, dann Paketfach» ein zusammengehöriger Vorgang.

## Schwellwerte (Startwerte, am echten Kasten nachmessen)

| Parameter | Wert | Bedeutung |
|---|---|---|
| `debounce` | 0.4 s | kürzer = Wind/Klappern |
| `peekParcel` | 3 s | Paketfach kürzer offen = nur reingeschaut |
| `emptyMin` | 8 s | Paketfach mindestens so lange offen = Zeit zum Aufschliessen |
| `peekSlot` | 4 s | Schlitz so lange am Stück offen = reinlugen (mit Präsenz: 2 s) |
| `quiet` | 10 s | Ruhezeit bis zur Auswertung |
| `slotStuck` | 20 s | Schlitz so lange offen = Sendung steckt |
| `parcelOpenAlarm` | 60 s | Paketfach so lange offen = Alarm |

## Regeln Paketfach (Variante mit 2 Sensoren)

| Öffnungsdauer | Präsenz | Vorher | Ergebnis |
|---|---|---|---|
| < 3 s | egal | egal | reingelugt, Status bleibt |
| ≥ 8 s | ja | egal | **Leerung**: Brieffach und Paketfach leer (sicher) |
| 3–8 s | ja | Paket da | Paket entnommen, Brieffach bleibt |
| 3–8 s | ja | kein Paket, aber Post | Leerung vermutet (Brieffach leer, unsicher) |
| 3–8 s | ja | alles leer | Kontrolle, Status bleibt |
| ≥ 3 s | nein | kein Paket, im Zustellfenster | **Paket zugestellt** (sicher) |
| ≥ 3 s | nein | kein Paket, ausserhalb Fenster | Paket vermutet (Kurier, Nachbar) |
| ≥ 8 s | nein | kein Paket, Post da, ausserhalb Fenster | Leerung vermutet |
| 3–8 s | nein | Paket da, im Zustellfenster | weiteres Paket vermutet |
| sonst | nein | Paket da | Entnahme vermutet (ab 8 s inkl. Brieffach) |

## Regeln Briefschlitz

Reihenfolge der Prüfung:

1. Wurde in derselben Sitzung eine Entnahme/Leerung erkannt, zählt die Schlitzbewegung nicht (reingelugt vor dem Leeren).
2. Genau eine Öffnung, lang am Stück (≥ 4 s, mit Präsenz ≥ 2 s), und Bewohner in der Nähe oder ausserhalb Zustellfenster: reingelugt, Status bleibt.
3. Alles andere: **Einwurf**, Zähler +1 pro Sitzung (nicht pro Klappenbewegung).

Bleibt der Schlitz länger als 20 s offen, steckt etwas (Zeitung). Das gilt sofort als Post und löst den Alarm «Schlitz blockiert» aus.

## Variante mit drittem Sensor am Brieffach-Türchen

Mit `letterDoor: true` wertet die Logik einen dritten Kontakt (`letter`) aus. Das Türchen lässt sich nur bei offenem Paketfach öffnen und nur mit Schlüssel, also gilt:

- **Türchen ging auf → Leerung, sicher.** Unabhängig von Präsenz, Uhrzeit und Dauer. Das Paketfach gilt dabei ebenfalls als geleert.
- **Türchen blieb zu → das Brieffach ändert sich nie durch eine Paketfach-Öffnung.** Die 8-Sekunden-Schätzung (`emptyMin`) entfällt.
- Für das Paketfach allein bleibt: mit Präsenz Entnahme, ohne Präsenz Zustellung (im Fenster sicher, sonst vermutet); war schon ein Paket drin, im Fenster «weiteres Paket», sonst «Entnahme vermutet».

Was der dritte Sensor löst (Gruppe «Dritter Sensor» im Simulator):

| Fall | 2 Sensoren | 3 Sensoren |
|---|---|---|
| Leeren mittags ohne Präsenzsignal | falsch (Paket zugestellt) | Leerung, sicher |
| Leeren mittags, Paket lag drin, ohne Präsenzsignal | falsch (weiteres Paket) | Leerung, sicher |
| Sperriges Paket holen (12 s), Post bleibt drin | falsch (Leerung) | Paket entnommen |
| Abend-Kurier braucht 10 s, Post liegt drin | falsch (Leerung vermutet) | Paket vermutet |
| Leeren abends ohne Präsenzsignal, schnell leeren | richtig, aber nur vermutet | Leerung, sicher |

Was er nicht löst: Das Paketfach selbst bleibt mehrdeutig (Paket rein oder raus), wenn das Türchen zu bleibt und kein Präsenzsignal da ist. Auch die beiden Schlitz-Grenzfälle bleiben.

`node test.js` vergleicht beide Varianten: 20 von 27 Szenarien richtig mit 2 Sensoren, 24 von 27 mit 3.

## Abgedeckte Fälle

Im Simulator als Knopf vorhanden, `node test.js` prüft alle:

- Brief, mehrere Sendungen, Zeitung früh, Zeitung steckt, Flyer am Nachmittag
- Paket, Brief + Paket, Abend-Kurier, zweites Paket
- Post kommt, während ein Bewohner gerade draussen ist
- Reinlugen durch den Schlitz und ins Paketfach, mit und ohne Präsenzsignal
- Nur Paket holen, alles leeren, erst lugen dann leeren, leeren ohne Präsenzsignal
- Wind/Klappern, Paketfach nicht geschlossen

## Bekannte Grenzen

Diese drei Fälle entscheidet die Logik in beiden Varianten falsch; sie sind im Simulator unter «Grenzfall» nachspielbar:

1. **Nur das Paket mittags geholt, ohne Präsenzsignal**: wird als weiteres Paket gewertet (auch mit drittem Sensor).
2. **Sehr kurzer Blick durch den Schlitz (ca. 1 s)**: nicht vom Einwurf unterscheidbar, zählt als Post.
3. **Dicke Sendung abends langsam eingeschoben**: sieht aus wie reinlugen, wird nicht gezählt.

Dagegen helfen:

- **Korrektur-Taster** in HA/Loxone («Brieffach geleert», «Paketfach geleert»); im Simulator vorhanden.
- **Motorschloss** (später): Ein Entriegeln ist der eindeutige Beweis für eine Brieffach-Leerung und ersetzt die 8-Sekunden-Schätzung.
- **Nachträgliche Präsenz**: Wer heimkommt, ist zuerst am Briefkasten und öffnet erst danach die Haustür. Die Auswertung sollte Präsenz also auch 2–3 Minuten nach der Sitzung noch berücksichtigen. Im Simulator ist das nur eine Checkbox.

## Noch offen für die echte Umsetzung

- Status über Neustarts erhalten (retained MQTT oder HA-Helper).
- Sensor offline oder Batterie leer: Status als «unbekannt» anzeigen statt den alten Wert stehen zu lassen.
- Am echten Kasten messen: Wie lange dauern Einwurf, Reinlugen und Aufschliessen wirklich, und meldet der Sensor sehr kurze Klappenbewegungen zuverlässig?
- Sonntage und Feiertage aus dem Zustellfenster ausnehmen.
