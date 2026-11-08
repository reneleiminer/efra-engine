# Phase 14 · Sicherheitsgrundlage für den synthetischen Pilotbetrieb

## Architektur und Vertrauensgrenzen

```text
Synthetische Quelle → kanonischer Import → Review, Projektion und Release
                                              ↓
                              Custodian mit getrennten DB-Identitäten
                                              ↓
                           isolierter Vault mit versiegelter Studie
                                              ↓
                  unabhängige Freigabe → gebundener Pilotlauf → Worker
                                              ↓
                           signierter, privat geprüfter Bericht
```

- **Engine** läuft als reines Rechenmodul. Das Pilot-Bundle hat keine Datenbanktreiber, Netzwerkclients oder Dateizugriffe. Der Worker hält die Vault-Verbindung und die Laufsteuerung getrennt vom Build-Modul.
- **Kanonischer Import und Validierungs-Vault** haben getrennte Endpunkte und Datenbankkonten. `PostgresValidationCustodian` kann auf dem kanonischen Endpunkt lesen und mit einem eigenen Pool am Vault versiegeln. Am Vault werden weder kanonische Beobachtungen importiert noch ein kanonischer Leselogin benötigt. Der Worker kann ausschließlich das vorab freigegebene Holdout über die geschützten Funktionen einlösen. Der End-to-End-Test verwendet zwei getrennte PostgreSQL-18-Instanzen, wenn der isolierte Vault-Endpunkt gesetzt ist. CI setzt ihn in der Sicherheitssuite.
- **Späterer Web-Admin** erhält einen serverseitigen Session- und Aktionsbroker. Browser, Web-Frontend und Engine bekommen keine Vault-Zugangsdaten. Der Transport, der Identitätsanbieter und die Installation der Netzwerkregeln bleiben vor dem Pilotbetrieb zu provisionieren.
- **Zugangsdaten** kommen vom vertrauenswürdigen Secret-Broker über Workload-Identität. `validatePilotIsolation` verlangt getrennte Endpunkte, Konten und Secret-Referenzen. `withPilotConnection` verwendet pro Operation einen frischen, umgebungs- und rollenbezogenen Lease mit verifiziertem TLS, prüft die Restlaufzeit und schließt die Verbindung auch bei Fehlern. Die Anwendung darf das Passwort ausschließlich an den Datenbanktreiber geben. Kein produktives Secret wird im Repository verwaltet.

Für die Installation müssen Endpunkte, Datenbankzuordnung, Zertifikatskette, minimale Grants und Egress-Regeln unabhängig geprüft werden. Namensprüfungen im Repository ersetzen diese Prüfung nicht. Bei Rotation zuerst den neuen Broker-Lease und einen TLS-Verbindungsaufbau prüfen, dann neue Verbindungen umstellen, alte Verbindungen auslaufen lassen und das alte Secret widerrufen. Der Betreiber muss serverseitige Limits für bestehende Sessions setzen und bei Sicherheitsentzug aktive Sessions beenden. Ein abgelaufener Lease beendet bestehende PostgreSQL-Verbindungen allein nicht. Historische öffentliche Schlüssel bleiben nur für erlaubte Verifikation verfügbar. Kompromittierte Schlüssel werden gesperrt. Eine Rotation mitten in einem Lauf darf dessen Report-Key-ID nicht verändern.

## Individuelle Anwendungssitzung und Aktion

Der spätere Server erstellt nach überprüftem OIDC-Login eine opaque Sitzung mit mindestens 256 Bit Zufall. Der Browser erhält den Handle in einem sicheren HttpOnly-Cookie. Der Server speichert den Hash und ordnet das verifizierte Paar aus Issuer und Subject einer internen Person zu. Für einen konkreten IdP sind Issuer, Audience, Signatur, Ablauf, Authorization Code Flow mit PKCE, State, Nonce, CSRF-Schutz, Sitzungsrotation und Abmeldung als Abnahmekriterien vorgesehen. [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)

Die Schnittstelle `PilotSessionDirectory` liefert ausschließlich serverseitig erstellte Sessions und aktuelle, ressourcenbezogene Grants. `authorizePilotAction` prüft Session, Berechtigung und frische starke Authentifizierung. Die Ed25519-Attestierung bindet Person, Sitzungshash, Aktion, Ressource, Payload-Digest, Audience, Pilotumgebung, Ablaufzeit und Nonce. Sie ist höchstens 60 Sekunden gültig. Die letzte starke Authentifizierung darf für diese Pilotaktionen höchstens fünf Minuten zurückliegen. Die Zeitgrenzen sind Sicherheitskonfiguration und keine Aussagen über Ratingqualität. Die Ausführung prüft Signatur, Inhalt, Empfänger, aktuellen Grant und aktuelle Session erneut. Unbekannte Payload-Felder wie eine übermittelte Reviewer-ID werden verworfen.

