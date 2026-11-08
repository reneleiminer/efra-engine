export const sourceCatalogueVersion = "efra-source-audit-2026-11-08-v1";

export type EvidenceChannel = "PUBLIC_UI" | "PUBLIC_DOCUMENT" | "API_DOCUMENTATION" | "API_RESPONSE" | "PROPOSED";
export type EvidenceBasis = "PRIMARY_PAGE" | "PRIOR_RENDERED_AUDIT" | "PRIMARY_SAMPLE" | "DESIGN_ONLY";
export type EvidenceRelation = "LABEL_MATCH" | "DERIVATION_CANDIDATE" | "RELATED_NOT_EQUIVALENT";

export const evidenceDocuments = {
  epfrPlayers: { channel: "PUBLIC_UI", basis: "PRIOR_RENDERED_AUDIT", url: "https://epfr.eu/stats/",
    scope: "EFA 2026, Leaderboards und Profilansichten. Diese Web-Sichtung zeigt die JavaScript-Hülle, die Feldsichtung stammt aus docs/source-audit-2026.md." },
  epfrProfile: { channel: "PUBLIC_UI", basis: "PRIMARY_PAGE", url: "https://epfr.eu/team?team=MUC",
    scope: "Ein Franchiseprofil zeigt individuelle Passing-Spalten und Saisonfilter. All-Time-Ansicht umfasst auch ELF." },
  epfrDefense: { channel: "PUBLIC_UI", basis: "PRIOR_RENDERED_AUDIT", url: "https://epfr.eu/stats/defense.php",
    scope: "EFA 2026. Sichtbare defensive Summen gemäß früherer Browser-Sichtung." },
  epfrTeam: { channel: "PUBLIC_UI", basis: "PRIMARY_PAGE", url: "https://epfr.eu/adv_analytics/",
    scope: "EFA, Teamaggregate und situative Erfolgsraten. Team-Passing ist netto nach Sackverlust." },
  epfrRights: { channel: "PUBLIC_DOCUMENT", basis: "PRIMARY_PAGE", url: "https://epfr.eu/assets/legal/tos",
    scope: "Öffentliche Nutzungsbedingungen geprüft. Eigenständige EFRA-Nutzung und Weitergabe nicht belegt." },
  efaStats: { channel: "PUBLIC_UI", basis: "PRIMARY_PAGE", url: "https://efafootball.com/statistics/",
    scope: "EFA Regular Season, sichtbare Passing-Spalten, weitere Kategorien und Teamverweise. Keine Aussage zur Vollständigkeit." },
  efaReceiving: { channel: "PUBLIC_UI", basis: "PRIMARY_PAGE", url: "https://efafootball.com/efa-receiving-stats/",
    scope: "EFA Regular Season, Spalten für Receptions, Targets und Receiving-Yards." },
  efaKicking: { channel: "PUBLIC_UI", basis: "PRIMARY_PAGE", url: "https://efafootball.com/statistics-kicker/",
    scope: "EFA Regular Season, Field Goals, Extra Points und Distanzbänder. Keine Versuchsdistanzen je Spielzug." },
  efaPunting: { channel: "PUBLIC_UI", basis: "PRIMARY_PAGE", url: "https://efafootball.com/statistics-punter/",
    scope: "EFA Regular Season, Puntanzahl, Yards, Touchbacks und Fair Catches. Kein vollständiger individueller Return-Split." },
  efaReports: { channel: "PUBLIC_DOCUMENT", basis: "PRIMARY_PAGE", url: "https://efafootball.com/game-reports/",
    scope: "Spielberichte und Rückblicke in Textform. Ein durchgehender Play-by-Play-Export wurde nicht bestätigt." },
  efaVideo: { channel: "PUBLIC_DOCUMENT", basis: "PRIMARY_PAGE", url: "https://efafootball.com/watch-live-2/",
    scope: "Angekündigte EFA-Übertragungen 2026. Keine Prüfung von Filmwinkeln, Bildqualität oder Charting-Rechten." },
  gflPlayers: { channel: "PUBLIC_UI", basis: "PRIOR_RENDERED_AUDIT",
    url: "https://statsnscore.online/stats/v2/player?gametype=Regular&league=GFL&leagueGame=league&season=2026",
    scope: "GFL 2026 Regular Season, frühere gerenderte Feldsichtung in docs/source-audit-2026.md." },
  gfl2Players: { channel: "PUBLIC_UI", basis: "PRIOR_RENDERED_AUDIT",
    url: "https://statsnscore.online/stats/v2/player?gametype=Regular&league=GFL2&leagueGame=league&season=2026",
    scope: "GFL2 2026 Regular Season, separat gerenderte Feldsichtung in docs/source-audit-2026.md." },
  gflFacts: { channel: "PUBLIC_UI", basis: "PRIMARY_PAGE",
    url: "https://statsnscore.online/stats/v2/facts-player?gametype=Regular&league=GFL&season=2026",
    scope: "Spielbezüge in der Highs/Lows-Ansicht. Keine vollständigen Spieler-Spiel-Zeilen." },
  gfl2Facts: { channel: "PUBLIC_UI", basis: "PRIMARY_PAGE",
    url: "https://statsnscore.online/stats/v2/facts-player?gametype=Regular&league=GFL2&season=2026",
    scope: "Separat geprüfte GFL2-Extremwertansicht mit Spielbezug. Kein vollständiger Spiel-Export." },
  statsApi: { channel: "API_DOCUMENTATION", basis: "PRIMARY_PAGE", url: "https://statsnscore.online/documentation/details",
    scope: "Dokumentierte Stats-Operationen und Parameter. Anbieter beschreibt tokengebundenen Zugriff; keine Antwort getestet." },
  statsGameApi: { channel: "API_DOCUMENTATION", basis: "PRIMARY_PAGE", url: "https://statsnscore.online/documentation/details",
    scope: "Getrennte Game-Stats-API. Dokumentiert sind stats, Heim-/Gastteam, Teamquartale, Spielernummern und Spiel-/Quartierstatistik. Kein EFRA-Feldwörterbuch geprüft." },
  gflArchive: { channel: "PUBLIC_DOCUMENT", basis: "PRIOR_RENDERED_AUDIT", url: "https://stats.gfl.info/gfl/2021/blbr.htm",
    scope: "Ein historisches GFL-Spiel von 2021. Frühere Sichtung belegt individuellen Box Score und einen Field-Goal-Distanznachweis." },
  gfl2Gamebook: { channel: "PUBLIC_DOCUMENT", basis: "PRIMARY_SAMPLE", url: "https://stats.gfl.info/gfl2/2022/IDWP.PDF",
    scope: "Ein GFL2-Gamebook vom 28.05.2022, individuelle Statistiken, Teilnahme, Downs/Distanz, Feldposition, Kickdistanz und NO PLAY." },
  gflArchiveIndex: { channel: "PUBLIC_DOCUMENT", basis: "PRIMARY_PAGE", url: "https://stats.gfl.info/",
    scope: "Historisches Archiv beider Ligen. Index verweist ab 2023 auf Stats’n’Score." },
  filmLab: { channel: "PROPOSED", basis: "DESIGN_ONLY", url: null,
    scope: "Künftiges manuelles EFRA-Film-Lab oder belegtes Team-Charting. Keine geprüfte Lieferung." },
  modelReference: { channel: "PROPOSED", basis: "DESIGN_ONLY", url: null,
    scope: "Künftige intern versionierte Erwartungswerte aus unabhängig geprüften Daten. Keine empirische Referenz freigegeben." },
} as const satisfies Readonly<Record<string, { channel: EvidenceChannel; basis: EvidenceBasis; url: string | null; scope: string }>>;

