# Phase 11: Kanonische Positionsdaten und reproduzierbare Simulation

## Versionen und Datenweg

Die Projektion **efra-all-positions-v1** und das Registry **efra-position-metrics-v1** decken alle 24 EFRA-Positionen ab. Die TypeScript-Definition wird aus den [Positionsverträgen](positions.md) abgeleitet. Die versionierte SQL-Migration enthält deren deterministisch generierte Abbildung. Der Integrationstest vergleicht Felder und Regeln beider Darstellungen. **npm run --silent registry:sql** gibt die SQL-Fassung aus. Neue Semantik erfordert eine neue Migration und Registry-Version. Bereits journalisierte Dateien bleiben unverändert.

Jeder Registry-Eintrag bezeichnet Position, Feld, kanonischen Code, Einheit, zulässigen Zahlenbereich, Modellstufe, Rolle, erforderliche Quellenfähigkeit und Feature-Version. Ein Feld kann in mehreren Stufen verwendet werden. Das Registry trennt Messwerte, Expositionen und Referenzwerte. QB-Kontextfunktionen bleiben versionierte Modellparameter. Ein numerischer Kicker-Erwartungswert aus einer freigegebenen Referenz ist im Registry als Referenz und nicht als Treffer gekennzeichnet.

Der Weg führt über die synthetische Quellen-Allowlist, UUID-Auflösung, Qualitätsprüfung, getrennten Review und authentifizierte Snapshot-Freigabe. Für jede numerische Beobachtung muss eine freigegebene Zuordnung aus Quelle, Mapping-, Schema-, Feld-, Konventions- und Feature-Version mit exakt der Registry-Einheit vorliegen. Die Freigabe dokumentiert die vereinbarte Normalisierung eines Felds. Die tatsächliche Einheit einer Zahl kann erst durch Prüfung des Decoders und der Quelle belegt werden. Die Projektion prüft erneut Quellenrevision, individuelle Teilnahme, UUIDs, numerische Domäne und die im Registry definierten Nenner- und Summenregeln.

| Eingangsstatus | Behandlung |
| --- | --- |
| OBSERVED | Verifizierter Wert mit Quellenbeleg im Statusledger und als kanonische Beobachtung |
| VERIFIED_ZERO | Expliziter Nullwert mit belegter Herkunft und eigener kanonischer Beobachtungs-UUID |
| MISSING | Versionierter Status ohne Zahlenwert und ohne kanonische Beobachtungs-UUID |
| NOT_APPLICABLE | Expliziter Nichtanwendbarkeitsstatus ohne Zahlenwert und ohne kanonische Beobachtungs-UUID |
| CONFLICTED | Feld und konkurrierende Quellenreferenzen in der Quarantäne. Eine Aufnahme in einen Projektionsbeleg wird abgewiesen. |

Das Statusledger ist nötig, weil **efra.stat_observations.value** einen Zahlenwert verlangt und die Bestandstabelle keine vollständige EFRA-Statustaxonomie abbildet. Der Zugriff auf einen freigegebenen Stand erfolgt über den Projektionsbeleg. Eine Abfrage nach dem neuesten Zahlenwert in der Bestandstabelle würde beispielsweise einen inzwischen fehlenden Wert falsch interpretieren.

## Dubletten und Korrekturen

Der Schlüssel besteht aus Revision, Spiel, Spieler, Position und Registry-Feld. Identische Wiederholungen und überlappende Snapshots teilen dieselbe Beobachtungs-UUID. Widersprüchliche normalisierte Inhalte derselben Revision, konkurrierende Quellen und unverwaltete kanonische Werte werden zur getrennten Klärung abgewiesen. Korrekturen benötigen eine explizite Vorgängerrevision. Auch ein Wechsel von numerisch zu fehlend oder nicht anwendbar ist eine eigene Revision. Wenn ein Wert später wieder verfügbar ist, verweist seine neue Beobachtung auf den letzten numerischen Vorgänger. Der vorherige Snapshot bleibt unverändert. Die transaktionalen Locks und eindeutigen Schlüssel verhindern konkurrierende Korrekturzweige.

Der vorherige QB-Projektionspfad bleibt für bestehende Belege lesbar. Bei einem Wechsel kann die neue Projektion die exakt passenden, bereits übernommenen QB-Beobachtungen wiederverwenden. Sobald das Statusledger für einen Spiel-Spieler-Positionsschlüssel existiert, darf der alte Pfad keinen neuen Beleg für diesen Schlüssel schreiben.

## Reproduzierbarer Datenweg zur Rating Engine

Der autorisierte Lesedienst lädt den unveränderlichen freigegebenen Snapshot und seinen Projektionsbeleg. Numerische Fakten werden mit Wert und Einheit aus der kanonischen Tabelle gelesen. Der TypeScript-Adapter vergleicht sie mit dem eingefrorenen Snapshot und dem Registry. Abweichende, fehlende oder zusätzliche Fakten stoppen die Ausführung.

**simulateQb** und **simulateField** nutzen danach die bestehenden Season-Performance-Einstiege. Die Auswertung ist auf eine Spieler-UUID, Position und Wettbewerbssaison begrenzt. Der Aufrufer gibt erwartete Spiele und Team-Stints explizit vor. Ein fehlendes erwartetes Spiel führt zur bestehenden **NOT_RATED**-Entscheidung. Für diesen Datenweg entspricht die Liga dem kanonischen Wettbewerb. Das Ergebnis bindet Snapshot, Registry, Projektion, beobachtete UUIDs, Engine-Commit und Konfigurationshash an einen Hash des tatsächlichen Eingabesatzes. Die referenzierte Policy und ihre ausführbaren Kontextfunktionen müssen als unveränderliches Artefakt archiviert werden. Der Adapter erzeugt ausschließlich **SIMULATION** mit **rankingEligible: false**.

