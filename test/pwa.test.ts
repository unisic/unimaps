import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

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

      // Never cache live data
      assert.ok(swCode.includes("/api/"), "must explicitly handle or skip /api/ paths");
    });
  });
});