export type EvidenceDocumentId = keyof typeof evidenceDocuments;
export type ObservedGranularity = "PLAYER_SEASON" | "TEAM_SEASON" | "PLAYER_GAME_SAMPLE" | "PLAYER_GAME_EXTREMA" | "PLAY_SAMPLE" | "NARRATIVE";
export type RightsStatus = "NO_EFRA_GRANT_VERIFIED" | "NOT_CLEARED_WITH_RIGHTSHOLDER" | "DEPENDENT_ON_LICENSED_TRAINING_DATA";
const rights = "NO_EFRA_GRANT_VERIFIED" as const;
const noTest = "NOT_TESTED" as const;

export const sourceProfiles = {
  EPFR_EFA_PLAYER: { competition: "EFA", scope: "2026, öffentlich", rights, api: "NO_PUBLIC_CONTRACT_VERIFIED",
    apiResponse: noTest, documents: ["epfrPlayers", "epfrProfile", "epfrDefense", "epfrRights"] },
  EPFR_EFA_TEAM: { competition: "EFA", scope: "2026, Teamkontext", rights, api: "NO_PUBLIC_CONTRACT_VERIFIED",
    apiResponse: noTest, documents: ["epfrTeam", "epfrRights"] },
  EFA_OFFICIAL_STATS: { competition: "EFA", scope: "2026 Regular Season, Spalten und Navigation", rights, api: "NO_PUBLIC_CONTRACT_VERIFIED",
    apiResponse: noTest, documents: ["efaStats", "efaReceiving", "efaKicking", "efaPunting"] },
  EFA_GAME_REPORTS: { competition: "EFA", scope: "2026, ausgewählte Spielberichte", rights, api: "NO_PUBLIC_CONTRACT_VERIFIED",
    apiResponse: noTest, documents: ["efaReports"] },
  GFL_STATS_N_SCORE: { competition: "GFL", scope: "2026 Regular Season", rights, api: "DOCUMENTED_OPERATIONS_NOT_FIELD_CONTRACT",
    apiResponse: noTest, documents: ["gflPlayers", "gflFacts", "statsApi", "statsGameApi"] },
  GFL2_STATS_N_SCORE: { competition: "GFL2", scope: "2026 Regular Season", rights, api: "DOCUMENTED_OPERATIONS_NOT_FIELD_CONTRACT",
    apiResponse: noTest, documents: ["gfl2Players", "gfl2Facts", "statsApi", "statsGameApi"] },
  GFL_ARCHIVE_GAMEBOOK: { competition: "GFL", scope: "ein Spiel 2021", rights, api: "NO_PUBLIC_CONTRACT_VERIFIED",
    apiResponse: noTest, documents: ["gflArchive", "gflArchiveIndex"] },
  GFL2_ARCHIVE_GAMEBOOK: { competition: "GFL2", scope: "ein Spiel 2022", rights, api: "NO_PUBLIC_CONTRACT_VERIFIED",
    apiResponse: noTest, documents: ["gfl2Gamebook", "gflArchiveIndex"] },
  FILM_LAB_OR_TEAM_CHARTING: { competition: null, scope: "Vorschlag je freigegebenem Spiel/Angle",
    rights: "NOT_CLEARED_WITH_RIGHTSHOLDER", api: "NOT_APPLICABLE", apiResponse: noTest, documents: ["filmLab", "efaVideo"] },
  EFRA_MODEL_REFERENCE: { competition: null, scope: "Vorschlag je Modell- und Datenversion",
    rights: "DEPENDENT_ON_LICENSED_TRAINING_DATA", api: "NOT_APPLICABLE", apiResponse: noTest, documents: ["modelReference"] },
} as const satisfies Readonly<Record<string, { competition: string | null; scope: string; rights: RightsStatus; api: string;
  apiResponse: typeof noTest; documents: readonly EvidenceDocumentId[] }>>;

