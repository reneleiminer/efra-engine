# Geprüfte Datenimporte und Vorbereitung für PostgreSQL über Neon

## Gegenstand dieses Schritts

Der TypeScript-Einstiegspunkt **planImport** prüft offline bereits typisierte, normalisierte, synthetische Spieler-Spiel-Positionszeilen. Er liefert einen deterministischen Dry Run mit Staging-, Datenlücken- und Quarantäneentscheidungen. Der Importpfad beginnt erst nach einem zukünftigen quellenspezifischen Decoder und einer expliziten Zuordnung stabiler IDs. Ein Dry Run ist ein Qualitätsbefund, keine Freigabe für Ratings oder Veröffentlichung.

| Stufe | Eingänge und Entscheidungen |
| --- | --- |
| Quellenregister und Nutzungsrechte | Provider, Wettbewerb, Saison, Spielphase, Erfassungs- und Mapping-Version, erlaubte Zwecke, Zugangsweg, Rechte-Nachweis, Laufzeit, Aufbewahrung und verantwortliche Prüfer. Die aktuelle Code-Policy akzeptiert ausschließlich registrierte synthetische Fixtures. |
| Entgegennahme | Autorisierten Export im Original hashen und Zeit, Format, Scope, Provider-Revision und Checksumme in einem unveränderlichen Manifest festhalten. Der Decoder prüft die Bytes gegen den Hash und lehnt unerwartete Header und Einheiten ab. Dieser Schritt liegt vor dem implementierten Dry Run. |
| Normalisierung | Provider-IDs für Spieler, Team, Spiel und Saison über versionierte Aliase abgleichen. Spielphase und Teamzuordnung über den Spielplan auflösen. Rollen brauchen unabhängige Einsatz-Evidenz. Gleiche Spieler mit verschiedenen Positionen bleiben getrennte Zeilen. |
| Qualitätsprüfung | Explizite Null, fehlend, nicht anwendbar und konfligierend getrennt führen. Der Dry Run prüft Manifest, Mapping, Datenstände, Quellrevision, bestätigten Einsatz, Dubletten, fachliche QB-Core-Invarianten und verfügbare Evidenz anderer Positionen gegen den Modellkatalog. Zeilen mit unvollständigem Core bleiben ausdrücklich unvollständig. Kollisionen und widersprüchliche Evidenz gehen in Quarantäne. |
| Fachlicher Abgleich | Je Anbieter und Spielart zulässige Stichprobe mit Box Score, Spielprotokoll oder unabhängigem Charting vergleichen. Erwartete Spiele und Positionsrollen vorgeben. Coverage je Feld getrennt für erfasst, fehlend, Null, N/A und Konflikt berichten. Für Sacks, Kneeldowns, No Plays, Fumbles, Blocks und Transferfälle Referenzfälle prüfen. |
| Freigabe | Ein versionierter Review mit benanntem Prüfer und Begründung schließt einen unveränderlichen Snapshot. Offene Konflikte bleiben außerhalb der freigegebenen Sicht. Korrekturen erzeugen eine neue Revision mit Verweis auf die ersetzte Zeile. Bewertungs- und Veröffentlichungsfreigabe sind getrennte Entscheidungen. |

**STAGE** beschreibt eine Zeile, die die implementierten Prüfungen bestanden hat. Für optionale Felder, vollständige Spieler-/Spielabdeckung, Referenzfunktionen und Ratings gelten weitere Gates. **STAGE_INCOMPLETE** bewahrt bekannte Beobachtungen ohne Imputation. **QUARANTINE** liefert Gründe und die Provider-Zeilen-ID für die Korrektur. Die Rohbytes müssen im freigegebenen Quellenarchiv referenzierbar bleiben. Der Dry Run prüft die Form des Hashs. Die Übereinstimmung mit den Originalbytes ist Aufgabe des zukünftigen Decoders.

## PostgreSQL-Speichervertrag

**ImportStageStore** trennt den reinen Qualitätsentscheid von der Transaktion. Die folgende Tabelle dokumentiert den ursprünglichen Entwurf. Die [implementierten Migrationen und der Neon-Katalogabgleich](postgres-staging.md) beschreiben den aktuellen Stand.

