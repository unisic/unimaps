import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { parseGzmNews } from "../lib/gzm-news";

const html = fs.readFileSync(path.join(__dirname, "fixtures", "gzm-news.html"), "utf8");

describe("parseGzmNews", () => {
  it("reads id, title, update stamp and lead of every panel (captured page + one synthetic)", () => {
    const items = parseGzmNews(html);
    assert.equal(items.length, 4);
    const [first] = items;
    assert.equal(first.id, 3224);
    assert.equal(first.operator, "GZM");
    assert.equal(first.url, "https://rj.transportgzm.pl/v2/news/i/3224/");
    assert.match(first.content_markdown, /^\*\*\[GZM\] Komunikat o bieżących utrudnieniach w funkcjonowaniu komunikacji miejskiej\.\*\*\n\nAktualizacja: 30\.10\.2026 06:05\n\nW komunikacie prezentowane/);
    assert.ok(Number.isInteger(first.rev) && first.rev > 0);
    assert.equal(new Set(items.map((i) => i.id)).size, 4);
  });

  it("decodes entities, tolerates a missing time and lead", () => {
    const last = parseGzmNews(html)[3];
    assert.equal(last.id, 99);
    assert.equal(last.content_markdown, '**[GZM] Objazd "Centrum" & zmiana tras**\n\nAktualizacja: 01.11.2026');
  });

  it("rev follows the content, not the position", () => {
    const a = parseGzmNews(html);
    const b = parseGzmNews(html.replace("06:05", "07:05"));
    assert.notEqual(a[0].rev, b[0].rev);
    assert.equal(a[1].rev, b[1].rev);
  });

  it("an unrelated page yields nothing", () => {
    assert.deepEqual(parseGzmNews("<html><body><div class=\"panel panel-default\">no link</div></body></html>"), []);
  });
});