export type AuditedSourceId = keyof typeof sourceProfiles;

interface FieldLead {
  readonly document: EvidenceDocumentId;
  readonly granularity: ObservedGranularity;
  readonly relation: EvidenceRelation;
  readonly fields: readonly string[];
}

const passing = ["passing.attempts", "passing.completions", "passing.yards", "passing.touchdowns", "passing.interceptions"];
const kicking = ["fieldGoalAttempts", "fieldGoalsMade", "extraPointAttempts", "extraPointsMade"];
const box = ["carries", "receivingYards", "receptions", "interceptions", "kickReturns", "puntReturns", ...kicking];
const qbRushing = ["rushing.attempts", "rushing.yards", "rushing.touchdowns"];
const coveredByBoxScore = [...passing, ...box];
const archiveBoxScore = [...passing, ...kicking, "carries", "receptions", "receivingYards", "kickReturns", "puntReturns", "interceptions"];
const snsLeads = (document: EvidenceDocumentId, facts: EvidenceDocumentId): readonly FieldLead[] => [
  { document, granularity: "PLAYER_SEASON", relation: "LABEL_MATCH", fields: coveredByBoxScore },
  { document, granularity: "PLAYER_SEASON", relation: "RELATED_NOT_EQUIVALENT", fields: [...qbRushing, "drops", "rushingFumbles"] },
  { document: facts, granularity: "PLAYER_GAME_EXTREMA", relation: "LABEL_MATCH",
    fields: [...coveredByBoxScore.filter((f) => f !== "passing.completions")] },
  { document: facts, granularity: "PLAYER_GAME_EXTREMA", relation: "RELATED_NOT_EQUIVALENT",
    fields: ["returnedPunts", "unreturnedPunts"] },
];
export const fieldLeads: Readonly<Record<AuditedSourceId, readonly FieldLead[]>> = {
  EPFR_EFA_PLAYER: [
    { document: "epfrPlayers", granularity: "PLAYER_SEASON", relation: "LABEL_MATCH", fields: [...passing, ...box.filter((f) => f !== "interceptions"), "targets"] },
    { document: "epfrProfile", granularity: "PLAYER_SEASON", relation: "LABEL_MATCH", fields: passing },
    { document: "epfrPlayers", granularity: "PLAYER_SEASON", relation: "RELATED_NOT_EQUIVALENT", fields: [...qbRushing, "situation.opportunities"] },
    { document: "epfrDefense", granularity: "PLAYER_SEASON", relation: "LABEL_MATCH", fields: ["interceptions"] },
    { document: "epfrDefense", granularity: "PLAYER_SEASON", relation: "RELATED_NOT_EQUIVALENT",
      fields: ["interiorPressures", "edgePressures", "nosePressures", "coverageTargets"] },
  ],
  EPFR_EFA_TEAM: [
    { document: "epfrTeam", granularity: "TEAM_SEASON", relation: "RELATED_NOT_EQUIVALENT",
      fields: ["passing.yards", "passing.touchdowns", "passing.interceptions", "rushing.yards", "rushing.touchdowns",
        "advancedPassing.nonTouchdownFirstDowns", "situation.opportunities", "interiorRunStops"] },
  ],
  EFA_OFFICIAL_STATS: [
    { document: "efaStats", granularity: "PLAYER_SEASON", relation: "LABEL_MATCH", fields: passing },
    { document: "efaStats", granularity: "PLAYER_SEASON", relation: "RELATED_NOT_EQUIVALENT", fields: ["situation.opportunities"] },
    { document: "efaReceiving", granularity: "PLAYER_SEASON", relation: "LABEL_MATCH", fields: ["receptions", "targets", "receivingYards"] },
    { document: "efaKicking", granularity: "PLAYER_SEASON", relation: "LABEL_MATCH", fields: kicking },
    { document: "efaKicking", granularity: "PLAYER_SEASON", relation: "RELATED_NOT_EQUIVALENT", fields: ["expectedFieldGoalsByDistance"] },
    { document: "efaPunting", granularity: "PLAYER_SEASON", relation: "RELATED_NOT_EQUIVALENT", fields: ["returnedPunts", "unreturnedPunts"] },
  ],
  EFA_GAME_REPORTS: [{ document: "efaReports", granularity: "NARRATIVE", relation: "RELATED_NOT_EQUIVALENT",
    fields: ["passing.touchdowns", "rushing.touchdowns", "receivingYards"] }],
  GFL_STATS_N_SCORE: snsLeads("gflPlayers", "gflFacts"),
  GFL2_STATS_N_SCORE: snsLeads("gfl2Players", "gfl2Facts"),
  GFL_ARCHIVE_GAMEBOOK: [
    { document: "gflArchive", granularity: "PLAYER_GAME_SAMPLE", relation: "LABEL_MATCH", fields: passing },
    { document: "gflArchive", granularity: "PLAY_SAMPLE", relation: "RELATED_NOT_EQUIVALENT", fields: ["expectedFieldGoalsByDistance"] },
  ],
  GFL2_ARCHIVE_GAMEBOOK: [
    { document: "gfl2Gamebook", granularity: "PLAYER_GAME_SAMPLE", relation: "LABEL_MATCH", fields: archiveBoxScore },
    { document: "gfl2Gamebook", granularity: "PLAY_SAMPLE", relation: "DERIVATION_CANDIDATE",
      fields: ["advancedPassing.nonTouchdownFirstDowns", "targets", "receivingFumbles", "rushingFumbles", "returnedPunts", "unreturnedPunts"] },
    { document: "gfl2Gamebook", granularity: "PLAY_SAMPLE", relation: "RELATED_NOT_EQUIVALENT",
      fields: ["expectedFieldGoalsByDistance", "kickReturnYardsAboveExpected", "puntReturnYardsAboveExpected",
        "returnedFieldPositionAboveExpected", "unreturnedFieldPositionAboveExpected", ...qbRushing] },
  ],
  FILM_LAB_OR_TEAM_CHARTING: [],
  EFRA_MODEL_REFERENCE: [],
};
