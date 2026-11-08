# EFRA Rating Engine

Eigenständige TypeScript-Bibliothek für positionsbezogene American-Football-Ratings. Sie verarbeitet normalisierte, versionierte Eingaben im Speicher und erzeugt ausschließlich gekennzeichnete Simulationen mit synthetischen Daten.

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
- `models/positions/` enthält die übrigen 23 Positionskataloge. `calculateFieldSeasonPerformance` führt ihre Modelle durch denselben Saison-, Versions- und Kalibrierungsablauf. Die [Positionsmodelle](docs/positions.md) beschreiben die Definitionen und Grenzen.
- `context/` injiziert eine versionierte Baseline für erwartete Passing-TDs. Sie erhält Versuche, Effizienzmerkmale und Spielkontext. Die Produktion berücksichtigt die Baseline genau einmal.
- `confidence/` berichtet erwartete Spiele, Spiele mit geprüftem Einsatzstatus, Spiele mit vollständigem Core bei belegtem QB-Einsatz und beobachtete Passversuche. Score und Intervall bleiben mangels Kalibrierung leer. Diese Kennzahlen gehen nicht als Punktabzug in die Leistung ein.
- `season/` prüft Saisonzugehörigkeit, Stints, erwartete Spiele, Mehrfachzählung und zeitlichen Schnitt. Je Komponente werden die Spielwerte über alle Stints mit ihrem eigenen Nenner gemittelt. Die SPR-Kalibrierung erfolgt einmal nach der gewichteten Kombination der Komponenten.
- `overall/` schätzt latente Fähigkeit mit einem separaten, einfachen Zustandsraummodell. Es verarbeitet kompatible latente Evidenz mit expliziter Messvarianz und verwendet eine eigene Kalibrierung. Zwischen Beobachtungen wächst die simulierte Varianz bei positiver Prozessvarianz, während der Erwartungswert konstant bleibt.
- `context/league-strength.ts` schätzt in einem expliziten Simulationspfad positionsbezogene Ligadifferenzen aus synthetischen Transfer- oder Interleague-Brücken zu einem festen Referenzwettbewerb.

## QB-Pipeline

Für den Passing-Core sind Passversuche, Completions, Passing Yards, Passing TDs und Interceptions sowie ein verifizierter QB-Einsatznachweis erforderlich. Nullwerte tragen `VERIFIED_ZERO`. Fehlende, nicht anwendbare, widersprüchliche und zu Forschungszwecken geschätzte Werte haben eigene Zustände. Bei verifizierten null Passversuchen bleiben Passing-Raten nicht anwendbar. Ein verifizierter Nicht-Einsatz ist ein eigener Zustand. Positive Passversuche allein ersetzen den Einsatznachweis nicht.

1. **Passing-Effizienz** berechnet Completions und Passing Yards je Passversuch.
2. **Passing-Produktion** berechnet getrennte Residuen für Passing-TDs und in erweiterten Pfaden für First Downs aus vollständigen Pässen ohne Touchdown. Beide Referenzfunktionen erhalten Passversuche, Completion Rate, Yards pro Versuch und Spielkontext. Die Produktion verwendet Yards und Completion Rate als Prädiktoren der Baseline. TD und First Down ohne TD sind disjunkte Ereignisse.
3. **Ballkontrolle** misst Interceptions je Passversuch. Die injizierte Bewertungsfunktion legt die Leistungsrichtung fest.
4. **Rushing-Beitrag** erfasst Yards, TDs und Turnovers je verifiziertem QB-Run.
5. **Situative Wirkung** bildet die Differenz aus beobachteten und erwarteten Punkten je vorab definiertem situativem QB-Sack ab. Diese Ereignisse sind aus Passversuchen und QB-Runs ausgeschlossen.

- `QB_STANDARD_CORE` verwendet die ersten drei Komponenten mit TD-Residuum.
- `QB_EXTENDED_PRODUCTION` ergänzt das First-Down-Residuum mit expliziter Definitionsversion für alle Spiele mit Passversuchen.
- `QB_ADVANCED` erfordert zusätzlich vollständige Rushing- und versionierte situative Daten bei jedem belegten QB-Einsatz. Verifizierte null Opportunities liefern keine Beobachtung für die jeweilige Komponente. Positive Runs oder situative Opportunities zählen auch in Spielen und Stints mit null Passversuchen.
- `QB_RUSH_ONLY_SPECIAL` besitzt ein eigenes Simulationsmodell und eine separate Kalibrierung. Es erfordert vollständigen, auf null verifizierten Passing-Core in jedem Einsatzspiel sowie vollständig belegte Rushing-Daten mit mindestens einer Opportunity. Der Pfad ist für Overall und Rankings gesperrt.

Pro Komponente ist der Saisonwert das mit dem jeweiligen Nenner gewichtete Mittel der transformierten Spielwerte. Anschließend werden die für den Pfad vorgegebenen Komponenten mit festen Gewichten kombiniert. Fehlende Pflichtevidenz blockiert den Pfad. Gewichte werden weder bei Datenlücken noch bei vollständig fehlender Exposition umverteilt. Overall akzeptiert nur Evidenz mit derselben Pfad-, Methoden-, Parameter-, Kontext- und Feature-Definition wie im jeweiligen Evidenzmodell. Eine gemeinsame Skala zwischen Pfaden erfordert weiterhin unabhängige Brücken- und Ablationsanalysen.

