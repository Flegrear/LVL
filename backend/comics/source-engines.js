// Source engines. Sources run their own extension in the
// extension runner (ext-runner.js). LVL keeps its own version of two extensions,
// where it does something the extension doesn't (checked against the runner):
// - MangaFox (en.mangafox): chapters the mobile reader calls "licensed" are read from
//   the desktop reader (the extension shows no pages for them), and the site's credit
//   strip is cropped.
// - Kagane (all.kagane): kagane.cx moved to kagane.moe; LVL follows the move without
//   losing the search's POST body (the extension's search answers 404), and sends the
//   Origin its image server wants.
import { normalizeUnitNumber } from "../../shared/reading/units.js";
import { chapterItem, cleanTitle, fail, packedScripts, siteClient, sitePath, unique, unpackPacked } from "./source-site.js";

export { firstWithResults, imageOf, siteClient, sitePath } from "./source-site.js";

// ---- MangaFox (extension en.mangafox): fanfox.net, pages from the mobile site's "roll" view.
const FOX_COOKIES = "isAdult=1";
export const mangafox = {
  id: "mangafox",
  name: "MangaFox",
  signatures: [],
  async search(source, query, { remote }) {
    const site = siteClient(source, remote);
    const document = await site.doc(`${site.base}/search?${new URLSearchParams({ title: query, genres: "", nogenres: "", sort: "", stype: "1" })}`, { cookies: FOX_COOKIES });
    return unique(document.select("ul.manga-list-4-list li").map((element) => {
      const link = element.selectFirst("a");
      const href = link?.absAttr("href");
      if (!href) return null;
      return { path: sitePath(href), title: cleanTitle(link.attr("title") || element.selectFirst(".manga-list-4-item-title")?.text() || link.text()), cover: link.selectFirst("img")?.absAttr("src") || "" };
    }), (item) => item.path).filter((item) => item.path && item.title).slice(0, 20);
  },
  async chapters(source, path, { remote, title = "" }) {
    const site = siteClient(source, remote);
    const document = await site.doc(site.abs(path), { cookies: FOX_COOKIES });
    return unique(document.select("ul.detail-main-list li a").map((link) => {
      const lines = link.select(".detail-main-list-main p");
      return chapterItem({ href: link.absAttr("href"), name: lines[0]?.text() || link.attr("title"), date: lines.at(-1)?.text(), mangaTitle: title });
    }), (item) => item.path);
  },
  async pages(source, path, { remote }) {
    const site = siteClient(source, remote);
    const mobile = site.base.replace("://", "://m.");
    const document = await site.doc(`${mobile}${String(path).replace("/manga/", "/roll_manga/")}`, { referer: `${mobile}/`, cookies: `${FOX_COOKIES}; readway=2` });
    // MangaFox stamps a "This image is hosted at mangafox.com…" strip onto the bottom of each
    // page file (3–4 lines of 19 px); the reader crops it ("credit-strip").
    const images = document.select("#viewer img").map((img) => img.absAttr("data-original") || img.absAttr("src")).filter((image) => /^https?:\/\//.test(image));
    if (images.length) return { referer: `${mobile}/`, trim: "credit-strip", images };
    // The mobile reader says "Sorry, it's licensed and not available" for some series
    // (Vinland Saga); the desktop reader still has their pages.
    return { referer: `${site.base}/`, trim: "credit-strip", images: await foxDesktopPages(site, path) };
  },
};

// MangaFox's desktop reader: the page names the chapter id, the page count and a key
// (in a packed script); chapterfun.ashx answers, packed too, with two pages at a time.
async function foxDesktopPages(site, path) {
  const url = site.abs(path);
  const html = (await site.ok(url, { cookies: FOX_COOKIES })).text();
  const chapterId = /var chapterid\s*=\s*(\d+)/.exec(html)?.[1];
  const count = Math.min(Number(/var imagecount\s*=\s*(\d+)/.exec(html)?.[1]) || 0, 1000);
  if (!chapterId || !count) return [];
  const keyScript = packedScripts(html).find((text) => /guidkey/.test(text)) || "";
  const key = [...(/guidkey\s*=\s*([^;]+);/.exec(keyScript)?.[1] || "").matchAll(/'([^']*)'/g)].map((item) => item[1]).join("");
  const dir = url.replace(/[^/]*$/, "");
  const pages = new Array(count).fill("");
  const load = async (at) => {
    const answer = await site.ok(`${dir}chapterfun.ashx?${new URLSearchParams({ cid: chapterId, page: String(at), key })}`, { referer: url, cookies: FOX_COOKIES, headers: site.xhr });
    const text = unpackPacked(answer.text());
    const pix = /pix\s*=\s*"([^"]*)"/.exec(text)?.[1] || "";
    const values = [...(/pvalue\s*=\s*\[([^\]]*)\]/.exec(text)?.[1] || "").matchAll(/"([^"]*)"/g)].map((item) => item[1]);
    values.forEach((value, offset) => {
      const index = at - 1 + offset;
      if (index < count && !pages[index]) pages[index] = new URL(`${pix}${value}`, `${site.base}/`).href;
    });
  };
  const run = async (list) => { for (let at = 0; at < list.length; at += 4) await Promise.all(list.slice(at, at + 4).map(load)); };
  await run(Array.from({ length: Math.ceil(count / 2) }, (_, index) => index * 2 + 1));
  // A page a two-page answer didn't cover is asked for on its own, once.
  await run(pages.map((image, index) => (image ? 0 : index + 1)).filter(Boolean));
  return pages.filter((image) => /^https?:\/\//.test(image));
}

