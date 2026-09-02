export interface SourceDefinition {
  id: string;
  name: string;
  archiveUrl: string;
  kind: "brawl-blog" | "brawl-announcements" | "brawl-youtube";
  processing: "analysis" | "notification-only";
}

export const SOURCES: readonly SourceDefinition[] = [
  {
    id: "supercell-brawl-blog",
    name: "Supercell — Blog oficial do Brawl Stars",
    archiveUrl: "https://supercell.com/en/games/brawlstars/blog/page/1/",
    kind: "brawl-blog",
    processing: "analysis",
  },
  {
    id: "supercell-brawl-announcements",
    name: "Supercell — Anúncios oficiais do Brawl Stars",
    archiveUrl: "https://supercell.com/en/news/announcement/brawlstars/page/1/",
    kind: "brawl-announcements",
    processing: "analysis",
  },
  {
    id: "brawl-stars-youtube",
    name: "Brawl Stars — YouTube oficial",
    archiveUrl:
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCooVYzDxdwTtGYAkcPmOgOw",
    kind: "brawl-youtube",
    processing: "notification-only",
  },
] as const;

export const USER_AGENT =
  "radarNews/1.0 (personal public-content monitor; official Supercell sources only)";

export const CLAIM_MINUTES = 15;
export const MAX_CLAIM_ITEMS = 1;
export const DELIVERY_LEASE_MINUTES = 2;
export const MAX_PROCESSING_RETRIES = 5;
export const PROCESSING_RETRY_BACKOFF_MINUTES = [5, 15, 60, 240] as const;
export const SOURCE_FETCH_TIMEOUT_MS = 20_000;
export const MAX_SOURCE_HTML_BYTES = 1_500_000;
export const ANALYSIS_RETENTION_DAYS = 180;
