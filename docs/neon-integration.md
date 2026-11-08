# Isolierte Neon-Integration und End-to-End-Test

## Implementiert

- **UUID-Auflösung.** Der Importer löst Anbieter-Aliasse für Spieler, Teams, Spiele und Ligen über den vorhandenen eindeutigen Schlüssel in **efra.external_ids** auf. Ligen werden als **competitions** geführt. Der vorhandene Entity-Type-Check unterstützt keine Saisons. Die separate, quellen- und wettbewerbsbezogene Tabelle **efra_ingest.season_alias** ordnet den externen Saisonschlüssel einer UUID aus **efra.seasons** zu. Die Auflösung sucht ausschließlich in der expliziten Allowlist synthetischer Quellen. Fehlende, verwaiste oder fachlich widersprüchliche Zuordnungen gehen in Quarantäne. Eine fehlende Liga- oder Saisonzuordnung blockiert den Batch.
- **Spielkontext und Transfers.** Ein Spiel muss final sein und zur aufgelösten Saison gehören. Team und Gegner müssen den kanonischen Spielteilnehmern entsprechen. Für einen als gespielt gemeldeten Einsatz verlangt die Auflösung einen verifizierten Auftritt mit positiven Snaps für genau diese Position und dieses Team. Eine zweite Teamzuordnung im selben Spiel und derselben Position sperrt die Zuordnung. Ein Transfer in einem späteren Spiel verwendet dieselbe Spieler-UUID und die neue Team-UUID. QB und WR desselben Spielers im selben Spiel bleiben eigenständige Schlüssel. Ein gemeldeter Nicht-Einsatz wird durch einen vorhandenen Auftritt blockiert. Fehlende Auftritte werden nicht als Nicht-Einsatz erzeugt.
- **Datenbankgrenzen.** Migration 003 ergänzt einen festen Namensraum, geprüfte kanonische Staging-Schlüssel und transaktionsgebundene Batch-Mitgliedschaft. Nach dem Commit können auch berechtigte Importeure keine Staging- oder Quarantänezeilen an denselben Batch anhängen. Der Alias-Resolver ist eine gezielt freigegebene Security-Definer-Funktion mit festem Suchpfad. Import und Quarantäne führen keine Ratings aus.

| PostgreSQL-Rolle | Erlaubt | Abgegrenzter Zugriff |
| --- | --- | --- |
| efra_ingest_importer | UUID-Auflösung aufrufen, Revisions-/Batch-Metadaten lesen und Staging oder Quarantäne im neuen Batch schreiben | Kein Direktzugriff auf Spieler- oder Review-Tabellen |
| efra_ingest_reviewer | Staging, Quarantäne und Prüfdaten lesen, abschließende Reviews und Snapshots anlegen | Keine Schreibrechte auf Staging oder Quarantäne |
| efra_ingest_reader | Freigegebenen Snapshot über die Export-View und **PostgresApprovedSnapshotReader** abrufen | Keine Roh-, Quarantäne- oder Schreibrechte |

