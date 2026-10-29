import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Unimaps: komunikacja miejska na żywo",
    short_name: "Unimaps",
    description:
      "Autobusy, tramwaje i trolejbusy na jednej mapie: Bielsko-Biała (Komunikacja Beskidzka, MZK) i Metropolia GZM. Pozycje na żywo, opóźnienia, rozkłady przystanków i trasy linii.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["fullscreen", "window-controls-overlay", "standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#0d1013",
    theme_color: "#0d1013",
    lang: "pl",
    dir: "ltr",
    prefer_related_applications: false,
    categories: ["travel", "navigation", "utilities"],
    shortcuts: [
      {
        name: "Mapa na żywo",
        short_name: "Mapa",
        url: "/",
        icons: [{ src: "/icon-192.png", sizes: "192x192" }],
      },
      {
        name: "Brygady i Tabor",
        short_name: "Brygady",
        url: "/brygady",
        icons: [{ src: "/icon-192.png", sizes: "192x192" }],
      },
    ],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
