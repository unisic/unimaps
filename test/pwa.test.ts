import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import vm from "node:vm";

import manifestFn from "../app/manifest";

interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

function parsePngHeader(filePath: string): PngInfo {
  const buf = fs.readFileSync(filePath);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    assert.equal(buf[i], signature[i], `Invalid PNG signature in ${filePath}`);
  }
  // IHDR chunk: starts at byte 8, length is 13, chunk type is 'IHDR'
  const chunkType = buf.toString("ascii", 12, 16);
  assert.equal(chunkType, "IHDR", "First chunk must be IHDR");
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  return { width, height, bitDepth, colorType };
}

describe("PWA Specification and Assets Verification", () => {
  const publicDir = path.resolve(process.cwd(), "public");
  const manifest = manifestFn();

  describe("Web App Manifest", () => {
    it("provides core metadata compliant with PWA installability requirements", () => {
      assert.ok(manifest.name && manifest.name.length > 0, "manifest must have name");
      assert.ok(manifest.short_name && manifest.short_name.length > 0, "manifest must have short_name");
      assert.equal(manifest.start_url, "/", "start_url must be /");
      assert.equal(manifest.scope, "/", "scope must be /");
      assert.equal(manifest.id, "/", "id must be /");
      assert.equal(manifest.display, "standalone", "display mode must be standalone");
      assert.ok(manifest.display_override?.includes("standalone"), "display_override must contain standalone");
      assert.equal(manifest.background_color, "#0d1013", "background_color matches dark theme");
      assert.equal(manifest.theme_color, "#0d1013", "theme_color matches dark theme");
      assert.equal(manifest.lang, "pl", "language must be Polish (pl)");
      assert.equal(manifest.prefer_related_applications, false);
    });

    it("includes required icon sets (any and maskable, 192x192 and 512x512)", () => {
      const icons = manifest.icons ?? [];
      assert.ok(icons.length >= 4, "manifest must provide at least 4 icons");

      const any192 = icons.find((i) => i.sizes === "192x192" && (i.purpose === "any" || !i.purpose));
      const any512 = icons.find((i) => i.sizes === "512x512" && (i.purpose === "any" || !i.purpose));
      const maskable192 = icons.find((i) => i.sizes === "192x192" && i.purpose === "maskable");
      const maskable512 = icons.find((i) => i.sizes === "512x512" && i.purpose === "maskable");

      assert.ok(any192, "must provide 192x192 icon with purpose any");
      assert.ok(any512, "must provide 512x512 icon with purpose any");
      assert.ok(maskable192, "must provide 192x192 icon with purpose maskable");
      assert.ok(maskable512, "must provide 512x512 icon with purpose maskable");
    });

    it("verifies all referenced icon files exist on disk with matching pixel dimensions", () => {
      const allIcons = [...(manifest.icons ?? []), ...((manifest.shortcuts ?? []).flatMap((s) => s.icons ?? []))];
      for (const icon of allIcons) {
        const filePath = path.join(publicDir, icon.src.replace(/^\//, ""));
        assert.ok(fs.existsSync(filePath), `Icon file missing: ${icon.src}`);
        const stat = fs.statSync(filePath);
        assert.ok(stat.size > 0, `Icon file is empty: ${icon.src}`);

        if (icon.sizes && icon.sizes.includes("x")) {
          const [expectedW, expectedH] = icon.sizes.split("x").map(Number);
          const info = parsePngHeader(filePath);
          assert.equal(info.width, expectedW, `Width mismatch for ${icon.src}`);
          assert.equal(info.height, expectedH, `Height mismatch for ${icon.src}`);
        }
      }
    });
  });

  describe("iOS Safari & Apple PWA Experience", () => {
    it("provides an opaque 180x180 RGB apple-touch-icon without alpha channel", () => {
      const appleIconPath = path.join(publicDir, "apple-touch-icon.png");
      assert.ok(fs.existsSync(appleIconPath), "apple-touch-icon.png must exist in public/");
      const info = parsePngHeader(appleIconPath);
      assert.equal(info.width, 180, "apple-touch-icon width must be 180");
      assert.equal(info.height, 180, "apple-touch-icon height must be 180");
      // Color type 2 is RGB (no alpha channel), preventing black boxes on iOS squircle
      assert.equal(info.colorType, 2, "apple-touch-icon must be solid RGB (colorType 2) without alpha");
    });

    it("configures layout metadata and viewport for standalone iOS experience", () => {
      const layoutSrc = fs.readFileSync(path.resolve(process.cwd(), "app/layout.tsx"), "utf-8");
      assert.ok(layoutSrc.includes('applicationName: "KB Mapa"'), "must define applicationName");
      assert.ok(layoutSrc.includes("telephone: false"), "must disable telephone formatDetection on iOS");
      assert.ok(layoutSrc.includes("capable: true"), "must set appleWebApp capable: true");
      // opaque on purpose: black-translucent makes iOS 26 standalone leave a dead strip at the bottom (WebKit bug 301108)
      assert.ok(layoutSrc.includes('statusBarStyle: "black"'), "must set statusBarStyle: black");
      assert.ok(layoutSrc.includes('title: "KB Mapa"'), "must set appleWebApp title");
      assert.ok(layoutSrc.includes('"mobile-web-app-capable": "yes"'), "must set mobile-web-app-capable");
      assert.ok(layoutSrc.includes('viewportFit: "cover"'), "must set viewportFit: cover for notch/island");
      assert.ok(layoutSrc.includes('interactiveWidget: "resizes-content"'), "must set interactiveWidget: resizes-content");
      assert.ok(layoutSrc.includes("userScalable: false"), "must prevent accidental page zoom");
      assert.ok(layoutSrc.includes("maximumScale: 1"), "must lock maximumScale: 1");
    });
  });

  describe("Service Worker & Offline Shell", () => {
    const swPath = path.join(publicDir, "sw.js");

    it("contains sw.js script with essential caching and lifecycle handlers", () => {
      assert.ok(fs.existsSync(swPath), "sw.js must exist in public/");
      const swCode = fs.readFileSync(swPath, "utf-8");

      assert.ok(swCode.includes("addEventListener(\"install\""), "must handle install event");
      assert.ok(swCode.includes("addEventListener(\"activate\""), "must handle activate event");
      assert.ok(swCode.includes("addEventListener(\"fetch\""), "must handle fetch event");
      assert.ok(swCode.includes("SKIP_WAITING"), "must support SKIP_WAITING message");
      assert.ok(swCode.includes("PRECACHE_URLS"), "must define precache URLs");
      assert.ok(swCode.includes("/manifest.webmanifest"), "must precache manifest");
      assert.ok(swCode.includes("/apple-touch-icon.png"), "must precache apple touch icon");

    });

    it("caches per build: /sw.js?v=<build id> opens its own cache, the bare URL the legacy one", async () => {
      const sw = loadSw({ "/brand.svg": "v1" }, "?v=abc123");
      await sw.dispatch("/brand.svg");
      assert.deepEqual([...new Set(sw.opened)], ["kb-shell-abc123"]);
      const legacy = loadSw({ "/brand.svg": "v1" });
      await legacy.dispatch("/brand.svg");
      assert.deepEqual([...new Set(legacy.opened)], ["kb-shell-v2"]);
      const reg = fs.readFileSync(path.resolve(process.cwd(), "components/PwaRegister.tsx"), "utf-8");
      assert.ok(reg.includes("/sw.js?v=${process.env.NEXT_PUBLIC_BUILD_ID"), "PwaRegister registers the versioned script");
    });

    it("activate drops the previous deploy's shell but keeps the page's kb-offline store", async () => {
      const sw = loadSw({}, "?v=new");
      sw.cacheNames.push("kb-shell-old", "kb-shell-new", "kb-offline");
      await sw.activate();
      assert.deepEqual(sw.deleted, ["kb-shell-old"]);
    });

    it("an alert notification opens its stop in the map tab, a new window without one", async () => {
      const sw = loadSw({});
      sw.tabs.push({ url: "https://kb.test/brygady", focused: false, navigated: null });
      sw.tabs.push({ url: "https://kb.test/?trip=1", focused: false, navigated: null });
      await sw.click({ url: "/?stop=123" });
      assert.deepEqual(sw.tabs[1], { url: "https://kb.test/?trip=1", focused: true, navigated: "https://kb.test/?stop=123" });
      assert.equal(sw.tabs[0].navigated, null);
      const fresh = loadSw({});
      await fresh.click({ url: "/?stop=123" });
      await fresh.click({ url: "https://evil.test/" });
      assert.deepEqual(fresh.windows, ["https://kb.test/?stop=123"]);
    });

    it("never answers /api/* from the SW (live data goes straight to the network)", async () => {
      const sw = loadSw({ "/api/vehicles": "live" });
      assert.equal(sw.dispatch("/api/vehicles"), null);
      assert.equal(sw.dispatch("/api/stops"), null);
      assert.equal(sw.dispatch("/api/health", "navigate"), null); // opened as a page: still not cached
    });

    it("offline navigation serves the page last loaded at THAT path, the / shell only as a fallback", async () => {
      const sw = loadSw({ "/": "map", "/brygady": "brygady" });
      await sw.dispatch("/brygady", "navigate");
      await sw.dispatch("/", "navigate");
      sw.offline = true;
      assert.equal(await (await sw.dispatch("/brygady", "navigate"))!.text(), "brygady");
      assert.equal(await (await sw.dispatch("/?stop=1", "navigate"))!.text(), "map");
      assert.equal(await (await sw.dispatch("/other", "navigate"))!.text(), "map");
    });

    it("icons are stale-while-revalidate: a changed file replaces the cached copy behind the scenes", async () => {
      const sw = loadSw({ "/brand.svg": "v1" });
      assert.equal(await (await sw.dispatch("/brand.svg"))!.text(), "v1");
      sw.files["/brand.svg"] = "v2";
      assert.equal(await (await sw.dispatch("/brand.svg"))!.text(), "v1"); // instant, from cache
      await sw.settled();
      assert.equal(await (await sw.dispatch("/brand.svg"))!.text(), "v2");
    });
  });
});

/** Runs public/sw.js in a fake service-worker global: Map-backed CacheStorage, a fake network over `files`. */
function loadSw(files: Record<string, string>, query = "") {
  const origin = "https://kb.test";
  const listeners = new Map<string, (e: unknown) => void>();
  const store = new Map<string, Response>();
  const pending: Promise<unknown>[] = [];
  const opened: string[] = [];
  const cacheNames: string[] = [];
  const deleted: string[] = [];
  const key = (r: Request | string): string => (typeof r === "string" ? new URL(r, origin).href : r.url);
  const cache = {
    match: async (r: Request | string) => store.get(key(r))?.clone(),
    put: async (r: Request | string, resp: Response) => void store.set(key(r), resp),
  };
  const h = {
    files,
    offline: false,
    dispatch(p: string, mode = "no-cors"): Promise<Response> | null {
      let answer: Promise<Response> | null = null;
      listeners.get("fetch")!({
        request: { method: "GET", url: new URL(p, origin).href, mode },
        respondWith: (r: Promise<Response>) => (answer = r),
        waitUntil: (pr: Promise<unknown>) => void pending.push(pr),
      });
      return answer;
    },
    settled: () => Promise.all(pending),
    async activate(): Promise<void> {
      listeners.get("activate")!({ waitUntil: (pr: Promise<unknown>) => void pending.push(pr) });
      await Promise.all(pending);
    },
    opened,
    cacheNames,
    deleted,
    tabs: [] as { url: string; focused: boolean; navigated: string | null }[],
    windows: [] as string[],
    async click(data: unknown): Promise<void> {
      listeners.get("notificationclick")!({
        notification: { data, close: () => {} },
        waitUntil: (pr: Promise<unknown>) => void pending.push(pr),
      });
      await Promise.all(pending);
    },
  };
  const fakeFetch = async (r: Request | string): Promise<Response> => {
    if (h.offline) throw new TypeError("offline");
    const body = files[new URL(key(r)).pathname];
    return body == null ? new Response("nf", { status: 404 }) : new Response(body);
  };
  const self = {
    location: { origin, href: `${origin}/sw.js${query}` },
    addEventListener: (t: string, fn: (e: unknown) => void) => listeners.set(t, fn),
    clients: {
      claim: async () => {},
      matchAll: async () =>
        h.tabs.map((t) => ({
          url: t.url,
          focus: async () => void (t.focused = true),
          navigate: async (u: string) => void (t.navigated = u),
        })),
      openWindow: async (u: string) => void h.windows.push(u),
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(process.cwd(), "public/sw.js"), "utf-8"), {
    self,
    caches: {
      open: async (name: string) => (opened.push(name), cache),
      keys: async () => [...cacheNames],
      delete: async (name: string) => (deleted.push(name), true),
    },
    fetch: fakeFetch,
    URL,
    Response,
  });
  return h;
}