| Relation | Daten und Invarianten |
| --- | --- |
| source_policy | Interne ID, Quelle, Wettbewerb und Saison, Rechte-Nachweis, Mapping-Version und Genehmigungsstatus. Rechteentscheidungen sind versioniert. |
| import_batch | Unveränderliches Manifest. Unique über Quelle, Wettbewerb, Saison, Quellenrevision, Mapping- und Schemaversion. Zusätzlich Checksumme und Retrieval-Zeitpunkt. Dieselbe fachliche Revision mit abweichender Checksumme ergibt REVISION_CONFLICT. |
| import_row | Fremdschlüssel auf Batch, stabiler Positionsschlüssel aus Spiel, Spieler und Rolle, Provider-Zeilen-ID und normalisierte Beobachtungen. Für Staging-Zeilen je Batch beide Schlüssel eindeutig. |
| import_quality_issue | Fremdschlüssel auf Batch, Referenz auf Provider-Zeile und ursprünglichen Artefakt-Index für kollidierende Zeilen, Fehlercode und Prüfversion. |
| review_decision | Append-only, verweist auf Zeile, Prüfer, Zeit, Grund und ersetzte Revision. Freigaberechte getrennt von Importrechten. |
| approved_snapshot / snapshot_row | Versionsmanifest und referenzierte, freigegebene Zeilen. Eindeutigkeit je Snapshot, Spiel, Spieler und Position. Filter auf Zeitpunkt der belegten Verfügbarkeit für reproduzierbare Ratings. |

Die Staging-Transaktion reserviert zuerst den Revisionsschlüssel atomar. Bei identischem Hash liefert sie ALREADY_STAGED; bei abweichendem Hash REVISION_CONFLICT. Der erste erfolgreiche Lauf persistiert Manifest, Zeilen und Qualitätsentscheidungen gemeinsam. Ein Abbruch rollt alle drei zurück. Eine vorläufige Quarantäneauflösung ändert keinen publizierten Snapshot. Eine spätere Freigabe erzeugt einen neuen, atomaren Snapshot. Die Anwendung erhält ausschließlich Zugriff auf die für ihre Rolle vorgesehenen Tabellen oder Sichten.

## Neon-Anbindung und offene Entscheidungen

1. Projekt, Region und isolierten Prüfbranch für ausschließlich synthetische Daten festlegen. Die bestehende Engine hat keinen DB-Treiber. Ein künftiger Adapter erhält einen injizierten, transaktionsfähigen PostgreSQL-Client.
2. Migration und Rollen in einem eigenen PR entwerfen und auf einem isolierten leeren oder Schema-only-Branch mit synthetischen Fixtures prüfen. Migrationen verwenden eine direkte Verbindung. Die spätere Anwendung kann für kurze Transaktionen eine gepoolte Verbindung verwenden. Verbindungsdaten bleiben im Secret Store. [Neon Branching](https://neon.com/docs/introduction/branching), [Neon Connection Pooling](https://neon.com/docs/connect/connection-pooling)
3. Adapter-Integration mit parallelen Replays, Crash-Rollback, Revisionskonflikten, verweigerten Rechten und stichtagsgebundenen Snapshot-Reads prüfen. Idempotenz stützt sich auf Datenbank-Constraints und eine Transaktion, nicht auf eine vorgelagerte Existenzabfrage.
4. Offene Entscheidungen betreffen Lieferformat und Rechte pro Quelle, die Auslegung von Provider-Revisionen, Aufbewahrung und Datenschutz, Identitätsauflösung bei Transfers, getrennte Review-Rollen, Mindestabdeckung für eine Pilotfreigabe und empirische Validierung der Modellreferenzen.

Die initiale Importphase lieferte den lokalen Dry Run, den Storage-Port und den Speicherentwurf. Der aktuelle Adapter und sein Testbericht stehen in der [PostgreSQL-Staging-Dokumentation](postgres-staging.md).
