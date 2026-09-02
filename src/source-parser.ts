import type { SourceDefinition } from "./config.ts";

export interface ParsedSourceItem {
  title: string;
  url: string;
  publishedAt: string | null;
}

interface Anchor {
  attributes: string;
  href: string;
  innerHtml: string;
}

export function parseSourceArchive(
  source: SourceDefinition,
  html: string,
): ParsedSourceItem[] {
  if (source.kind === "brawl-youtube") return parseYouTubeFeed(html);
  const byUrl = new Map<string, ParsedSourceItem>();

  for (const anchor of extractAnchors(html)) {
    const url = normalizeArticleUrl(anchor.href, source);
    if (!url) continue;

    const title = extractTitle(anchor, url);
    const previous = byUrl.get(url);
    if (!previous || title.length > previous.title.length) {
      byUrl.set(url, { title, url, publishedAt: null });
    }
  }

  return [...byUrl.values()].slice(0, 20);
}

export function normalizeArticleUrl(
  rawHref: string,
  source: SourceDefinition,
): string | null {
  if (source.kind === "brawl-youtube") return null;
  let url: URL;
  try {
    url = new URL(decodeEntities(rawHref), source.archiveUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.hostname !== "supercell.com") {
    return null;
  }

  const path = url.pathname.replace(/\/{2,}/g, "/");
  const isArticle =
    source.kind === "brawl-blog"
      ? /^\/en\/games\/brawlstars\/blog\/(?!page\/)[a-z0-9-]+\/[a-z0-9-]+\/?$/i.test(
          path,
        )
      : /^\/en\/news\/(?!announcement\/?$|page\/)[a-z0-9-]+\/?$/i.test(path);

  if (!isArticle) return null;

  url.pathname = path.endsWith("/") ? path : `${path}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function parseYouTubeFeed(xml: string): ParsedSourceItem[] {
  const items: ParsedSourceItem[] = [];
  for (const entry of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry\s*>/gi)) {
    const body = entry[1] ?? "";
    const videoId = cleanText(
      body.match(/<yt:videoId\b[^>]*>([\s\S]*?)<\/yt:videoId\s*>/i)?.[1] ?? "",
    );
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    const title = cleanText(
      body.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "",
    );
    if (title.length < 2) continue;
    const rawPublished = cleanText(
      body.match(/<published\b[^>]*>([\s\S]*?)<\/published\s*>/i)?.[1] ?? "",
    );
    const publishedAt = Number.isNaN(Date.parse(rawPublished))
      ? null
      : new Date(rawPublished).toISOString();
    items.push({
      title: title.slice(0, 300),
      url: `https://www.youtube.com/watch?v=${videoId}`,
      publishedAt,
    });
    if (items.length >= 20) break;
  }
  return items;
}

function extractAnchors(html: string): Anchor[] {
  const anchors: Anchor[] = [];
  const pattern = /<a\b([^>]*?)\bhref\s*=\s*(?:(["'])(.*?)\2|([^\s"'=<>`]+))([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    anchors.push({
      attributes: `${match[1] ?? ""} ${match[5] ?? ""}`,
      href: match[3] ?? match[4] ?? "",
      innerHtml: match[6] ?? "",
    });
  }
  return anchors;
}

function extractTitle(anchor: Anchor, url: string): string {
  const headingMatches = [
    ...anchor.innerHtml.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi),
  ];
  const heading = headingMatches.at(-1)?.[1];
  if (heading) {
    const cleanHeading = cleanText(heading);
    if (cleanHeading.length >= 4) return cleanHeading.slice(0, 300);
  }

  const labelMatch = anchor.attributes.match(
    /\b(?:aria-label|title)\s*=\s*(["'])(.*?)\1/i,
  );
  const label = cleanText(labelMatch?.[2] ?? "");
  if (label.length >= 4 && !/^image\b/i.test(label)) return label.slice(0, 300);

  const visible = cleanText(anchor.innerHtml);
  if (visible.length >= 4 && !/^image\b/i.test(visible)) return visible.slice(0, 300);

  return titleFromUrl(url);
}

export function cleanText(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<(?:script|style|svg|picture)\b[^>]*>[\s\S]*?<\/(?:script|style|svg|picture)\s*>/gi, " ")
      .replace(/<img\b[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rsquo;/gi, "’")
    .replace(/&ldquo;/gi, "“")
    .replace(/&rdquo;/gi, "”")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (entity, code: string) => {
      const point = Number.parseInt(code, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    })
    .replace(/&#(\d+);/g, (entity, code: string) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : entity;
    });
}

function titleFromUrl(value: string): string {
  const slug = new URL(value).pathname.split("/").filter(Boolean).at(-1);
  if (!slug) return "Nova publicação oficial";
  return slug
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
