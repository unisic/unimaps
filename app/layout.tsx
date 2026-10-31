import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import PwaRegister from "@/components/PwaRegister";
import "./globals.css";

/* Runs before first paint: kb:theme, else the system setting (followed live), as data-theme on <html>,
   plus the browser chrome colour in its own first <meta> (editing Next's theme-color tags makes React
   re-insert them at hydration, it keys them by content). Mirrors setThemePref in lib/client/theme.ts.
   ponytail: /brygady stays dark, its charts draw with fixed dark colours. */
const THEME_SCRIPT = `(function(){var d=document.documentElement,m=matchMedia("(prefers-color-scheme: light)");function a(){var p=null;try{p=localStorage.getItem("kb:theme")}catch(e){}var t=location.pathname.indexOf("/brygady")===0?"dark":p==="light"||p==="dark"?p:m.matches?"light":"dark";d.dataset.theme=t;var e=document.getElementById("kb-theme-color");if(!e){e=document.createElement("meta");e.name="theme-color";e.id="kb-theme-color";document.head.prepend(e)}e.content=t==="light"?"#f2f3f5":"#0d1013"}a();m.addEventListener("change",a)})()`;

export const metadata: Metadata = {
  title: "Unimaps: komunikacja miejska na żywo",
  applicationName: "Unimaps",
  description:
    "Autobusy, tramwaje i trolejbusy na jednej mapie: Bielsko-Biała (Komunikacja Beskidzka, MZK), Metropolia GZM, Warszawa, Kraków, Łódź, Wrocław, Poznań i ponad 40 innych miast. Pozycje na żywo, opóźnienia, rozkłady przystanków i trasy linii.",
  formatDetection: {
    telephone: false,
  },
  appleWebApp: {
    capable: true,
    // not black-translucent: iOS 26 standalone then sizes the web view one status bar
    // short and leaves a dead strip at the bottom (WebKit bug 301108)
    statusBarStyle: "black",
    title: "Unimaps",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-touch-fullscreen": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0d1013" },
    { media: "(prefers-color-scheme: light)", color: "#f2f3f5" },
  ],
  // edge-to-edge in standalone/notched displays; safe-area insets handled per component
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // the theme script sets data-theme before hydration
    <html lang="pl" className={`${GeistSans.variable} min-h-full`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="preconnect" href="https://tiles.openfreemap.org" crossOrigin="" />
        <link rel="dns-prefetch" href="https://tiles.openfreemap.org" />
        <link rel="preconnect" href="https://tile.openstreetmap.org" crossOrigin="" />
        <link rel="dns-prefetch" href="https://tile.openstreetmap.org" />
      </head>
      <body className="min-h-full bg-bg font-sans text-text antialiased">
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
