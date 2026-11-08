# PostgreSQL-Staging und Neon-Kompatibilität

## Implementiert

Die versionierten Migrationen [001](../db/migrations/001_ingest_staging.sql) und [002](../db/migrations/002_ingest_review_snapshots.sql) legen das eigenständige Schema **efra_ingest** an. Es enthält Quellenrevisionen, Import-Batches, Staging-Zeilen, Quarantäne, Review-Entscheidungen und freigegebene **synthetische Datensnapshots**. Alle Tabellen sind append-only. Der Adapter erzeugt weder Spielerbewertungen noch Ranglisten.

- **Transaktion und Replay.** Der Adapter erhält einen node-postgres-Pool per Konstruktor. Jeder Schreibvorgang hält denselben Client bis Commit oder Rollback. Eindeutige Schlüssel und INSERT ON CONFLICT serialisieren konkurrierende Schreibvorgänge. Ein separates SELECT im selben Read-Committed-Vorgang liest den Gewinner. Das Ergebnis unterscheidet STAGED, ALREADY_STAGED und REVISION_CONFLICT. Ein Replay vergleicht zusätzlich den Hash des kanonischen Dry-Run-Ergebnisses. Zeitstempel und ursprünglicher Inhalt eines angenommenen Batches bleiben erhalten. [node-postgres-Transaktionen](https://node-postgres.com/features/transactions), [PostgreSQL Read Committed](https://www.postgresql.org/docs/18/transaction-iso.html)
- **Quellenrevisionen und Quarantäne.** Die Revision ist je Quelle, Wettbewerb und Saison eindeutig. Geänderte Bytes unter derselben Revision erzeugen einen Konflikt, auch bei geändertem Mapping. Eine Korrektur kann mit neuer Revision auf einen bereits vorhandenen Vorgänger im selben Scope verweisen. In Quarantäne bleiben Fehlergründe und Entscheidungsordinal erhalten, auch bei wiederholter Provider-Zeilen-ID. Die kanonische Quelle für Originalbytes bleibt das spätere Quellenarchiv.
- **Reviews.** Eine Staging-Zeile erhält genau eine abschließende Entscheidung. Ein identischer Retry ist idempotent. Eine abweichende Entscheidung erzeugt einen Konflikt. Unvollständige Zeilen können abgelehnt werden. Eine spätere Freigabe erfordert eine neue vollständige Zeile. PostgreSQL setzt den Review-Zeitpunkt.
- **Snapshots.** Die Mitgliedschaft wird zusammen mit dem Header atomar geschrieben und bei Commit versiegelt. Jede Zeile braucht einen positiven Review bis zum Cutoff und muss Wettbewerb, Saison und Schemaversion entsprechen. Pro Spiel, Spieler und Position ist genau eine Zeile möglich. Ein Replay derselben Snapshot-ID erfordert dieselben Mitglieder und denselben Header. Reads liefern Mitglieder in stabiler Reihenfolge und führen Batch-Key, Hash, Quellrevision, Vorgänger, Mapping-Version und Review mit. Eine spätere Korrektur erzeugt einen neuen Snapshot. Der ursprüngliche Snapshot bleibt reproduzierbar.
- **Datenherkunft.** Der Adapter akzeptiert ausschließlich synthetische Dry Runs. Die Datenbank prüft zusätzlich Herkunftskennzeichnungen in Manifest und Staging-Zeile. Die synthetische Kennzeichnung setzt einen vertrauenswürdigen Decoder und Aufrufer voraus. Sie belegt allein keine tatsächliche Herkunft.

## Geprüfte Kompatibilität mit dem bestehenden Neon-Projekt

Am 8. November 2026 wurden auf dem bestehenden EFRA-Hauptbranch ausschließlich PostgreSQL-Kataloge und Versionsmetadaten gelesen. Der Server meldete PostgreSQL **18.6**. Das Schema **efra** ist vorhanden, **efra_ingest** war frei. Die neuen Migrationen verwenden ausschließlich den eigenen Namensraum und PostgreSQL-Kernfunktionen. Sie haben keine Fremdschlüssel zu bestehenden EFRA-Tabellen. Die Integrationssuite lief lokal auf derselben PostgreSQL-Haupt- und Minorversion. Eine Ausführung auf Neon steht aus.

| Bestehende Struktur | Befund und vorbereitete Zuordnung |
| --- | --- |
| efra.data_sources und efra.external_ids | Quellen und Entitäten verwenden UUIDs. Der Alias-Schlüssel ist je Quelle, Entitätstyp und externem Schlüssel eindeutig. Ein späterer Resolver muss Staging-Textschlüssel eindeutig auf diese UUIDs abbilden und die Quellenrechte separat prüfen. |
| efra.competitions, efra.seasons, efra.games und efra.teams | Spiele verweisen auf Saison und Heim-/Auswärtsteam. Vor einer Übernahme müssen Scope, Teamzuordnung und der Spielzeitbegriff für jede Zeile bestätigt werden. |
| efra.player_appearances | Die bestehende Eindeutigkeit umfasst Spiel, Spieler, Team und Position. Staging verlangt Spiel, Spieler und Position. Bei mehr als einer Teamzuordnung für denselben Schlüssel bleibt die Zeile bis zur Klärung in Quarantäne. Unterschiedliche Positionsrollen bleiben getrennt. |
| efra.import_batches und efra.stat_observations | Das Bestandsschema speichert Batch-Referenz, Rohdaten-Hash sowie einzelne Metrikbeobachtungen mit Status und Verweis auf die ersetzte Beobachtung. Der neue Adapter speichert zunächst geprüfte Spiel-Positionsobjekte. Eine spätere Projektion muss Status, Einheiten, Source-/Batch-UUID und den metrikspezifischen Vorgänger explizit abbilden. Die Provider-Revisionskennung und Snapshot-Mitgliedschaft bleiben im Staging nachweisbar. |
| Bestehende Modell-, Rating- und Rankingtabellen | Der Adapter hat keine Kopplung an diese Tabellen. Ein freigegebener Datensnapshot ist ein versionierter Datenstand für spätere Prüfungen. |

## Nur vorbereitet

- Rollen und Secrets für Import, Review und Snapshot-Lesen müssen in einem getrennten Rollout definiert werden. Der SQL-Entwurf widerruft öffentlichen Schema-Zugriff. Eigentümer- und Administrationsrechte bleiben Betriebsaufgabe. Der Anwendungspool soll mit explizit begrenzten Rechten arbeiten.
- Die Migrationsdateien sind versioniert. Ein Runner mit dauerhaftem Migrationsjournal sowie Migration und Rollenvergabe auf einem isolierten Neon-Branch gehören zum späteren Rollout. Für Migrationen ist eine direkte Verbindung vorgesehen. Kurze Anwendungstransaktionen können über einen Pool laufen, wenn alle Statements denselben Client verwenden. [Neon-Verbindungspooling](https://neon.com/docs/connect/connection-pooling)
- Der UUID-Resolver, die Projektion in das vorhandene EFRA-Schema, die Autorisierung von Reviewern und Provider-Decoder sind Integrationsarbeit. Der Neon-Katalogabgleich belegt den strukturellen Anschluss, die produktionsnahe End-to-End-Abnahme bleibt offen.

## Empirisch oder rechtlich offen

Schriftliche Nutzungsrechte und zulässige Aufbewahrung, Vollständigkeit und Erfassungskonventionen realer Exporte, Konfliktauflösung bei Transfers und Rollen, Mindestabdeckung und unabhängige Modellkalibrierung sind weiterhin offen. Quellenstatus und freigegebene Datensnapshots ersetzen keine empirische Ratingfreigabe.

## Testbericht

- Die **58 vorhandenen synthetischen Tests** und der TypeScript-Build bleiben Bestandteil der normalen CI.
- Die **7 PostgreSQL-Integrationstests** liefen lokal erfolgreich. Eine separate CI-Jobgruppe migriert dafür einen frischen PostgreSQL-18-Service. Die Tests prüfen parallele Replays, konkurrierende Prüfsummen, Quarantäne, verweigerte Freigaben, Rollback mit anschließendem Retry, Herkunftssperren, korrigierte Revisionen, Snapshot-Replay und Cutoff-/Scope-Regeln.
- Lokal wurde PostgreSQL **18.6** in einem kurzlebigen Docker-Container mit ausschließlich synthetischen Fixtures verwendet. Der Integrationsrunner akzeptiert nur eine Loopback-Verbindung zur frischen Datenbank **efra_stage_test** mit dem Testbenutzer **efra_test**. Der Runner bricht ab, wenn das Ziel bereits das EFRA- oder das Staging-Schema enthält.
- Zum Reproduzieren einen frischen PostgreSQL-18-Container mit diesen Testnamen und Loopback-Port starten, **EFRA_TEST_DATABASE_URL** auf den Testendpunkt setzen und **npm run test:postgres** ausführen. Das CI-Workflow-Beispiel enthält die vollständige Testkonfiguration.
