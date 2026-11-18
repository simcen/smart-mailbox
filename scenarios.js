/*
 * Testszenarien für Simulator und test.js.
 * steps: [Sekunde, Sensor, offen?]   Sensoren: slot, parcel, letter (Brieffach-Türchen, nur mit 3. Sensor ausgewertet)
 * pre:   Ausgangslage [Post, Pakete]  truth: verändert die "Realität" (was wirklich im Kasten liegt)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MailboxScenarios = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const o = (sensor, at, dur) => [[at, sensor, true], [at + dur, sensor, false]];
  const seq = (...parts) => [].concat(...parts).sort((a, b) => a[0] - b[0]);
  const mail = r => { r.mail++; }, parcel = r => { r.parcel++; };
  const none = () => {}, empty = r => { r.mail = 0; r.parcel = 0; }, takeParcel = r => { r.parcel = 0; };

  return [
    { group: 'Pöstler', name: 'Brief einwerfen', time: '12:00', resident: false, pre: [0, 0],
      steps: o('slot', 0, 1.2), truth: mail },
    { group: 'Pöstler', name: 'Mehrere Sendungen (Klappe 3×)', time: '12:00', resident: false, pre: [0, 0],
      steps: seq(o('slot', 0, 1), o('slot', 1.8, 0.8), o('slot', 3.4, 1.5)), truth: mail },
    { group: 'Pöstler', name: 'Zeitung Frühzustellung (5 s)', time: '05:45', resident: false, pre: [0, 0],
      steps: o('slot', 0, 5), truth: mail },
    { group: 'Pöstler', name: 'Zeitung steckt im Schlitz (45 s)', time: '05:45', resident: false, pre: [0, 0],
      steps: o('slot', 0, 45), truth: mail, hint: 'Zeitraffer empfohlen' },
    { group: 'Pöstler', name: 'Paket ins Paketfach', time: '12:15', resident: false, pre: [0, 0],
      steps: o('parcel', 0, 6), truth: parcel },
    { group: 'Pöstler', name: 'Brief + Paket', time: '12:15', resident: false, pre: [0, 0],
      steps: seq(o('slot', 0, 1.5), o('parcel', 3.5, 6)), truth: r => { r.mail++; r.parcel++; } },
    { group: 'Pöstler', name: 'Post kommt, Bewohner ist gerade draussen', time: '12:00', resident: true, pre: [0, 0],
      steps: o('slot', 0, 1.2), truth: mail },
    { group: 'Pöstler', name: 'Abend-Kurier legt Paket ein', time: '19:30', resident: false, pre: [0, 0],
      steps: o('parcel', 0, 6), truth: parcel },

    { group: 'Bewohner', name: 'Durch den Schlitz lugen', time: '17:30', resident: true, pre: [1, 0],
      steps: o('slot', 0, 3.5), truth: none },
    { group: 'Bewohner', name: 'Ins Paketfach lugen', time: '17:30', resident: true, pre: [0, 1],
      steps: o('parcel', 0, 2), truth: none },
    { group: 'Bewohner', name: 'Nur Paket holen', time: '17:30', resident: true, pre: [1, 1],
      steps: o('parcel', 0, 5), truth: takeParcel },
    { group: 'Bewohner', name: 'Alles leeren (aufschliessen)', time: '17:30', resident: true, pre: [2, 1],
      steps: seq(o('parcel', 0, 14), o('letter', 4, 7)), truth: empty },
    { group: 'Bewohner', name: 'Erst lugen, dann leeren', time: '17:30', resident: true, pre: [1, 0],
      steps: seq(o('slot', 0, 3), o('parcel', 5, 12), o('letter', 9, 6)), truth: empty },
    { group: 'Bewohner', name: 'Leeren ohne Präsenzsignal (abends)', time: '18:15', resident: false, pre: [1, 0],
      steps: seq(o('parcel', 0, 14), o('letter', 4, 7)), truth: empty },
    { group: 'Bewohner', name: 'Lugen ohne Präsenzsignal (abends)', time: '20:00', resident: false, pre: [1, 0],
      steps: o('slot', 0, 5), truth: none },

    { group: 'Dritter Sensor', name: 'Leeren mittags ohne Präsenzsignal', time: '12:30', resident: false, pre: [1, 0],
      steps: seq(o('parcel', 0, 14), o('letter', 4, 7)), truth: empty, hint: '2 Sensoren: sieht aus wie Paket' },
    { group: 'Dritter Sensor', name: 'Sperriges Paket holen (12 s), Post bleibt drin', time: '17:30', resident: true, pre: [1, 1],
      steps: o('parcel', 0, 12), truth: takeParcel, hint: '2 Sensoren: sieht aus wie Leerung' },
    { group: 'Dritter Sensor', name: 'Abend-Kurier braucht 10 s, Post liegt drin', time: '19:30', resident: false, pre: [1, 0],
      steps: o('parcel', 0, 10), truth: parcel, hint: '2 Sensoren: sieht aus wie Leerung' },
    { group: 'Dritter Sensor', name: 'Leeren mittags, Paket lag drin, kein Präsenzsignal', time: '12:30', resident: false, pre: [1, 1],
      steps: seq(o('parcel', 0, 7), o('letter', 2, 4)), truth: empty, hint: '2 Sensoren: sieht aus wie 2. Paket' },
    { group: 'Dritter Sensor', name: 'Schnell leeren (6 s)', time: '17:30', resident: true, pre: [1, 0],
      steps: seq(o('parcel', 0, 6), o('letter', 2, 3)), truth: empty, hint: '2 Sensoren: nur «vermutet»' },

    { group: 'Störung', name: 'Wind / Klappern', time: '15:00', resident: false, pre: [0, 0],
      steps: seq(o('slot', 0, 0.15), o('slot', 0.6, 0.2), o('slot', 1.4, 0.1)), truth: none },
    { group: 'Störung', name: 'Paketfach nicht geschlossen (75 s)', time: '12:15', resident: false, pre: [0, 0],
      steps: o('parcel', 0, 75), truth: parcel, hint: 'Zeitraffer empfohlen' },
    { group: 'Störung', name: 'Türchen-Sensor meldet Schliessen nicht', time: '17:30', resident: false, pre: [2, 0],
      steps: seq(o('parcel', 0, 14), [[4, 'letter', true]]), truth: empty, hint: 'Nur mit 3 Sensoren relevant' },
    { group: 'Störung', name: 'Flyer am Nachmittag', time: '15:30', resident: false, pre: [0, 0],
      steps: o('slot', 0, 1), truth: mail },

    { group: 'Grenzfall', name: 'Zweites Paket im Zustellfenster', time: '12:30', resident: false, pre: [0, 1],
      steps: o('parcel', 0, 6), truth: parcel },
    { group: 'Grenzfall', name: 'Nur Paket mittags geholt, kein Präsenzsignal', time: '12:30', resident: false, pre: [0, 1],
      steps: o('parcel', 0, 5), truth: takeParcel, hint: 'Sieht aus wie 2. Paket' },
    { group: 'Grenzfall', name: 'Kurzer Blick durch Schlitz (1 s)', time: '17:30', resident: true, pre: [0, 0],
      steps: o('slot', 0, 1), truth: none, hint: 'Zu kurz, um es vom Einwurf zu unterscheiden' },
    { group: 'Grenzfall', name: 'Dicke Sendung abends, langsam eingeschoben', time: '19:00', resident: false, pre: [0, 0],
      steps: o('slot', 0, 6), truth: mail, hint: 'Sieht aus wie reinlugen' }
  ];
});