// ---- Kagane (extension all.kagane): JSON API; reading a chapter needs an
// integrity token and a per-chapter access token, like the extension does.
const KAGANE_INTEGRITY = new Map(); // base -> { token, exp }
async function kaganeIntegrity(site) {
  const known = KAGANE_INTEGRITY.get(site.base);
  if (known && known.exp - 30_000 > Date.now()) return known.token;
  await site.send(`${site.base}/`).catch(() => null);
  const data = (await site.ok(`${site.base}/api/integrity`, { json: "", accept: "application/json" })).json();
  if (!data?.token) throw fail("Kagane didn't give a reading token");
  KAGANE_INTEGRITY.set(site.base, { token: String(data.token), exp: Number(data.exp) * 1000 || Date.now() + 5 * 60_000 });
  return String(data.token);
}
const KAGANE_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const kagane = {
  id: "kagane",
  name: "Kagane",
  signatures: [],
  async search(source, query, { remote }) {
    const site = siteClient(source, remote);
    // The extension's defaults: Safe titles only, nothing pornographic or disturbing.
    // "Show adult content" (Settings › Comics) allows every rating, as the extension's own setting does.
    const body = source.adult
      ? { title: query, source_type: ["Official", "Unofficial", "Mixed"], content_lang: [source.lang || "en"], age_rating: ["Safe", "FifteenPlus", "EighteenPlus"] }
      : { title: query, source_type: ["Official", "Unofficial", "Mixed"], content_lang: [source.lang || "en"], age_rating: ["Safe"], is_pornographic: false, is_disturbing: false };
    const data = (await site.ok(`${site.base}/api/v2/search/series?page=0&size=35`, { json: body, accept: "application/json" })).json();
    return (data?.content || []).filter((item) => KAGANE_ID.test(item?.series_id || "")).slice(0, 20).map((item) => ({
      path: `/series/${item.series_id}`, title: cleanTitle(item.title), cover: item.cover_image_id ? `${site.base}/api/v2/image/${encodeURIComponent(item.cover_image_id)}` : "",
    }));
  },
  async chapters(source, path, { remote }) {
    const site = siteClient(source, remote);
    const seriesId = KAGANE_ID.exec(String(path).split("/")[2] || "")?.[0];
    if (!seriesId) throw fail("Unknown Kagane title", 400);
    const index = (await site.ok(`${site.base}/api/v2/series/${seriesId}/books/index?fields=List`, { accept: "application/json" })).json();
    const fields = index?.fields || [];
    return (index?.books || []).map((row) => Object.fromEntries(fields.map((field, i) => [field, row[i]]))).filter((book) => KAGANE_ID.test(book.book_id || "")).map((book) => {
      const name = String(book.title || "").replace(/(?:\s*\{[^{}]*\})+\s*$/, "").trim() || (book.chapter_no ? `Ch.${book.chapter_no}` : "");
      const entry = chapterItem({ href: `${site.base}/series/${seriesId}/reader/${book.book_id}`, name, date: Number(book.released_at) ? Number(book.released_at) * 1000 : null,
        group: (book.group_ix || []).map((ix) => index.groups?.[ix]?.title).filter(Boolean).join(", ") });
      if (entry) {
        entry.chapter = normalizeUnitNumber(book.chapter_no) ?? entry.chapter;
        entry.volume = normalizeUnitNumber(book.volume_no) ?? entry.volume;
      }
      return entry;
    }).filter(Boolean);
  },
  async pages(source, path, { remote }) {
    const site = siteClient(source, remote);
    const bookId = KAGANE_ID.exec(String(path).split("/").pop() || "")?.[0];
    if (!bookId) throw fail("Unknown Kagane chapter", 400);
    const token = await kaganeIntegrity(site);
    const challenge = (await site.ok(`${site.base}/api/v2/books/${bookId}?is_datasaver=false`, { json: {}, accept: "application/json", headers: { "x-integrity-token": token } })).json();
    const cache = String(challenge?.cache_url || "");
    if (!/^https:\/\/[^/]+$/.test(cache)) throw fail("Kagane sent an unexpected image server");
    const pages = [...(challenge?.manifest?.pages || [])].sort((a, b) => Number(a.page_no) - Number(b.page_no));
    // kstatic.to answers 404 ({"error": -7}) without an Origin from kagane.moe (the extension sends one by default).
    return { referer: `${site.base}/`, origin: site.base, expires: true, images: pages.filter((page) => /^[\w-]{8,64}$/.test(page.page_id || "")).map((page) =>
      `${cache}/api/v2/books/page/${bookId}/${page.page_id}.${/^[a-z0-9]{2,5}$/.test(page.ext || "") ? page.ext : "jxl"}?token=${encodeURIComponent(challenge.access_token || "")}`) };
  },
};

export const ENGINES = Object.freeze({ mangafox, kagane });
// Extensions LVL has its own version of, by package.
export const PACKAGE_ENGINES = Object.freeze({
  "eu.kanade.tachiyomi.extension.en.mangafox": "mangafox",
  "eu.kanade.tachiyomi.extension.all.kagane": "kagane",
});
// The extension version each of LVL's own engines was written against (checked
// with keiyoushi/extensions-source); a newer one in the repository is reported with site errors.
export const PACKAGE_ENGINE_VERSIONS = Object.freeze({ mangafox: "1.6.2", kagane: "1.6.37" });
export const engineFor = (theme) => ENGINES[theme] || null;
