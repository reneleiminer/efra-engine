# Phase 15 · Lokale sichere Pilotinfrastruktur

## Ausführen

Voraussetzungen sind Node.js 24, Docker Engine oder Docker Desktop mit Linux-Containern und Docker Compose. Der erste Build lädt die im Repository festgelegten Images und npm-Abhängigkeiten. Die Datenbanken und der Worker haben während der Ausführung ausschließlich interne Netze. Das Skript akzeptiert einen lokalen Unix- oder Windows-Docker-Socket.

```sh
npm run pilot:verify -- --config-only
npm run pilot:verify
npm run pilot:verify -- --backup-dir ../efra-pilot-backup
```

`--config-only` prüft die gerenderte Compose-Konfiguration. Der vollständige Lauf verwendet einen neuen zufälligen Projektnamen, erstellt zwei leere Datenbankinstanzen, richtet temporäre TLS- und Rollen-Zugangsdaten ein, führt synthetische Abnahmetests aus und spielt Backups in zwei neue Restore-Instanzen ein. Anschließend entfernt er die zum eigenen Projekt gehörenden Container, Netze und Volumes. Ohne `--backup-dir` bleiben nur die Prüfergebnisse und Hashes im Log. Für den Export ist ein neues Verzeichnis außerhalb des Repositories erforderlich. Die Dateien gehören in einen lokalen, zugriffsgeschützten Bereich. Der optionale Export enthält synthetische private Daten und keine Rollenpasswörter.

## Laufzeitarchitektur

| Dienst | Zugriff und Aufgabe |
| --- | --- |
| Setup | Einmaliger Start ohne Netzwerk. Erzeugt lokale CA, Serverzertifikate und getrennte zufällige Datenbankpasswörter in temporären Volumes. Der CA-Schlüssel verbleibt im Setup-Prozess. |
| Canonical | Eigener PostgreSQL-Cluster im internen Importnetz. Er verarbeitet synthetische Eingaben, Quarantäne, Review, Attestierung und kanonische Projektion. |
| Vault | Eigener PostgreSQL-Cluster im separaten internen Netz. Er enthält versiegelte Validierungsdaten, Rollen, Holdout-Verbrauch, Freigaben und signierte Simulationsberichte. Die Abnahme prüft leere kanonische Beobachtungstabellen im Vault und unterschiedliche Clusterkennungen. |
| Controller | Synthetischer Abnahmeprozess mit Zugang zu beiden Netzen und getrennten Bootstrap- und Fachkonten. Er initialisiert Testfixtures und fungiert als lokal vertrauenswürdige Kontrollinstanz. Im vorgesehenen Betrieb ersetzen getrennte Import-, Custodian-, Approver- und Secret-Broker-Dienste diesen Testcontroller. |
| Worker | UID 1000, schreibgeschütztes Root-Dateisystem, keine Linux-Capabilities, `no-new-privileges`, CPU-, Speicher- und Prozessgrenzen. Er erreicht nur das Vault-Netz, prüft TLS und Vault-Identität und verwendet ausschließlich das eingeschränkte Worker-Konto. Er erhält getrennte Read-only-Mounts für Jobs, öffentliche Vertrauensschlüssel, Report-Schlüssel und kurzlebige Datenbank-Leases. Nur die Quittungen schreibt er in ein eigenes Volume. |
| Restore | Zwei frische Datenbankinstanzen ohne Netzwerk. Restore und Integritätsprüfung laufen über den lokalen Unix-Socket im Container. |

