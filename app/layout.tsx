import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import PwaRegister from "@/components/PwaRegister";
import "./globals.css";

export const metadata: Metadata = {
  title: "Komunikacja Beskidzka: mapa pojazdów na żywo",
  applicationName: "KB Mapa",
  description:
    "Wszystkie autobusy Komunikacji Beskidzkiej na jednej mapie: pozycje na żywo, opóźnienia, rozkłady przystanków i trasy linii.",
  formatDetection: {
    telephone: false,
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "KB Mapa",
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
    { media: "(prefers-color-scheme: light)", color: "#0d1013" },
  ],
  // edge-to-edge in standalone/notched displays; safe-area insets handled per component
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl" className={`${GeistSans.variable} min-h-full`}>
      <head>
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
