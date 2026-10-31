/**
 * The <head> every page shares (vite.config.ts writes it into each app/*.html at <!--head-->): the
 * same tags the Next layout used to emit, so the PWA, iOS standalone mode and the theme behave as before.
 */

/* Runs before first paint: kb:theme, else the system setting (followed live), as data-theme on <html>,
   plus the browser chrome colour in its own first <meta>. Mirrors setThemePref in lib/client/theme.ts.
   ponytail: /brygady stays dark, its charts draw with fixed dark colours. */
const THEME_SCRIPT = `(function(){var d=document.documentElement,m=matchMedia("(prefers-color-scheme: light)");function a(){var p=null;try{p=localStorage.getItem("kb:theme")}catch(e){}var t=location.pathname.indexOf("/brygady")===0?"dark":p==="light"||p==="dark"?p:m.matches?"light":"dark";d.dataset.theme=t;var e=document.getElementById("kb-theme-color");if(!e){e=document.createElement("meta");e.name="theme-color";e.id="kb-theme-color";document.head.prepend(e)}e.content=t==="light"?"#f2f3f5":"#0d1013"}a();m.addEventListener("change",a)})()`;

export const SITE_TITLE = "Unimaps: komunikacja miejska na żywo";
export const SITE_DESCRIPTION =
  "Autobusy, tramwaje i trolejbusy na jednej mapie: Bielsko-Biała (Komunikacja Beskidzka, MZK), Metropolia GZM, Warszawa, Kraków, Łódź, Wrocław, Poznań i ponad 40 innych miast. Pozycje na żywo, opóźnienia, rozkłady przystanków i trasy linii.";

export const PAGES: Record<string, { title: string; description: string }> = {
  "index.html": { title: SITE_TITLE, description: SITE_DESCRIPTION },
  "brygady.html": {
    title: "Brygady i tabor MZK Bielsko-Biała | Unimaps",
    description:
      "Autobusy MZK Bielsko-Biała na żywo: gdzie jest każdy pojazd, dzisiejsze kursy, przejechane kilometry, opóźnienia i statystyki punktualności floty.",
  },
  "prywatnosc.html": {
    title: "Prywatność i dane | Unimaps",
    description: "Co Unimaps robi z adresem IP, lokalizacją i powiadomieniami: bez kont, ciasteczek, analityki i reklam.",
  },
  "404.html": { title: "Nie ma takiej strony | Unimaps", description: SITE_DESCRIPTION },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function head(page: { title: string; description: string }): string {
  return [
    `<meta charset="utf-8">`,
    // not black-translucent: iOS 26 standalone then sizes the web view one status bar short and leaves a
    // dead strip at the bottom (WebKit bug 301108); viewport-fit=cover: safe-area insets per component
    `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content">`,
    `<script>${THEME_SCRIPT}</script>`,
    // a <link>, not a JS import: the dev server would inject the styles only after the whole module graph ran
    `<link rel="stylesheet" href="/globals.css">`,
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0d1013">`,
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f2f3f5">`,
    `<title>${esc(page.title)}</title>`,
    `<meta name="description" content="${esc(page.description)}">`,
    `<meta name="application-name" content="Unimaps">`,
    `<link rel="manifest" href="/manifest.webmanifest">`,
    `<meta name="mobile-web-app-capable" content="yes">`,
    `<meta name="apple-touch-fullscreen" content="yes">`,
    `<meta name="format-detection" content="telephone=no">`,
    `<meta name="apple-mobile-web-app-title" content="Unimaps">`,
    `<meta name="apple-mobile-web-app-status-bar-style" content="black">`,
    `<link rel="icon" href="/favicon.ico" sizes="any">`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`,
    `<link rel="icon" href="/icon-192.png" type="image/png" sizes="192x192">`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" type="image/png">`,
    `<link rel="preconnect" href="https://tiles.openfreemap.org" crossorigin="">`,
    `<link rel="dns-prefetch" href="https://tiles.openfreemap.org">`,
    `<link rel="preconnect" href="https://tile.openstreetmap.org" crossorigin="">`,
    `<link rel="dns-prefetch" href="https://tile.openstreetmap.org">`,
  ].join("\n    ");
}
