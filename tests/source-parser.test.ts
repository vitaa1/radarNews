import assert from "node:assert/strict";
import test from "node:test";
import type { SourceDefinition } from "../src/config.ts";
import { cleanText, normalizeArticleUrl, parseSourceArchive } from "../src/source-parser.ts";

const blog: SourceDefinition = {
  id: "blog",
  name: "Blog",
  archiveUrl: "https://supercell.com/en/games/brawlstars/blog/page/1/",
  kind: "brawl-blog",
  processing: "analysis",
};

const announcements: SourceDefinition = {
  id: "announcements",
  name: "Announcements",
  archiveUrl: "https://supercell.com/en/news/announcement/brawlstars/page/1/",
  kind: "brawl-announcements",
  processing: "analysis",
};

const youtube: SourceDefinition = {
  id: "youtube",
  name: "YouTube oficial",
  archiveUrl:
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCooVYzDxdwTtGYAkcPmOgOw",
  kind: "brawl-youtube",
  processing: "notification-only",
};

test("extrai artigos do blog e ignora paginação e domínios externos", () => {
  const html = `
    <a href="/en/games/brawlstars/blog/esports/first-look-at-bsc-2027/">
      <img alt="Imagem"><h2>First Look at BSC 2027</h2>
    </a>
    <a href="/en/games/brawlstars/blog/page/2/">Next</a>
    <a href="https://example.com/en/games/brawlstars/blog/news/falso/">Falso</a>
  `;
  assert.deepEqual(parseSourceArchive(blog, html), [
    {
      title: "First Look at BSC 2027",
      url: "https://supercell.com/en/games/brawlstars/blog/esports/first-look-at-bsc-2027/",
      publishedAt: null,
    },
  ]);
});

test("reconhece o formato real dos anúncios oficiais", () => {
  const html = `
    <a href='/en/news/brawl-wf-2025/'>Crazy Raccoon crowned champions</a>
    <a href='/en/news/announcement/brawlstars/page/1/'>Brawl Stars</a>
    <a href='/en/news/'>News</a>
  `;
  assert.equal(parseSourceArchive(announcements, html).length, 1);
  assert.equal(
    parseSourceArchive(announcements, html)[0]?.url,
    "https://supercell.com/en/news/brawl-wf-2025/",
  );
});

test("remove rastreamento, fragmento e normaliza barra final", () => {
  assert.equal(
    normalizeArticleUrl(
      "/en/news/novo-anuncio?utm_source=x#parte",
      announcements,
    ),
    "https://supercell.com/en/news/novo-anuncio/",
  );
});

test("limpa HTML e entidades comuns", () => {
  assert.equal(cleanText("<strong>A &amp; B</strong> <img alt='x'>"), "A & B");
  assert.equal(cleanText("A&nbsp;&mdash;&nbsp;&#x1F4E2;"), "A — 📢");
});

test("aceita href sem aspas sem ampliar os domínios permitidos", () => {
  const html = `<a href=/en/news/anuncio-sem-aspas>Comunicado oficial</a>`;
  assert.deepEqual(parseSourceArchive(announcements, html), [
    {
      title: "Comunicado oficial",
      url: "https://supercell.com/en/news/anuncio-sem-aspas/",
      publishedAt: null,
    },
  ]);
});

test("extrai somente vídeos válidos do feed oficial do YouTube", () => {
  const xml = `
    <feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
      <entry>
        <yt:videoId>B38eWbSuSiM</yt:videoId>
        <title>Brawl Talk &amp; novidades</title>
        <published>2026-08-30T10:00:00+00:00</published>
      </entry>
      <entry><yt:videoId>invalido</yt:videoId><title>Ignorar</title></entry>
    </feed>`;
  assert.deepEqual(parseSourceArchive(youtube, xml), [
    {
      title: "Brawl Talk & novidades",
      url: "https://www.youtube.com/watch?v=B38eWbSuSiM",
      publishedAt: "2026-08-30T10:00:00.000Z",
    },
  ]);
});