## Annahmen und offene Kalibrierung

- Der Aufrufer liefert die vollständige Liste erwarteter Spiele je Stint für den Bewertungszeitraum. Der Saisonvertrag deckt Teamwechsel innerhalb desselben Wettbewerbs ab. Spielübergreifend müssen Statistiken bereits auf dieselben Konventionen normalisiert sein. Passing Yards sind ganzzahlige, dem Spieler für vollständige Pässe gutgeschriebene Yards und dürfen negativ sein. QB-Runs verwenden eine vorab vereinheitlichte Behandlung von Kneeldowns, Sacks und Scrambles.
- Zeitstempel verwenden UTC im ISO-Format mit Millisekunden. Der Saison-Snapshot muss zum Bewertungszeitpunkt verfügbar sein und darf nur zuvor gespielte Spiele enthalten. Overall verwendet nur kompatible, bis zum Bewertungszeitpunkt verfügbare Evidenz. Der Aufrufer liefert je logischer Overall-Beobachtung genau eine zeitlich passende Revision unter stabiler Evidenz-ID.
- Die Modellversion identifiziert Methode, Parameter, Kontext und Pfad. Aufrufer müssen die Versionsbezeichner an unveränderliche Daten und deterministische Funktionen binden. Die Engine prüft die typisierten Verträge und ausgewählte fachliche Invarianten. Ein Parser für beliebiges JSON, Herkunftsprüfung und Verwaltung von Nutzungsrechten liegen außerhalb dieses Fundaments.
- Es gibt keine eingebauten Modellgewichte, Baselines oder Kalibrierkoeffizienten. Testwerte stehen ausschließlich unter `test/`. Numerische Ergebnisse tragen `SIMULATION`, `PROVISIONAL` und `rankingEligible: false`. Beide Rating-Einstiegspunkte blockieren als real deklarierte Daten. Confidence bleibt `UNCALIBRATED`.
- Empirisch offen sind Referenzpopulationen, Kleinstichproben-Regularisierung, Kontext- und TD-Baselines, Messkonventionen und Vergleichbarkeit zwischen Wettbewerben, Komponententransformationen und Gewichte, Stintgewichtung, SPR- und OVR-Kalibrierung, Prozess- und Messvarianz für Overall sowie Confidence-Intervalle und Freigabeschwellen. Für eine Freigabe fehlen lizenzierte Daten und zeitlich unabhängige Validierung. Die logistische Abbildung und die Zustandsraumgleichung demonstrieren die Schnittstellen mit synthetischen Parametern.

## Testabdeckung

Alle Berechnungstests tragen das Präfix `SIMULATION` und verwenden künstliche Identitäten und Statistiken. Sie prüfen die QB-Komponenten und Sonderpfade, alle drei Varianten der übrigen 23 Positionen, fehlende oder widersprüchliche Daten, Transfers und Mehrfachpositionen, Versionskonflikte, Ligabrücken, unkalibrierte Confidence und den eigenständigen Overall-Verlauf. Der Coverage-Befehl berichtet Zeilen-, Zweig- und Funktionsabdeckung des ausführbaren Codes.

## Modellvalidierung

Das [Studienprotokoll für die Modellvalidierung](docs/model-validation.md) beschreibt versionierte Referenzpopulationen, zeitlich getrennte Stichproben, Fehlerdiagnosen für SPR, OVR und Confidence sowie offene Freigabekriterien. Der getrennte Einstiegspunkt `runSyntheticValidation` liefert ausschließlich synthetische Forschungsberichte.

Die [kanonische Validierungsbrücke und Holdout-Verwaltung](docs/canonical-validation-holdout.md) verbindet synthetische kanonische Releases mit dem Studienprotokoll und dokumentiert Rechte, Prüfpfade und offene Freigabeschritte.

Die [Sicherheitsgrundlage für den synthetischen Pilotbetrieb](docs/pilot-security.md) beschreibt isolierte Endpunkte, authentifizierte Aktionen, signierte Läufe und Berichte sowie Betriebs- und Wiederherstellungsprüfungen.

Das [lokale synthetische Pilotprofil](docs/secure-pilot-infrastructure.md) startet mit `npm run pilot:verify`. Die Abnahme prüft isolierte PostgreSQL-Instanzen, Worker, Rotation, Alarmierung und den Backup- und Restore-Pfad.

Der [Quellenreifebericht](docs/source-readiness-2026.md) und die [maschinenlesbare Evidenzmatrix](docs/evidence-coverage-v1.json) erfassen öffentliche Feldkandidaten, API-Prüfstatus, Rechte und fehlende Nachweise für alle Positionsmodelle. Die versionierten Quellenports und das Film-Lab-Vertragsmodell sind für synthetische Prüfungen vorgesehen.
