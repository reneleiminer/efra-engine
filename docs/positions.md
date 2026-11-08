# Positionsmodelle und gemeinsame Berechnung

Die Kataloge [Offense](../src/models/positions/offense.ts), [Defense](../src/models/positions/defense.ts) und [Special Teams](../src/models/positions/special-teams.ts) benennen für jede Komponente den Zähler, die Exposition, gegebenenfalls den Referenzwert und die Bewertungsrichtung. `describePositionModel(position)` gibt diese Definitionen und ihre Versionskennung aus. Die QB-Verträge und vier QB-Pfade stehen in der [README](../README.md#qb-pipeline).

## Eingänge und Modellvarianten

| Position | Core | Supporting | Advanced |
| --- | --- | --- | --- |
| RB | Yards je Run ohne Fumble, Fumbles je Carry | Receiving Yards je Target | Individuelle Protection-Fehler je Assignment |
| FB | Lead-Block-Wins, Protection-Fehler je Assignment | Konvertierungen je Short-Yardage-Run | Receiving Yards je Target |
| WR | Yards je Target ohne Drop oder Fumble, Fumbles je Catch | Drops je fangbarem Target | Run-Block-Wins je Assignment |
| TE | Receiving ohne Fumble, Inline-Run-Blocking und Pass Protection | Fumbles je Catch | Off-Ball-Blocks in eigener Assignment-Kategorie |
| OT | Pass Protection am Edge und Edge-Run-Blocking | Pre-Snap-Penalties | Separate Second-Level-Assignments |
| OG | Interior Pass Protection und Drive-Blocking | Pre-Snap-Penalties | Pull-Blocks in eigener Assignment-Kategorie |
| C | Center Pass Protection und Interior Run Blocking | Fehler je Exchange | Combo-Blocks in eigener Assignment-Kategorie |
| DT | Interior Pressures je Rush-Snap und Interior Stops je Run-Snap | Fehlversuche beim Open-Field-Tackling | Gap-Kontrolle gegen Double-Teams |
| NT | Anchor-Wins und Nose-Pressures | Fehlversuche beim Open-Field-Tackling | Separate Two-Gap-Assignments |
| EDGE | Edge-Pressures und Contain-Wins | Pre-Snap-Penalties | Separate Bootleg-Contain-Assignments |
| ILB | Interior Run Fits und erlaubte Yards je Coverage-Target | Fehlversuche beim Pursuit-Tackling | Pressures je Interior-Blitz-Snap |
| MLB | Middle Run Fits und erlaubte Yards je Middle-Target | Fehlversuche beim Pursuit-Tackling | Untargeted Crossing-Route-Disruption |
| OLB | Perimeter Run Fits und erlaubte Yards je Flat-Target | Fehlversuche beim Pursuit-Tackling | Pressures je Outside-Blitz-Snap |
| CB | Erlaubte Yards je Target ohne Turnover und verfehlte Run-Support-Tackles | Interceptions je Coverage-Target | Coverage-Wins bei Off-Target-Assignments |
| FS | Erlaubte Yards je tiefem Target und verfehlte tiefe Tackles | Coverage-Penalties | Off-Target Deep Coverage |
| SS | Box Run Fits und erlaubte Yards je kurzem Target | Fehlversuche beim Pursuit-Tackling | Pressures je Safety-Blitz-Snap |
| S | Erlaubte Yards je Target und verfehlte Run-Support-Tackles | Coverage-Penalties | Untargeted Zone Coverage |
| K | Distanzbereinigte Field Goals und Extra-Point-Quote | Kickoff-Platzierung | Onside-Ausführung |
| P | Netto-Feldposition über Erwartung, getrennt für zurückgetragene und nicht zurückgetragene Punts | Fehler bei der Punter-Operation | Handling schwieriger Snaps |
| KR | Return-Yards über Erwartung auf Returns ohne Fumble, Fumbles je Return | Dead-Ball-Penalties | Korrekte No-Return-Entscheidungen |
| PR | Return-Yards über Erwartung auf Returns ohne Fumble, Fumbles je Return | Fair-Catch-Muffs | Korrekte Let-Go-Entscheidungen |
| LS | Präzision getrennt für Punt- und Placekick-Snaps | Sekunden je präzisem Punt-Snap | Blocking in Protection-Assignments |
| Gunner | Release-Wins und verfehlte Tackles | Coverage-Penalties | Zugeordnete erzwungene Fair Catches bei Plays ohne Tackle |

`POSITION_CORE` nutzt Core, `POSITION_SUPPORTING` zusätzlich Supporting und `POSITION_ADVANCED` alle drei Stufen. Jeder Pfad erfordert einen expliziten Satz genau passender Parameter. Ein Pfadwechsel erfordert eine neue, bewusst gewählte Berechnung. Bei fehlender Evidenz bleibt der ausgewählte Pfad `NOT_RATED`. Positionsbezeichnungen dokumentieren tatsächliche Einsätze, etwa eine separate FS- und SS-Zuordnung oder eigenständige WR- und KR-Einsätze desselben Spielers.

## Normalisierung und Doppelzählung

- Jeder verifizierte Einsatz benötigt die Beobachtungen des ausgewählten Pfads in der Modell-Definitionsversion. Eine positive Exposition erfordert eine verifizierte Beobachtung. Nur verifizierte null Exposition überspringt ein Spiel für die betreffende Komponente. Jede aktive Saisonkomponente braucht insgesamt positive Exposition.
- Assignments, Pressures, Coverage-Targets, Tackles, Fumbles und Penalties sind individuell zugeordnet. Eine Rate zählt höchstens ein Ereignis je Opportunity. Yards und Feldpositionsdifferenzen dürfen negativ sein. Zeiten sind nichtnegative Sekunden. Für Field Goals ist die Referenz die Summe der erwarteten Trefferwahrscheinlichkeiten über dieselben Versuche mit bekannten Distanzen.
- Ein Ereigniszähler wird pro Pfad nur einmal verwendet. Die Quellnormalisierung trennt alternative Kategorien wie Clean Returns und Fumbles, Targeted und Off-Target Coverage, Primary- und Zusatz-Blocking sowie allgemeine und spezielle Contain-Assignments. Beispielsweise verwenden RB-Rushing-Yards nur Carries ohne Fumble, während die Security-Rate alle Carries als Exposition nutzt. LS-Snap-Zeit ist auf verifiziert präzise Punt-Snaps konditioniert.
- Bei aggregierten Eingaben liegt die play-genaue Deduplizierung und Zuweisung disjunkter Ereignisse beim Normalisierer. Die Engine prüft Datenstatus, Version, Einsatz, Spielduplikate, Wertebereiche und Nenner. Über verbleibende Korrelation und Leistungsüberlappung entscheiden spätere Redundanz- und Ablationsanalysen.

## Mathematik und Vergleichsgrenzen

Je Spiel ist eine Komponente die gerichtete Rate `d * x / n` oder das Residuum `d * (x - expected) / n`, mit `d = +1` bei erwünschten und `d = -1` bei unerwünschten Ereignissen. Der Saisonmittelwert einer Komponente gewichtet Spielwerte mit ihren jeweiligen Expositionen `n`. Der latente Wert ist die Summe von `weight * scale * (Saisonmittelwert - center)` je Komponente plus gegebenenfalls einem Ligakontextterm. Gewichte sind nichtnegativ und summieren sich auf eins. Skalen sind positiv. Eine separate monotone logistische Simulationsfunktion bildet den latenten Wert auf 0–100 ab.

Ein SPR gilt für einen Spieler, eine Position und eine Wettbewerbssaison. Vereinswechsel innerhalb derselben Wettbewerbssaison werden über Stints zusammengeführt. Ein Wechsel in einen anderen Wettbewerb erzeugt einen getrennten SPR. Overall verarbeitet zeitlich verfügbare latente Beobachtungen mit kompatibler Position, Modellversion und Vergleichsgruppe. Es führt eine getrennte, nach Mess- und Prozessvarianz gewichtete Fähigkeitsschätzung mit eigener Kalibrierung.

Die Vergleichsgruppe `LEAGUE` bindet ein Modell an seine Liga. `BRIDGE_REFERENCE` bindet es an eine gemeinsame Referenz mit explizitem Kontextmodell. Eine Ligadifferenz ist in der Simulation ein präzisionsgewichtetes Mittel direkter, zeitlich verfügbarer Brückenbeobachtungen. Die Varianz ist der Kehrwert der Summe der Präzisionen. Das setzt unabhängige Brückenbeobachtungen mit korrekt orientierten Differenzen und geeigneten Varianzen voraus. Eine Liga ohne direkte Brücke bleibt für diesen Pfad unbestimmt. Der Referenzwert null fixiert den Modellursprung. Der kontextbereinigte SPR addiert die mit einem expliziten Faktor skalierte Ligadifferenz genau einmal. Normalisierte Baselines müssen dafür separat von diesem Ligastärkeeffekt definiert sein.

Eine gemeinsame Vergleichskennung bedeutet technische Kompatibilität innerhalb einer Simulation. Sportliche Vergleichbarkeit erfordert unabhängige Daten, einschließlich überprüfter Brücken bei Ligawechseln. Offen sind Attribution und Messkonventionen pro Wettbewerb, Mindestexpositionen, Cluster- und Stichprobenkorrektur, Kontext- und Distanzbaselines, Referenzpopulationen, Komponentenskalen und Gewichte, Stint-Gewichtungen, zeitliche Modellparameter, getrennte Kalibrierungen sowie Confidence-Intervalle und Freigabeschwellen. Confidence berichtet bis dahin Abdeckung und Exposition ohne Score. Alle Zahlenpfade liefern ausschließlich `SIMULATION` mit `rankingEligible: false`.
