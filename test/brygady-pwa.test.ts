import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import manifestFn from "../app/manifest";

describe("Brygady Section PWA & Mobile UX (iOS & Android)", () => {
  const brigadesAppPath = path.resolve(process.cwd(), "components/BrigadesApp.tsx");
  const brigadesSource = fs.readFileSync(brigadesAppPath, "utf-8");
  const manifest = manifestFn();

  describe("PWA Manifest Shortcuts", () => {
    it("includes a dedicated home-screen shortcut for Brygady i Tabor", () => {
      const shortcuts = manifest.shortcuts ?? [];
      const brygadyShortcut = shortcuts.find((s) => s.url === "/brygady");
      assert.ok(brygadyShortcut, "manifest must define a shortcut with url: /brygady");
      assert.equal(brygadyShortcut.name, "Brygady i Tabor");
      assert.equal(brygadyShortcut.short_name, "Brygady");
      assert.ok(brygadyShortcut.icons && brygadyShortcut.icons.length > 0, "shortcut must provide an icon");
    });
  });

  describe("iOS Safe Area Insets (Notch, Dynamic Island & Home Indicator)", () => {
    it("ensures sticky header includes safe-area-inset-top clearance for iOS status bar & Dynamic Island", () => {
      assert.ok(
        brigadesSource.includes("env(safe-area-inset-top"),
        "Sticky header in BrigadesApp must use env(safe-area-inset-top) to avoid overlapping notch/Dynamic Island",
      );
      assert.ok(
        brigadesSource.includes("pt-[calc(env(safe-area-inset-top,0px)+0.75rem)]"),
        "Header must have comfortable top clearance (0.75rem + safe-area-inset-top)",
      );
    });

    it("ensures page layout and toast alerts respect safe-area-inset-bottom for iOS Home Indicator", () => {
      assert.ok(
        brigadesSource.includes("pb-[calc(env(safe-area-inset-bottom,0px)+5rem)]"),
        "Page container must leave space at bottom for iOS home indicator bar",
      );
      assert.ok(
        brigadesSource.includes("bottom-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]"),
        "Toast notifications and floating actions must clear the home indicator",
      );
    });

    it("ensures vehicle detail modal scroll container has safe-area-inset-bottom padding", () => {
      assert.ok(
        brigadesSource.includes("pb-[calc(env(safe-area-inset-bottom,0px)+2rem)]"),
        "Modal body must have bottom safe area padding so last rows aren't cut off by the gesture bar",
      );
    });
  });

  describe("Mobile Bottom-Sheet Pattern for Detail Modal", () => {
    it("renders modal as a native bottom sheet on mobile screens (< sm)", () => {
      assert.ok(
        brigadesSource.includes("items-end sm:items-center"),
        "Modal overlay must anchor to bottom on mobile and center on desktop",
      );
      assert.ok(
        brigadesSource.includes("rounded-t-3xl sm:rounded-3xl"),
        "Modal dialog must use rounded top corners for bottom-sheet aesthetic on mobile",
      );
      assert.ok(
        brigadesSource.includes("max-h-[88dvh] sm:max-h-[90vh]"),
        "Modal dialog must use dynamic viewport units (dvh) on mobile to respect browser URL bars",
      );
    });

    it("includes a visual drag-handle indicator on mobile", () => {
      assert.ok(
        brigadesSource.includes("w-12 h-1.5 bg-white/20 rounded-full mx-auto my-2.5 sm:hidden"),
        "Bottom sheet must have a subtle handle pill indicator on mobile screens",
      );
    });
  });

  describe("Touch Targets & Clickability (Apple HIG & Material Design)", () => {
    it("ensures 'Mapa na żywo' navigation button has at least 42px touch target height", () => {
      assert.ok(
        brigadesSource.includes("min-h-[42px]"),
        "'Mapa na żywo' button must have min-h-[42px] for effortless thumb tapping",
      );
      assert.ok(
        brigadesSource.includes("active:scale-95"),
        "Button must provide instant active press feedback",
      );
    });

    it("ensures search input and clear button have >= 44px touch targets", () => {
      assert.ok(
        brigadesSource.includes("min-h-[44px]"),
        "Search input must have min-h-[44px]",
      );
      assert.ok(
        brigadesSource.includes("w-11 flex items-center justify-center"),
        "Clear search button must provide 44px (w-11) touch target width",
      );
    });

    it("ensures status, propulsion, and line filter buttons have generous touch heights", () => {
      assert.ok(
        brigadesSource.includes("min-h-[38px]"),
        "Status segment buttons must have min-h-[38px]",
      );
      assert.ok(
        brigadesSource.includes("min-h-[34px]"),
        "Propulsion filter buttons must have min-h-[34px]",
      );
      assert.ok(
        brigadesSource.includes("min-h-[32px]"),
        "Line filter buttons must have min-h-[32px]",
      );
    });

    it("ensures modal header action buttons (Share and Close) have 44x44px touch targets", () => {
      assert.ok(
        brigadesSource.includes("min-w-[44px] min-h-[44px]"),
        "Share and close buttons in modal header must have at least 44x44px touch target",
      );
    });
  });

  describe("Mobile Web Share API & Scroll Persistence", () => {
    it("supports navigator.share with fallback to clipboard", () => {
      assert.ok(
        brigadesSource.includes("navigator.share"),
        "Must invoke native mobile share sheet when navigator.share is supported",
      );
      assert.ok(
        brigadesSource.includes("navigator.clipboard.writeText"),
        "Must fall back to clipboard copy when native share is unavailable",
      );
    });

    it("preserves scroll position when opening or closing vehicles using scroll: false", () => {
      assert.ok(
        brigadesSource.includes("router.push(`/brygady?${params.toString()}`, { scroll: false })"),
        "Selecting vehicle must pass { scroll: false } to prevent jumping to top of page",
      );
      assert.ok(
        brigadesSource.includes("router.back()"),
        "Closing vehicle must respect browser history with router.back()",
      );
    });

    it("provides a floating scroll-to-top button when scrolled down", () => {
      assert.ok(
        brigadesSource.includes("showScrollTop"),
        "Component must track scroll position to reveal scroll-to-top button",
      );
      assert.ok(
        brigadesSource.includes("scrollToTop"),
        "Must provide smooth scroll to top function",
      );
      assert.ok(
        brigadesSource.includes("<ArrowUpIcon />"),
        "Must render floating button with arrow up icon",
      );
    });

    it("provides interactive feedback and affordance for expandable course rows", () => {
      assert.ok(
        brigadesSource.includes("active:bg-white/[0.04]"),
        "Course rows must provide tactile active touch feedback",
      );
      assert.ok(
        brigadesSource.includes("ChevronDownIcon"),
        "Course rows must display chevron to indicate expandability",
      );
    });
  });
});