Die Rollen sind **NOLOGIN**. Die Tests weisen sie dem isolierten Test-Owner zu und verbinden jede Testsitzung mit genau einer Rolle. Spätere Service-Logins und ihre Mitgliedschaften werden getrennt provisioniert. Snapshot-Freigabe ist eine Datenentscheidung, keine Freigabe für Rankings. [PostgreSQL-Rollenmitgliedschaft](https://www.postgresql.org/docs/18/role-membership.html), [Neon-Rollenverwaltung](https://neon.com/docs/manage/roles)

## Ausführung und Prüfergebnisse

Am 8. November 2026 wurde der isolierte Neon-Branch **efra-test-neon-integration-20261108** aus dem vorhandenen EFRA-Stand erstellt. Vor dem Schreiben bestätigten lesende Abfragen auf dem Testbranch PostgreSQL 18.6, die vorhandene EFRA-Struktur und leere Spieler-, Spiel-, Einsatz- und Beobachtungstabellen. Der Runner prüfte zusätzlich die vom Server gemeldete Neon-Branch-ID und den direkten TLS-Endpunkt. Nur dort wurden Migrationen 001–003, Test-Rollenmitgliedschaften und synthetische Fixtures eingespielt. Die Fixture-Zahlen sind ausschließlich Simulationswerte.

| Prüfung | Ergebnis |
| --- | --- |
| Bestehende synthetische Tests und PostgreSQL-Staging-Regressionen | 58 + 7 bestanden |
| Vollständiger Ablauf unter getrennten Rollen | UUID-Auflösung → fachlicher Dry Run → Quarantäne → Review → Snapshot → Zugriff über Export-View. Lokal und auf Neon bestanden. |
| Transfers, Mehrfachpositionen und Rollenverbote | Derselbe Spieler wurde in zwei Spielen mit verschiedenen Teams und im ersten Spiel separat als QB und WR übernommen. Falsches Team, falsche Saison und direkte Rohzugriffe wurden abgewiesen. |
| Parallelität, Revision und Rollback | Vier gleichzeitige Replays ergaben genau einen Commit. Zwei abweichende Prüfsummen derselben Revision hatten genau einen Gewinner. Eine fehlerhafte späte Quarantäne-Zeile rollte den Batch zurück. Ein nachträglicher Eintrag in einen abgeschlossenen Batch wurde abgewiesen. |
| Reproduzierbarkeit | Kanonisch gleiche Spiel-Aliasse wurden als Dublette erkannt. Ein Snapshot ohne Review scheiterte. Ein identischer Snapshot-Retry mit umsortierten IDs lieferte denselben Datensnapshot. |
| Produktionsbranch nach dem Test | Lesende Nachkontrolle bestätigte die Abwesenheit des Staging-Schemas und der neuen Rollen sowie weiterhin leere Spieler-, Spiel- und Beobachtungstabellen. |

Der erste Branch-Antrag mit einem expliziten Suspend-Intervall wurde vom Tarif mit HTTP 412 abgewiesen. Der Retry mit den Standardwerten legte den Testbranch an. Die erste Verbindungsprüfung wies den vom Connector angebotenen Pooling-Endpunkt vor jeder Migration ab. Der zweite Versuch verwendete den bestätigten direkten Testendpunkt mit TLS-Verifikation. [Neon-Verbindungspooling](https://neon.com/docs/connect/connection-pooling)

Der Testbranch enthielt nach dem Lauf drei Quellenrevisionen, vier Staging-Zeilen, drei Quarantäneentscheidungen, drei Reviews und einen synthetischen Snapshot. Die kanonische Tabelle **efra.stat_observations** blieb leer.

## Reproduktion und offene Aufgaben

- **Lokal und CI.** Die PostgreSQL-18-CI startet getrennte Services für die 7 Staging-Regressionen und die 2 Neon-Kompatibilitäts- und E2E-Tests. Lokal verwendet **npm run test:neon-integration** eine frische Loopback-Testdatenbank **efra_stage_test**. Die lokale EFRA-Schema-Fixture enthält den für die Auflösung benötigten Ausschnitt. Der Neon-Lauf verwendet das vorhandene Schema.
- **Isolierter Neon-Branch.** Den direkten Branch-Endpunkt als **EFRA_NEON_TEST_DATABASE_URL** mit **sslmode=verify-full** sowie **EFRA_NEON_TEST_BRANCH_ID** und **EFRA_NEON_PRIMARY_BRANCH_ID** setzen. Die IDs müssen verschieden sein. Die bestätigte Branch-ID, das vorhandene EFRA-Schema und leere Testtabellen werden vor DDL geprüft. Ein erneuter Migrationslauf benötigt eine frische Testumgebung. Verbindungsdaten gehören in einen Secret Store oder in die Laufzeitumgebung.
- **Noch vorbereitet.** Anwendungseigene Service-Logins mit restriktiven Mitgliedschaften, ein dauerhaftes Migrationsjournal, API-Autorisierung für Reviewer und eine kontrollierte Projektion in **efra.stat_observations** stehen aus. Die Rollen-Pools im Test dienen ausschließlich der Berechtigungsprüfung. Der Testbranch kann für Review und Diagnose verwendet werden.
- **Weiter gesperrt.** Der Betrieb auf dem Produktionsbranch, reale Datenimporte und offizielle Bewertungen erfordern getrennte Freigaben. Nutzungsrechte, Datenabdeckung, Alias-Pflege im Echtbetrieb und empirische Ratingvalidierung bleiben offen.
