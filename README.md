# EFRA Rating Engine

Eigenständige TypeScript-Bibliothek für positionsbezogene American-Football-Ratings. Das Fundament verarbeitet normalisierte, versionierte Eingaben im Speicher. Derzeit erzeugt es ausschließlich gekennzeichnete QB-Simulationen mit synthetischen Daten.

## Lokal prüfen

Voraussetzung ist Node.js 24 oder neuer.

```sh
npm ci
npm run build
npm test
npm run test:coverage
```

Der Build erzeugt JavaScript und Typdeklarationen in `dist/`. GitHub Actions führt Build, Typprüfung und Simulationstests auf Node.js 24 aus.

## Architektur

- `contracts/` definiert Spieler, Positionen, Einsatznachweise, Spiel- und Saisonstatistiken, Stints, Quellenqualität sowie Versions- und Ergebnisverträge. `src/index.ts` ist der öffentliche Einstiegspunkt. Eingaben sind typisierte, bereits normalisierte Objekte.
- `models/qb/` prüft den Passing-Core, berechnet fünf getrennte Komponenten und kombiniert sie anhand eines explizit gewählten Modellpfads.
- `context/` injiziert eine versionierte Baseline für erwartete Passing-TDs. Sie erhält Versuche, Effizienzmerkmale und Spielkontext. Die Produktion berücksichtigt die Baseline genau einmal.
- `confidence/` berichtet erwartete Spiele, Spiele mit geprüftem Einsatzstatus, Spiele mit vollständigem Core bei belegtem QB-Einsatz und beobachtete Passversuche. Score und Intervall bleiben mangels Kalibrierung leer. Diese Kennzahlen gehen nicht als Punktabzug in die Leistung ein.
- `season/` prüft Saisonzugehörigkeit, Stints, erwartete Spiele, Mehrfachzählung und zeitlichen Schnitt. Innerhalb eines Stints und zwischen Stints dient die Passversuchsmenge als Gewicht der Simulation. Die anschließende SPR-Kalibrierung erfolgt einmal auf dem Saisonwert.
- `overall/` schätzt latente Fähigkeit mit einem separaten, einfachen Zustandsraummodell. Es verarbeitet kompatible latente Evidenz mit expliziter Messvarianz und verwendet eine eigene Kalibrierung. Zwischen Beobachtungen wächst die simulierte Varianz bei positiver Prozessvarianz, während der Erwartungswert konstant bleibt.

## QB-Pipeline

Für den Passing-Core sind Passversuche, Completions, Passing Yards, Passing TDs und Interceptions sowie ein verifizierter QB-Einsatznachweis erforderlich. Nullwerte tragen `VERIFIED_ZERO`. Fehlende, nicht anwendbare, widersprüchliche und zu Forschungszwecken geschätzte Werte haben eigene Zustände. Bei verifizierten null Passversuchen bleiben Passing-Raten nicht anwendbar. Ein verifizierter Nicht-Einsatz ist ein eigener Zustand. Positive Passversuche allein ersetzen den Einsatznachweis nicht.

1. **Passing-Effizienz** berechnet Completions und Passing Yards je Passversuch.
2. **Passing-Produktion** berechnet beobachtete minus erwartete Passing-TDs je Passversuch.
3. **Ballkontrolle** misst Interceptions je Passversuch. Die injizierte Bewertungsfunktion legt die Leistungsrichtung fest.
4. **Rushing-Beitrag** erfasst Yards, TDs und Turnovers je verifiziertem QB-Run.
5. **Situative Wirkung** bildet die Differenz aus beobachteten und erwarteten Punkten über identisch definierte situative Opportunities ab.

`QB_STANDARD_CORE` verlangt die ersten drei Komponenten. `QB_ADVANCED` verlangt alle fünf für jedes Spiel mit Passversuchen. Die beiden Pfade erhalten eigene Parametersätze. Fehlt eine für den gewählten Pfad erforderliche Komponente, liefert die Engine `NOT_RATED`. Eine automatische Neugewichtung oder ein Wechsel des Pfads findet nicht statt. Spiele mit belegtem QB-Einsatz ohne Pässe bleiben in der Abdeckung sichtbar. Eine Saison ohne Passversuche erhält `NOT_RATED`, auch wenn QB-Runs dokumentiert sind. `QB_RUSH_ONLY_SPECIAL` ist als separater Pfad reserviert.

## Annahmen und offene Kalibrierung

- Der Aufrufer liefert die vollständige Liste erwarteter Spiele je Stint für den Bewertungszeitraum. Der Saisonvertrag deckt Teamwechsel innerhalb desselben Wettbewerbs ab. Spielübergreifend müssen Statistiken bereits auf dieselben Konventionen normalisiert sein. Passing Yards sind ganzzahlige, dem Spieler für vollständige Pässe gutgeschriebene Yards und dürfen negativ sein. QB-Runs verwenden eine vorab vereinheitlichte Behandlung von Kneeldowns, Sacks und Scrambles.
- Zeitstempel verwenden UTC im ISO-Format mit Millisekunden. Der Saison-Snapshot muss zum Bewertungszeitpunkt verfügbar sein und darf nur zuvor gespielte Spiele enthalten. Overall verwendet nur kompatible, bis zum Bewertungszeitpunkt verfügbare Evidenz. Der Aufrufer liefert je logischer Overall-Beobachtung genau eine zeitlich passende Revision unter stabiler Evidenz-ID.
- Die Modellversion identifiziert Methode, Parameter, Kontext und Pfad. Aufrufer müssen die Versionsbezeichner an unveränderliche Daten und deterministische Funktionen binden. Die Engine prüft die typisierten Verträge und ausgewählte fachliche Invarianten. Ein Parser für beliebiges JSON, Herkunftsprüfung und Verwaltung von Nutzungsrechten liegen außerhalb dieses Fundaments.
- Es gibt keine eingebauten Modellgewichte, Baselines oder Kalibrierkoeffizienten. Testwerte stehen ausschließlich unter `test/`. Numerische Ergebnisse tragen `SIMULATION`, `PROVISIONAL` und `rankingEligible: false`. Beide Rating-Einstiegspunkte blockieren als real deklarierte Daten. Confidence bleibt `UNCALIBRATED`.
- Empirisch offen sind Referenzpopulationen, Kleinstichproben-Regularisierung, Kontext- und TD-Baselines, Messkonventionen und Vergleichbarkeit zwischen Wettbewerben, Komponententransformationen und Gewichte, Stintgewichtung, SPR- und OVR-Kalibrierung, Prozess- und Messvarianz für Overall sowie Confidence-Intervalle und Freigabeschwellen. Für eine Freigabe fehlen lizenzierte Daten und zeitlich unabhängige Validierung. Die logistische Abbildung und die Zustandsraumgleichung demonstrieren die Schnittstellen mit synthetischen Parametern.

## Testabdeckung

Alle Berechnungstests tragen das Präfix `SIMULATION` und verwenden künstliche Identitäten und Statistiken. Die Tests prüfen die fünf Komponenten gegen erwartete Ergebnisse, die Unterscheidung von null und fehlend, unplausible und widersprüchliche Werte, Kontextresidual, getrennte Modellpfade, Stints und Deduplizierung, Zeitgrenzen, Versionskonflikte, unkalibrierte Confidence und den eigenständigen Overall-Verlauf. Der Coverage-Befehl berichtet Zeilen-, Zweig- und Funktionsabdeckung des ausführbaren Codes.
