# Phase 10: Authentifizierter Review und kanonische Datenpipeline

## Implementiert

### Anmeldung und Rollen

PostgreSQL authentifiziert jeden technischen Dienst und jede im Pilot berechtigte Person über einen eigenen Login. **efra_ingest.authenticated_principal** bindet Loginname und PostgreSQL-Rollen-OID an einen stabilen Subject-Identifier, eine Capability und den aktiven Status. Die Runtime-Rollen erhalten keinen Schreibzugriff auf diese Zuordnung. Jede Operation prüft zusätzlich die Mitgliedschaft in der passenden Gruppe. Die fünf Gruppen bleiben **NOLOGIN**. Login-Zugangsdaten werden außerhalb der Anwendung konfiguriert. Ein Pool arbeitet jeweils mit genau einem Login.

| Capability | Erlaubte Aktion |
| --- | --- |
| IMPORTER | Synthetische Alias-Auflösung, Qualitätsprüfung und Staging innerhalb des registrierten Scopes |
| REVIEWER | Staging und Quarantäne prüfen und eine abschließende Entscheidung abgeben |
| PUBLISHER | Einen Snapshot mit nachweisbar authentifizierten Reviews freigeben |
| PROJECTOR | Einen freigegebenen Snapshot über eine fest versionierte Projektion übernehmen |
| READER | Freigegebene Snapshots und Projektionsbelege lesen |

**PostgresSecurePipeline.review** akzeptiert Staging-ID, Entscheidung und Begründung. Die Datenbank setzt Subject, tatsächlichen Login und Zeitpunkt anhand von **session_user**. Die vorherige direkte Schreibberechtigung der Reviewer wurde entzogen. Ein Replay durch denselben Login mit derselben Entscheidung und Begründung ist idempotent. Eine andere Person kann eine vorhandene Entscheidung weder übernehmen noch ändern. Entzug der Capability oder Deaktivierung des Principals sperren nachfolgende Aufrufe. Ein neu angelegter Login mit wiederverwendetem Rollennamen braucht wegen der Rollen-OID eine neue Zuordnung.