## Grenzen öffentlicher Box Scores

Keines der 24 Positionsmodelle ist im vollen Core-, Supporting- und Advanced-Umfang durch gewöhnliche Box Scores belegt. Die folgende Übersicht nennt die fehlende Evidenz je Gruppe. Die [Quellenprüfung für EPFR, GFL und GFL2](source-audit-2026.md) enthält den Vergleich pro Position.

| Betroffene Positionen | Typisch fehlende Daten |
| --- | --- |
| QB | Box Scores können die fünf Passing-Kernfelder enthalten. Vollständige QB-Rollen je Spiel, bereinigte Runs, Non-TD First Downs, situative Sacks und versionierte Referenzen brauchen weitere Evidenz. |
| RB, FB, WR, TE | Bereinigte Carries/Targets, Fumble-Zuordnung, Fangbarkeit, Lead- und Inline-Blocks sowie Protection-Assignments sind durch reine Rushing-/Receiving-Summen nicht belegt. |
| OT, OG, C | Individuelle Blocking-Assignments und Block-Güte, Pulls, Combo-Blocks und Exchanges fehlen. Mannschafts-Sacks liefern keine individuelle Zuordnung. |
| DT, NT, EDGE | Rollenbezogene Pressure-, Stop-, Contain- und Anchor-Opportunities sowie Double-Team- oder Two-Gap-Assignments fehlen. |
| ILB, MLB, OLB | Run-Fit-, Coverage- und Blitz-Assignments sowie die zugehörigen Fehlversuche und Expositionen fehlen. |
| CB, FS, SS, S | Individuelle Target-Verantwortung, Coverage-Yards, Run-Support-Fehlversuche, Alignment und Off-Target-Coverage sind durch INT, PBU und Tackles nicht belegt. |
| K, P, KR, PR | Distanz je Kick, Nettoposition über Erwartung, Return-/Fair-Catch-Kontext, Fumbles und Entscheidungsmöglichkeiten brauchen Ereignis- oder Charting-Daten. |
| LS, Gunner | Snap-Präzision und -Zeit, Release-, Tackle- und Coverage-Assignments sowie zugeordnete Fair Catches brauchen individuelles Charting. |

## Sicherheitsprüfung für einen späteren Web-Admin

Der spätere Admin benötigt eine eigene Anwendungssitzung pro Mensch. Eine geeignete Architektur ist ein serverseitiges Backend mit OIDC Authorization Code Flow, PKCE, geprüftem Issuer und Audience, validierter Signatur, Ablaufzeit, State und Nonce. Die stabile Identität ist das Paar aus **iss** und **sub**, das serverseitig einem EFRA-Subject mit explizitem Berechtigungsumfang zugeordnet wird. Sitzungen brauchen sichere HttpOnly-Cookies, Ablauf und Rotation sowie CSRF-Schutz für Schreibaktionen. Bei Review oder Freigabe prüft das Backend Capability, Ressourcen-Scope und den aktuellen Sitzungsstatus erneut. Für Freigaben sollte die Architektur eine frische Bestätigung und Funktionstrennung vorsehen. [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html), [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)

Der Datenbank-Login eines gemeinsam genutzten Backend-Pools bleibt die **Service-Identität**. Die heutige, an session_user gebundene Reviewer-Funktion ist deshalb nur für personengebundene PostgreSQL-Logins geeignet. Ein Web-Pool darf keinen menschlichen Reviewer imitieren. Ein späterer Web-Einstieg braucht eine eigene Vertrauensgrenze, die eine kurzlebige serverseitig attestierte Sitzungsidentität und Aktion verifiziert. Zu binden sind mindestens Subject, Capability, Ressourcen-Scope, Aktion, Objekt-ID, Payload-Hash, Ablaufzeit und eindeutige Request-ID. Server und Audit protokollieren menschlichen Subject-Identifier und technischen DB-Principal getrennt. Browserfelder und frei setzbare DB-Sitzungsvariablen sind keine Identitätsbelege. Zu testen sind insbesondere Replay, Cross-User-Zuordnung, Rechteentzug, Rollenvermischung und ein nicht autorisierter Objektzugriff. [PostgreSQL-Sitzungsidentität](https://www.postgresql.org/docs/18/functions-info.html)

Die Web-Anbindung ist ein Architektur- und Sicherheitsentwurf. Wahl des IdP, konkrete Sitzungsimplementierung, attestierte Übergabe und eigenständige Abnahme bleiben offen. Es wurde keine Website bereitgestellt.

## Testbericht

Die fünf neuen Integrationstests prüfen den generierten Registry-Vertrag, den echten PostgreSQL-Datenweg für alle 24 Positionen samt deterministischen Simulationswiederholungen und Spezialpfade für P, LS und Rushing-only-QB. Hinzu kommen fehlende Abdeckung, getrennte Null-/Missing-/N/A-Zustände, Wiederaufnahme eines Werts nach einer Lücke, persistierte Konfliktbelege, abgewiesene Einheiten, konkurrierende Quellen und die kontrollierte Kompatibilität mit dem vorherigen QB-Pfad.

Die vorhandenen Unit-, Staging-, Rollen- und Phase-10-Suiten bleiben erhalten. Migrationen 006 und 007 wurden auf einem frischen isolierten PostgreSQL-18-Testservice ausgeführt. Nutzungsrechte, Erfassungsqualität realer Quellen und empirische Modellvalidierung bleiben offen. Für diese Phase erfolgten keine Schreibzugriffe auf Neon.