Die Images sind nach Digest fixiert. Compose veröffentlicht keine Host-Ports. Die statische Prüfung bestätigt Netze, Mounts, Benutzer und Härtung. Der Worker prüft zusätzlich beim Start, dass er den kanonischen Dienst im Importnetz nicht auflösen kann. PostgreSQL verlangt für Containerverbindungen TLS mit geprüfter lokaler CA und Servernamen. Der End-to-End-Test weist Klartextzugriff ab. Lokaler Docker-Host, Setup und Testcontroller bleiben privilegierte Vertrauensgrenzen. [Docker Compose, Netzwerke](https://docs.docker.com/reference/compose-file/networks/) · [Docker Compose, Secrets](https://docs.docker.com/compose/how-tos/use-secrets/)

## Ablauf und Kontrolle

1. Der Controller lädt synthetische Identitäten, führt den attestierten Import durch und versiegelt aus kanonischen Releases einen Validierungsdatensatz im Vault. Ein personengebundenes Testkonto prüft das Manifest und registriert den freigegebenen Lauf.
2. Der Worker bezieht die aktuelle Rolle über den lokalen `FilePilotSecretBroker`. Das Lease wird atomar ersetzt. Der Test wechselt das Vault-Passwort, weist eine neue Verbindung mit dem alten Passwort ab und führt den bereits registrierten Lauf über das neue Lease fort. Er rotiert zusätzlich den RUN-Signaturschlüssel mit neuer Schlüssel-ID und unverändertem freigegebenem Manifest. Der bereits gebundene REPORT-Schlüssel bleibt für die Wiederholung gleich.
3. Der Worker verifiziert den geladenen Engine-Build, die Run-Autorisierung und die Modell- und Konfigurationsdigests. Der private Leser prüft den signierten Simulationsbericht. Der Abnahmetest startet zwölf parallele Wiederholungen desselben Laufs und simuliert einen Verbindungsabbruch nach dem Speichern des Berichts.
4. Der Worker wiederholt ausschließlich bekannte transiente Speicher- oder Transportfehler, höchstens dreimal mit kurzem Abstand. Bereits atomar veröffentlichte Quittungen werden beim Neustart übersprungen. Der Wiederanlauftest bestätigt, dass dabei kein neuer Holdout-Zugriff protokolliert wird. Ein manipuliertes Manifest löst einen klassifizierten kritischen `PILOT_ALERT` auf stdout aus und erreicht den Holdout nicht.
5. Betriebsereignisse enthalten Status, Lauf-ID, Dauer und Fehlerklasse. Passwörter, Schlüssel, Rohdaten und private Berichte gehören weder in stdout noch in das externe Alarmsystem. Das Datenbankjournal bleibt für Zugriffe und Freigaben maßgeblich. Die lokale Alarmierung endet beim strukturierten Ereignis. Weiterleitung, Alarmempfänger, Aufbewahrung und Eskalation sind separat zu konfigurieren.

## Backup und Wiederherstellung

Nach Abschluss der Jobs werden die logisch konsistenten PostgreSQL-Archive und Rollenbeschreibungen separat erstellt. Rollenbeschreibungen schließen Passwörter aus. `pg_restore --single-transaction` spielt jedes Archiv in eine eigene leere, netzlose Instanz ein. Der Drill bindet DB-Principals an die neu vergebenen Login-OIDs und vergleicht die semantischen Prüfsummen von Migrationen, Beobachtungen, Projektionen, versiegelten Datensätzen, Partitionen, Holdout-Verbrauch, Freigaben, Berichten und Audit. Der Vault-Restore muss einen Bericht und verbrauchte Holdout-Evidenz enthalten. `verified.json` enthält bei optionalem Export die Archiv-, Rollen- und Checkpoint-Digests. [PostgreSQL 18, SQL Dump](https://www.postgresql.org/docs/18/backup-dump.html)

Ein produktionsnaher Restore benötigt zusätzlich verschlüsselte externe Ablage, unabhängige Checkpoints, festgelegte Aufbewahrung und Wiederherstellungsziele. Vor Freigabe müssen Betreiber beide Archive gegen den zuletzt extern gesicherten Audit- und Holdout-Stand abgleichen, ältere Tickets sperren, alle Zugangsdaten neu ausstellen und die Rollen erneut testen. Die beiden logischen Dumps sind im ruhenden lokalen Abnahmelauf konsistent. Für laufende externe Systeme ist ein abgestimmtes Sicherungsfenster oder eine separate Reconciliation erforderlich.

## Identitätsanbieter und externe Betriebsgrenzen

`establishPilotSession` prüft die Claims eines vom eingebundenen OIDC-Client verifizierten Tokens gegen die fest konfigurierte Issuer-, Client- und Authentifizierungsrichtlinie. Es prüft Einmal-State, Nonce, Audience und autorisierte Partei, Authentifizierungskontext und Ablauf. Die individuelle interne Person wird ausschließlich über das geprüfte Issuer/Subject-Paar ermittelt. Eine deaktivierte Zuordnung sperrt die Sitzung. Gespeichert wird nur der Hash des zufälligen Sitzungs-Handles. `PilotPersonRegistry` liest die versionierte, vom Betreiber verwaltete Rollen- und Ressourcenrichtlinie bei jeder Entscheidung erneut. Sie verlangt eindeutige Personenbindungen und trennt Review und Holdout-Freigabe. Der lokale Test prüft den Entzug einer Berechtigung bei bestehender Sitzung. [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)

Für einen echten Anbieter sind Discovery und JWKS mit vertrauenswürdigem Issuer, die Prüfung der JWS-Signatur und erlaubter Algorithmen, Authorization Code Flow mit PKCE, atomarer State-Speicher, Session- und Grant-Store, sichere Cookies, CSRF und ein authentifizierter Aktionsadapter zu provisionieren. Die Tests verwenden einen synthetischen Verifier. Kein externer Anbieter wurde konfiguriert. Der lokale File-Broker ist eine ausführbare Testimplementierung. Ein externer Secret- und Signierdienst braucht eigene Workload-Identitäten, Trust Anchors, Rotation, Widerruf und Audit. Die Test-CA und die ephemeren Schlüssel sind ausschließlich für den lokalen synthetischen Ablauf bestimmt.

## Abnahmecheckliste

- Lokaler Testbericht. Der Build und 130 synthetische TypeScript-Tests sind grün. Die Compose-Abnahme führt 13 PostgreSQL-Sicherheitstests, den separaten Neustart- und Alarmtest sowie zwei Restore-Drills aus.
- [x] Reproduzierbarer lokaler Compose-Lauf mit getrennten PostgreSQL-Clustern, internen Netzen, TLS, eingeschränktem Worker und automatisch geprüfter Konfiguration.
- [x] Synthetischer Ende-zu-Ende-Pfad vom Import über die unabhängige Holdout-Freigabe zum verifizierten Simulationsbericht.
- [x] Rotation des lokalen DB-Leases und des RUN-Schlüssels, Negativtests für Klartext, Rechteentzug, fremde Tickets und manipulierte Manifeste, strukturierte Alarmierung, Neustart und zwölf parallele Wiederholungen.
- [x] Logischer Backup- und Restore-Drill für beide Datenbanken mit Digests, wiedergebundenen Rollen und überprüftem Holdout-Journal.
- [ ] Betrieb außerhalb des lokalen synthetischen Profils mit unabhängiger Netz- und Workload-Abnahme, externem IdP, Secret-Broker, KMS, Session- und Grant-Store, Alarmweiterleitung und verschlüsselter Backup-Aufbewahrung.
- [ ] Produktiver Wiederherstellungsdrill mit genehmigten Wiederherstellungszielen sowie unabhängiger Überprüfung der Wiederverwendungssperren. Die parallele Testlast belegt die Idempotenz des synthetischen Pfads. Kapazität und Betriebsgrenzen einer externen Installation bleiben offen.
- [ ] Nutzungsrechte, geprüfte reale Datenquellen, repräsentative unabhängige Referenzdaten, getrennte reale Holdouts und empirische Validierung vor jeder offiziellen Ratingfreigabe. Alle bisherigen Freigabesperren bleiben aktiv.