Die Freigabe protokolliert Publisher-Subject und tatsächlichen Login. Der Cutoff darf nicht in der Zukunft liegen. Jeder Datensatz benötigt einen bestätigten Review bis zum Cutoff. Security-Definer-Funktionen verwenden einen festen Suchpfad und explizite Ausführungsrechte. Der Datenbankeigentümer und die Vergabe von Login-Rechten bleiben Teil der vertrauenswürdigen Betriebsgrenze. [PostgreSQL-Sitzungsidentität](https://www.postgresql.org/docs/18/functions-info.html), [PostgreSQL-Funktionsrechte](https://www.postgresql.org/docs/18/sql-createfunction.html)

### Kanonische Projektion

**efra-qb-passing-v1** übernimmt die fünf verifizierten Passing-Core-Felder eines tatsächlich gespielten QB-Einsatzes. Dabei werden kanonische Spiel-, Spieler-, Team- und Saison-UUID, Einsatznachweis, Quellenrevision und Feldsemantik erneut geprüft. Explizite Null bleibt als Null erhalten. Fehlende Felder, ungeklärte UUIDs und für diesen Pfad nicht unterstützte Positionen oder Einsatztypen sperren die gesamte Projektion. Die übrigen Felder und Positionen bleiben in freigegebenen Datensnapshots verfügbar. Weitere Projektionen benötigen eigene Mapping-Versionen und Tests.

Eine Übernahme schreibt Batch, Beobachtungen und Projektionsbeleg gemeinsam. Überlappende Snapshots mit derselben Revision verweisen auf dieselben Beobachtungs-UUIDs. Geänderte Daten benötigen eine neue Revision mit einem bereits projizierten Vorgänger. **supersedes_id** verknüpft jede Korrektur mit ihrem Vorgänger. Mehrere Nachfolger für denselben Vorgänger, unmanaged Beobachtungen und konkurrierende Quellen desselben kanonischen Schlüssels werden abgewiesen. Verwaltete Beobachtungen können nur über eine neue Revision fortgeschrieben werden. Für den Pilot serialisieren ein Advisory Lock und ein Schreib-Lock auf der kanonischen Tabelle konkurrierende Projektionen und Legacy-Schreibvorgänge. Die Eignung dieser Sperrgranularität für größere Datenmengen bleibt zu messen.

**ratingReplayReference** verbindet Snapshot-ID und Cutoff mit Schema- und Projektionsversion, kanonischen Beobachtungs-UUIDs, einem SHA-256 des eingefrorenen Snapshots sowie dem exakten Engine-Commit und Konfigurationshash. Für einen späteren Replay muss dieselbe Konfiguration aus einem unveränderlichen Artefakt aufgelöst werden. Dieser Schritt erzeugt ausschließlich eine Simulationsreferenz mit **rankingEligible: false**.

### Migrationsjournal

**applyIngestTestMigrations** akzeptiert nur ein geprüftes isoliertes Testziel. Das private, append-only Journal speichert Versionsnummer, Dateiname, SHA-256, Zeitpunkt und ausführenden Login. Unter einem transaktionsgebundenen Lock werden die bereits installierten Einträge gegen die unveränderte Präfixfolge geprüft. Eine geänderte, fehlende, unbekannte oder falsch sortierte Version sperrt den Lauf. DDL und Journaleinträge committen gemeinsam. Ein existierendes Staging-Schema ohne Journal wird nicht automatisch übernommen. SQL-Dateien verwenden LF, damit ihre Bytes zwischen Windows und CI stabil bleiben.

## Testbericht

| Prüfung | Abdeckung |
| --- | --- |
| Migrationen | Geänderte und fehlende Version, gleichzeitige Replays, absichtlich fehlgeschlagene Folgemigration, Rollback und unveränderliches Journal |
| Autorisierung und Identität | Tatsächliche getrennte PostgreSQL-Logins, deaktivierter Importer, vorgetäuschte Reviewer-ID, unerlaubte Rollenwechsel und gegenseitig gesperrte Aktionen |
| Datenfreigabe | Ungeprüfter Snapshot wird abgewiesen, authentifizierter Review und Publisher-Freigabe, Projektion durch getrennten Login |
| Korrektur und Reproduzierbarkeit | Parallele Projektion und überlappende Snapshots, Vorgängerlinks, unveränderte Replay-Referenz der ursprünglichen Version |
| Fehlerbehandlung | Gefälschte Team-UUID, verweigerte direkte Änderung oder Dublette und atomarer Rollback bei einer späteren nicht unterstützten Zeile |

**Lokal:** Die vier Phase-10-Integrationstests laufen mit **npm run test:secure-pipeline** auf frischem PostgreSQL 18. Die CI verwendet einen eigenen Service für diese Suite. Die vorhandenen Unit-, PostgreSQL- und Neon-Kompatibilitätssuiten behalten ihre separaten Testumgebungen. Alle Fixtures tragen den Simulationskontext.

**Neon:** Dieselben vier Tests bestanden am 8. November 2026 auf **efra-test-secure-canonical-20261108** mit PostgreSQL 18.6. Der Testbranch enthielt fünf Journaleinträge, vier authentifizierte Reviews, drei Projektionsbelege und zehn synthetische kanonische Beobachtungen, davon fünf mit Vorgänger. Es gab keine Ratingzeilen. Die Produktions-Nachkontrolle zeigte weder Staging-Schema, Journal noch neue Rollen. Kanonische Beobachtungen und Ratings auf dem Produktionsbranch blieben leer.

## Vorbereitet und weiterhin offen

- Anwendungsspezifische Anmeldung von Reviewern, Provisionierung und Rotation produktiver Zugangsdaten, eine organisatorische Bindung des Subject-Identifiers an eine Person und die Aufbewahrung der Auditprotokolle sind getrennte Betriebsaufgaben. Ein gemeinsamer Login für menschliche Reviewer würde die vorgesehene Zuordnung aufheben.
- Der Projektionspfad ist synthetisch und auf QB Passing begrenzt. Zusätzliche Mappings, die fachliche Zuordnung konkurrierender Quellen, zulässige Aufbewahrung und Rechte für echte Quellen erfordern eine separate Freigabe.
- Ein produktiver Migrationsrollout, die Übernahme eines älteren unjournalisierten Installationsstands und die Validierung von Ratings bleiben gesperrt. Die Testläufe greifen auf den produktiven Neon-Branch ausschließlich lesend zur Abgrenzungsprüfung zu.