`AtomicPilotActionSink` ist der Integrationsvertrag für einen späteren Backend-Adapter. Er muss aktuellen Grant, eindeutige Nonce, Zustandsänderung und personenbezogenes Audit atomar behandeln. Das Audit bindet menschliches Subjekt und technische Service-Identität getrennt. Der Testadapter demonstriert Replay-Schutz und parallele Einlösung. Ein produktiver Session- und Aktionsspeicher, ein Web-Endpunkt und die Weiterleitung der persönlichen Identität in die DB-Freigabe sind noch zu implementieren. Der SQL-Approver im Pilotpfad bleibt ein personengebundener DB-Login.

## Build, Autorisierung und Bericht

1. `npm ci`, `npm run build` und `npm run build:pilot-engine` erzeugen die Bibliothek und das eigenständige `dist/pilot-engine.mjs`. Der Build prüft, dass das Bundle ausschließlich das erlaubte Node-Krypto-Builtin importiert. Die CI baut das Bundle. Ein unabhängiger Build-Verantwortlicher signiert den Digest der erzeugten Bytes, Quellcommit und Protokollversion mit dem Build-Schlüssel.
2. `createVerifiedPilotWorker` prüft die Ed25519-Signatur aus einer umgebungs- und zweckgebundenen Vertrauensliste. Er lädt genau die geprüften Bytes aus dem Speicher. Es gibt keinen zweiten Dateizugriff zum Laden. Die Bereitschaft meldet, ob Build- und Reportschlüssel weiterhin vertrauenswürdig sind. Der Betreiber muss zusätzlich das Startprogramm, die Node-Laufzeit und das Container-Image prüfen und unveränderlich bereitstellen. Das Verfahren attestiert keinen kompromittierten Host und beansprucht keine SLSA-Einstufung. [SLSA, Verifying artifacts](https://slsa.dev/spec/v1.2/verifying-artifacts) · [Node.js, Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)
3. `serializePilotStudyArtifacts` erzeugt die kanonischen Bytes der Modellparameter und der effektiven Studienkonfiguration. Die versiegelte Studie bindet ihren Inhalt, ihr Rezept und die ursprünglichen Evidenzreferenzen. Eine getrennte Run-Signatur autorisiert für höchstens 24 Stunden genau Datensatz-ID und -Digest, Run-ID, gemessenen Build, Modell, Konfiguration und Report-Key-ID. Die DB-Approver-Schnittstelle registriert diese Bindung nach der unabhängigen Holdout-Freigabe. Migration 010 sperrt für einen registrierten Pilotdatensatz den bisherigen unsignierten Claim-Pfad. Sie erzwingt die registrierte Run-ID und Digests vor dem Holdout-Claim.
4. Der Worker prüft Run-Signatur und Artefakte vor dem Datenzugriff und gleicht nach dem Lesen die effektiven Modell- und Konfigurationsbytes aus der versiegelten Studie ab. Schlüsselvertrauen und Ablauf werden nochmals vor dem Schreiben geprüft. Die Reportsignatur bindet den gesamten privaten Bericht an das Laufmanifest. Der verifizierende Lesepfad prüft Signatur, Run, Datensatz und die internen Berichtsdigests. PostgreSQL erzwingt die Envelope-Struktur und unveränderliche Speicherung. Ed25519 wird an der Anwendungsschnittstelle verifiziert. Wer privilegierte Worker- oder DB-Schreibzugänge kompromittiert, kann weiterhin Verfügbarkeit beeinträchtigen. Ein formal gültiger, gefälschter Bericht wird im verifizierten Leser abgewiesen. Pilotberichte dürfen ausschließlich über diesen Leser freigegeben werden.
5. Modellartefakte im Pilot sind serialisierte Modellparameter. Externe, bereits berechnete Features und Zielbelege bleiben durch Phase 13 und den versiegelten Datensatz gebunden. Ihr unabhängiger inhaltlicher Nachweis und eine Laufzeit für externe Modelle bleiben offen.

## Synthetischer Betriebsablauf

1. Isolierte kanonische Testinstanz und Vault bereitstellen. Das vorhandene Schema auf Testinstanzen laden, Migrationen über das Integritätsjournal anwenden und unterschiedliche Logins und TLS prüfen.
2. Nur synthetische Quellen und Identitäten zulassen. Import planen, Abweichungen quarantänisieren, zulässige Zeilen prüfen und attestieren, Release projizieren und erste Sichtbarkeit protokollieren.
3. Studienrezept mit unabhängigen Zielbelegen, zeitlichen Partitionen, Modellartefakt-Digest und gemessenem Engine-Digest versiegeln. Der Approver kontrolliert das Protokoll ohne Testzeilen und bestätigt den Digest.
4. Signiertes Run-Manifest mit freigegebenem Report-Key registrieren. Der Worker bezieht einen Lease, startet den exakt gebundenen Lauf und gibt eine Simulationsquittung zurück. Den privaten Bericht über das Approver-Ticket und den verifizierten Lesepfad prüfen.
5. Bericht, Lauf- und Build-Digests sowie Daten- und Modellversionen im privaten Freigabejournal referenzieren. Die empirischen und offiziellen Freigabefelder bleiben false.

## Monitoring, Störungen und Wiederherstellung

- `PilotMonitor` liefert strukturierte, versionsmarkierte Ereignisse mit Operation, Status, Dauer, validierter Run-ID und klassifiziertem Fehler. Der Logpfad enthält keine Rohdaten, Tokens, Passwörter, SQL-Fehlermeldungen oder Berichtsinhalte. Das Datenbankjournal bleibt die verpflichtende Quelle für autorisierte Zugriffe und Änderungen. Der Betriebsadapter muss Ereignisse zentral sammeln und Journalexporte getrennt und unveränderlich speichern. Die Installation braucht Alarme auf ausfallende Bereitschaft, Fehlerraten, Integritätsfehler, wiederholte Sperren, Rotation und fehlende Audit-Exporte.
- Bei Integritäts- oder Rechtefehlern Lauf sperren und private Audit-Daten durch Berechtigte prüfen. Bei einem transienten Fehler den registrierten Lauf und den gespeicherten Bericht prüfen. Der Test simuliert einen Verbindungsabbruch nach erfolgreichem Commit. Eine Wiederholung mit derselben signierten Run-ID, demselben Worker und Schlüssel gibt denselben unveränderlichen Bericht zurück. Eine andere Run-ID erhält keinen Zugriff. Operationslogs sind best effort und lösen keine erneute Mutation aus.
- Kanonische Daten und Vault separat verschlüsselt sichern und Restore-Zugang vom Worker und Researcher trennen. Zu sichern sind Schemaversionen, versiegelte Datensätze, Belegreferenzen, Zuordnungs- und Verbrauchsjournal, unabhängige Freigaben, registrierte Runs, Berichte, Protokollexporte sowie die öffentlichen Schlüssel und Release-Manifeste. Private Schlüssel verbleiben in der jeweiligen Secret- oder KMS-Verwaltung. Wiederherstellungsdauer und tolerierbaren Datenverlust vor dem Pilotbetrieb verbindlich festlegen.
- Wiederherstellung zuerst in einer neuen isolierten Instanz testen. Migrationsdigests und Berichte gegen die extern aufbewahrten Manifest- und Audit-Checkpoints prüfen. Testverbrauch, bereits registrierte Runs und Review-Status gegen das externe Journal abgleichen. Ein Backup-Stand ohne den nachweislich letzten Testverbrauch darf keine neue Freigabe ermöglichen. Erst nach Reconciliation, frischen Credentials, erfolgreichem Rollentest und unabhängiger Freigabe wieder öffnen. Dieses Runbook enthält die Prüfschritte. Ein produktiver Backup- und Restore-Drill steht aus.

## Abnahme und Testbericht

- [x] Typprüfung, eigenständiger Build und synthetische Tests für Signatur, Identitätsfälschung, Payload-Bindung, Rollenentzug, Replay, Rotation und Protokollierung.
- [x] Synthetischer Ende-zu-Ende-Pfad mit zwei isolierten PostgreSQL-Instanzen, echten Rollen, unveränderlichem registriertem Lauf, verifizierten Build-Bytes, Ablehnung unsignierter Berichte und Wiederholung nach Verbindungsverlust.
- [ ] Pilotinstallation mit separat geprüften Netzwerkregeln, Container- und Workload-Identität, Secret-Broker und signierenden Diensten. Überwachungs- und Restore-Drill mit dokumentiertem Ergebnis.
- [ ] Individuelle Admin-Sessions, atomarer Aktionsspeicher und personenbezogenes Audit in der späteren Anwendung.
- [ ] Nutzungsrechte, Quelle- und Feldsemantik, unabhängige Referenzziele, repräsentative reale Stichproben und geschützte reale Holdouts. Offizielle Ratings benötigen eine separate empirische und fachliche Freigabe für jede Position und jeden Modellpfad. Gewichtungen, Confidence-Intervalle und Freigabeschwellen bleiben unvalidiert.

Die neue Migration ist ausschließlich für isolierte Tests ausgeführt. Die vorhandenen Import-, Positions- und Validierungssperren bleiben aktiv.
