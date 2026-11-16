/*
 * Briefkasten-Logik (Huber Alu 400) – zwei Kontaktsensoren:
 *   slot   = Klappe am Briefschlitz
 *   parcel = Klappe/Tür am Paketfach (dahinter liegt das Türchen zum Brieffach)
 *   letter = optional (cfg.letterDoor): Türchen zum Brieffach – macht Leerungen eindeutig
 *
 * Reine Logik ohne DOM/MQTT. Alle Zeiten in Sekunden.
 * Einbindung: Browser (window.MailboxLogic) oder Node (require).
 *
 *   const m = new MailboxLogic.Logic(cfg, (results, state, final) => {...});
 *   m.onContact('slot', true,  t, {resident:false, minuteOfDay:630});
 *   m.onContact('slot', false, t, ctx);
 *   m.tick(t, ctx);            // regelmässig aufrufen (z.B. 1x pro Sekunde)
 *   m.manual('alles_leer', t); // Korrektur-Taster
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MailboxLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const DEFAULTS = {
    letterDoor: false,    // true = dritter Sensor am Brieffach-Türchen vorhanden
    debounce: 0.4,        // kürzere Öffnungen = Klappern/Wind
    peekParcel: 3,        // Paketfach kürzer offen = nur reingeschaut
    emptyMin: 8,          // Paketfach mind. so lange offen = Zeit zum Aufschliessen -> Leerung
    peekSlot: 4,          // Schlitz so lange am Stück offen = reinlugen (mit Präsenz: die Hälfte)
    quiet: 10,            // Ruhezeit nach letzter Bewegung, dann wird die Sitzung ausgewertet
    slotStuck: 20,        // Schlitz so lange offen = etwas steckt (Zeitung)
    parcelOpenAlarm: 60,  // Paketfach so lange offen = Alarm "nicht geschlossen"
    windows: [[5 * 60, 7 * 60], [11 * 60 + 30, 14 * 60 + 30]] // Zustellfenster in Minuten (Frühzustellung, Post)
  };

  function emptyState() {
    return {
      brief: { count: 0, unsicher: false, since: null },
      paket: { count: 0, unsicher: false, since: null },
      alarm: { schlitz: false, paketOffen: false },
      last: null
    };
  }

  class Logic {
    constructor(cfg, onResult) {
      this.cfg = Object.assign({}, DEFAULTS, cfg || {});
      this.onResult = onResult || function () {};
      this.state = emptyState();
      this.session = null;
      this.open = { slot: null, parcel: null, letter: null }; // Zeitpunkt des Öffnens oder null
    }

    inWindow(minuteOfDay) {
      return this.cfg.windows.some(w => minuteOfDay >= w[0] && minuteOfDay < w[1]);
    }

    onContact(sensor, isOpen, t, ctx) {
      ctx = ctx || {};
      if (sensor === 'letter' && !this.cfg.letterDoor) return;
      if (isOpen === (this.open[sensor] !== null)) return; // doppelte Meldung
      if (!this.session) {
        this.session = {
          start: t, slot: [], parcel: [], letter: [], last: t,
          resident: false, inWindow: this.inWindow(ctx.minuteOfDay || 0),
          slotCounted: false
        };
      }
      const s = this.session;
      s.last = t;
      if (ctx.resident) s.resident = true;
      if (isOpen) {
        this.open[sensor] = t;
      } else {
        s[sensor].push(t - this.open[sensor]);
        this.open[sensor] = null;
        if (sensor === 'slot') this.state.alarm.schlitz = false;
        if (sensor === 'parcel') this.state.alarm.paketOffen = false;
      }
    }

    tick(t, ctx) {
      ctx = ctx || {};
      const c = this.cfg, st = this.state, s = this.session;
      if (!s) return;
      if (ctx.resident) s.resident = true;

      // Schlitz bleibt offen -> etwas steckt drin: sofort als Post werten
      if (this.open.slot !== null && t - this.open.slot >= c.slotStuck && !st.alarm.schlitz) {
        st.alarm.schlitz = true;
        if (!s.slotCounted) {
          s.slotCounted = true;
          this._mail(t);
          this._emit([{ code: 'einwurf_steckt', konfidenz: 'sicher',
            text: 'Schlitz bleibt offen – Sendung steckt (z.B. Zeitung). Als Post gewertet.' }], t, false);
        }
      }
      // Paketfach bleibt offen
      if (this.open.parcel !== null && t - this.open.parcel >= c.parcelOpenAlarm && !st.alarm.paketOffen) {
        st.alarm.paketOffen = true;
        this._emit([{ code: 'alarm_paketfach_offen', konfidenz: 'sicher',
          text: 'Paketfach steht offen (nicht richtig geschlossen?).' }], t, false);
      }
      // Sitzung beenden, wenn alles zu und ruhig
      if (this.open.slot === null && this.open.parcel === null && this.open.letter === null && t - s.last >= c.quiet) {
        this._classify(t);
      }
    }

    /** Sekunden bis zur Auswertung, oder null */
    pending(t) {
      const s = this.session;
      if (!s) return null;
      if (this.open.slot !== null || this.open.parcel !== null || this.open.letter !== null) return -1;
      return Math.max(0, this.cfg.quiet - (t - s.last));
    }

    manual(action, t) {
      const st = this.state;
      if (action === 'brief_leer' || action === 'alles_leer') st.brief = { count: 0, unsicher: false, since: t };
      if (action === 'paket_leer' || action === 'alles_leer') st.paket = { count: 0, unsicher: false, since: t };
      this._emit([{ code: 'manuell', konfidenz: 'sicher', text: 'Manuell zurückgesetzt (' + action + ').' }], t, false);
    }

    reset() { this.state = emptyState(); this.session = null; this.open = { slot: null, parcel: null, letter: null }; }

    _mail(t) {
      const b = this.state.brief;
      if (b.count === 0) b.since = t;
      b.count++; b.unsicher = false;
    }

    _classify(t) {
      const s = this.session, c = this.cfg, st = this.state;
      this.session = null;
      const diag = { start: s.start, ende: t, dauer: { slot: s.slot, parcel: s.parcel, letter: s.letter },
        bewohner: s.resident, zustellfenster: s.inWindow, vorher: { brief: st.brief.count, paket: st.paket.count } };
      const S = s.slot.filter(d => d >= c.debounce);
      const P = s.parcel.filter(d => d >= c.debounce);
      const L = s.letter.filter(d => d >= c.debounce);
      const res = [];
      const f = n => n.toFixed(1) + ' s';

      if (!S.length && !P.length && !L.length && !s.slotCounted) {
        this._emit([{ code: 'rauschen', konfidenz: 'sicher',
          text: 'Nur sehr kurze Bewegungen (< ' + c.debounce + ' s) – Wind/Klappern, ignoriert.' }], t, true, diag);
        return;
      }

      let residentAction = false, delivery = false;

      // ---------- Variante mit 3 Sensoren: Brieffach-Türchen entscheidet über Leerung ----------
      if (c.letterDoor && (L.length || P.length)) {
        const pMax = P.length ? Math.max.apply(null, P) : 0;
        const hadPaket = st.paket.count > 0;
        if (L.length) {
          residentAction = true;
          st.brief = { count: 0, unsicher: false, since: t };
          st.paket = { count: 0, unsicher: false, since: t };
          res.push({ code: 'leerung', konfidenz: 'sicher',
            text: 'Brieffach-Türchen wurde geöffnet (' + f(Math.max.apply(null, L)) + ') – Leerung eindeutig, Paketfach gilt ebenfalls als geleert.' });
        } else if (pMax < c.peekParcel) {
          res.push({ code: 'peek_paket', konfidenz: 'sicher',
            text: 'Paketfach nur ' + f(pMax) + ' offen – reingeschaut, Status bleibt.' });
        } else if (s.resident) {
          residentAction = true;
          if (hadPaket) {
            st.paket = { count: 0, unsicher: false, since: t };
            res.push({ code: 'paket_entnommen', konfidenz: 'sicher',
              text: 'Bewohner in der Nähe, Paketfach ' + f(pMax) + ' offen, Brieffach-Türchen blieb zu – nur Paket entnommen.' });
          } else {
            res.push({ code: 'kontrolle', konfidenz: 'sicher',
              text: 'Bewohner hat ins Paketfach geschaut, Brieffach-Türchen blieb zu – Status bleibt.' });
          }
        } else if (!hadPaket) {
          delivery = true;
          st.paket = { count: 1, unsicher: !s.inWindow, since: t };
          res.push(s.inWindow
            ? { code: 'paket_zugestellt', konfidenz: 'sicher',
                text: 'Paketfach ' + f(pMax) + ' offen, Brieffach-Türchen blieb zu, im Zustellfenster – Paket zugestellt.' }
            : { code: 'paket_vermutet', konfidenz: 'vermutet',
                text: 'Paketfach ' + f(pMax) + ' offen, Brieffach-Türchen blieb zu, ausserhalb Zustellfenster – vermutlich Paket (Kurier/Nachbar).' });
        } else if (s.inWindow) {
          delivery = true;
          st.paket.count++; st.paket.unsicher = true;
          res.push({ code: 'weiteres_paket', konfidenz: 'vermutet',
            text: 'Paketfach war belegt, erneut ' + f(pMax) + ' offen im Zustellfenster, kein Bewohner – vermutlich weiteres Paket.' });
        } else {
          residentAction = true;
          st.paket = { count: 0, unsicher: true, since: t };
          res.push({ code: 'entnahme_vermutet', konfidenz: 'vermutet',
            text: 'Paketfach war belegt, ' + f(pMax) + ' offen ausserhalb Zustellfenster – vermutlich Paket entnommen, Brieffach unverändert.' });
        }
      } else
      // ---------- Paketfach (Variante mit 2 Sensoren: Leerung wird über die Dauer geschätzt) ----------
      if (P.length) {
        const pMax = Math.max.apply(null, P);
        const hadPaket = st.paket.count > 0, hadPost = st.brief.count > 0;
        const leerBrief = uns => { st.brief = { count: 0, unsicher: uns, since: t }; };
        const leerPaket = uns => { st.paket = { count: 0, unsicher: uns, since: t }; };

        if (pMax < c.peekParcel) {
          res.push({ code: 'peek_paket', konfidenz: 'sicher',
            text: 'Paketfach nur ' + f(pMax) + ' offen – reingeschaut, Status bleibt.' });
        } else if (s.resident) {
          residentAction = true;
          if (pMax >= c.emptyMin) {
            leerBrief(false); leerPaket(false);
            res.push({ code: 'leerung', konfidenz: 'sicher',
              text: 'Bewohner in der Nähe, Paketfach ' + f(pMax) + ' offen (≥ ' + c.emptyMin + ' s reicht zum Aufschliessen) – alles geleert.' });
          } else if (hadPaket) {
            leerPaket(false);
            res.push({ code: 'paket_entnommen', konfidenz: 'sicher',
              text: 'Bewohner in der Nähe, Paketfach ' + f(pMax) + ' offen – Paket entnommen, Brieffach unverändert.' });
          } else if (hadPost) {
            leerBrief(true);
            res.push({ code: 'leerung_vermutet', konfidenz: 'vermutet',
              text: 'Bewohner in der Nähe, Paketfach war leer, aber Post lag im Brieffach – vermutlich schnell geleert.' });
          } else {
            res.push({ code: 'kontrolle', konfidenz: 'sicher',
              text: 'Bewohner hat nachgeschaut, es war nichts da – Status bleibt.' });
          }
        } else if (!hadPaket) {
          if (!s.inWindow && hadPost && pMax >= c.emptyMin) {
            residentAction = true;
            leerBrief(true); leerPaket(true);
            res.push({ code: 'leerung_vermutet', konfidenz: 'vermutet',
              text: 'Kein Präsenzsignal, aber ausserhalb Zustellfenster, Post lag drin und Paketfach ' + f(pMax) + ' offen – vermutlich Leerung.' });
          } else {
            delivery = true;
            st.paket = { count: 1, unsicher: !s.inWindow, since: t };
            res.push(s.inWindow
              ? { code: 'paket_zugestellt', konfidenz: 'sicher',
                  text: 'Paketfach ' + f(pMax) + ' offen, im Zustellfenster, kein Bewohner – Paket zugestellt.' }
              : { code: 'paket_vermutet', konfidenz: 'vermutet',
                  text: 'Paketfach ' + f(pMax) + ' offen, ausserhalb Zustellfenster, kein Bewohner – vermutlich Paket (Kurier/Nachbar).' });
          }
        } else {
          if (s.inWindow && pMax < c.emptyMin) {
            delivery = true;
            st.paket.count++; st.paket.unsicher = true;
            res.push({ code: 'weiteres_paket', konfidenz: 'vermutet',
              text: 'Paketfach war belegt, erneut ' + f(pMax) + ' offen im Zustellfenster, kein Bewohner – vermutlich weiteres Paket.' });
          } else {
            residentAction = true;
            leerPaket(true);
            if (pMax >= c.emptyMin) leerBrief(true);
            res.push({ code: 'entnahme_vermutet', konfidenz: 'vermutet',
              text: 'Paketfach war belegt, ' + f(pMax) + ' offen ohne Präsenzsignal – vermutlich Entnahme' +
                (pMax >= c.emptyMin ? ' inkl. Brieffach.' : ' (nur Paket).') });
          }
        }
      }

      // ---------- Briefschlitz ----------
      if (S.length && !s.slotCounted) {
        const peekT = s.resident ? c.peekSlot / 2 : c.peekSlot;
        if (residentAction) {
          res.push({ code: 'schlitz_ignoriert', konfidenz: 'sicher',
            text: 'Schlitzklappe bewegt, gehört aber zur Entnahme (reingelugt) – kein Einwurf.' });
        } else if (!delivery && S.length === 1 && S[0] >= peekT && (s.resident || !s.inWindow)) {
          res.push({ code: 'peek_schlitz', konfidenz: s.resident ? 'sicher' : 'vermutet',
            text: 'Schlitz einmal ' + f(S[0]) + ' am Stück offen, ' +
              (s.resident ? 'Bewohner in der Nähe' : 'ausserhalb Zustellfenster') + ' – reingelugt, kein Einwurf.' });
        } else {
          this._mail(t);
          res.push({ code: 'einwurf', konfidenz: 'sicher',
            text: 'Schlitz ' + S.length + '× bewegt (max. ' + f(Math.max.apply(null, S)) + ')' +
              (delivery ? ', zusammen mit Paketzustellung' : '') + ' – Post eingeworfen.' });
        }
      }
      if (!res.length) res.push({ code: 'abschluss', konfidenz: 'sicher', text: 'Sitzung beendet, keine weitere Änderung.' });
      this._emit(res, t, true, diag);
    }

    /** Realen Inhalt setzen (Korrektur aus dem Dashboard) */
    setReal(mail, parcel, t) {
      const st = this.state;
      st.brief = { count: mail ? Math.max(1, st.brief.count) : 0, unsicher: false, since: t };
      st.paket = { count: parcel ? Math.max(1, st.paket.count) : 0, unsicher: false, since: t };
      this._emit([{ code: 'korrektur', konfidenz: 'sicher', text: 'Realer Inhalt gemeldet: ' +
        (mail ? 'Post' : 'keine Post') + ', ' + (parcel ? 'Paket' : 'kein Paket') + '.' }], t, false);
    }

    _emit(results, t, final, diag) {
      this.state.last = { t: t, code: results[results.length - 1].code, konfidenz: results[results.length - 1].konfidenz };
      if (diag) diag.nachher = { brief: this.state.brief.count, paket: this.state.paket.count };
      this.onResult(results, this.state, final, diag);
    }

    /** Flacher Status, wie er per MQTT (retained) an HA / Loxone geht */
    payload() {
      const st = this.state;
      return {
        brieffach: st.brief.count > 0 ? 'post' : 'leer',
        brieffach_einwuerfe: st.brief.count,
        brieffach_unsicher: st.brief.unsicher,
        paketfach: st.paket.count > 0 ? 'belegt' : 'leer',
        paketfach_anzahl: st.paket.count,
        paketfach_unsicher: st.paket.unsicher,
        alarm_schlitz_blockiert: st.alarm.schlitz,
        alarm_paketfach_offen: st.alarm.paketOffen,
        letztes_ereignis: st.last ? st.last.code : null,
        konfidenz: st.last ? st.last.konfidenz : null
      };
    }
  }

  return { Logic: Logic, DEFAULTS: DEFAULTS };
});
