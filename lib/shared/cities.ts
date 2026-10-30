/**
 * Cities served from zbiorkom.live's open api6 (merged GTFS + live positions), keyed by their zbiorkom
 * slug. The slug is the `?city=` value, the id prefix (`krakow:<stop_id>`, `krakow:<type>_<vehicle>`)
 * and the storage-key suffix. Shared by the server and the client: no Node imports.
 * "gzm" is the first and fullest of them (SDIP overlay, fleet history, news, bikes); the rest get the
 * feed and the positions only, loaded on first request (lib/gzm-feed.ts).
 */
export interface ZbCity {
  name: string;
  /** operator / organiser: the data credit and the stop and trip labels */
  agency: string;
  center: [number, number];
  zoom: number;
  /** zoom from which stop markers are drawn (default 14; the ~7000-stop networks one level later) */
  stopMinZoom?: number;
}

export const ZB_CITIES = {
  gzm: { name: "Metropolia GZM", agency: "ZTM / Metropolia GZM", center: [50.2615, 19.0273], zoom: 11, stopMinZoom: 15 },
  bialystok: { name: "Białystok", agency: "Białostocka Komunikacja Miejska", center: [53.1042, 23.1429], zoom: 11 },
  boleslawiec: { name: "Bolesławiec", agency: "MZK Bolesławiec", center: [51.2566, 15.4308], zoom: 12 },
  chelm: { name: "Chełm", agency: "MPK Chełm", center: [51.1371, 23.4906], zoom: 13 },
  cieszyn: { name: "Cieszyn", agency: "ZGK Cieszyn", center: [49.7833, 18.6324], zoom: 13 },
  czestochowa: { name: "Częstochowa", agency: "MPK Częstochowa", center: [50.8082, 19.1256], zoom: 12 },
  elblag: { name: "Elbląg", agency: "ZKM Elbląg", center: [54.1872, 19.4654], zoom: 12 },
  elk: { name: "Ełk", agency: "MZK Ełk", center: [53.8401, 22.3275], zoom: 12 },
  gorzow: { name: "Gorzów Wielkopolski", agency: "MZK Gorzów Wielkopolski", center: [52.7261, 15.1846], zoom: 12 },
  kalisz: { name: "Kalisz", agency: "KLA Kalisz", center: [51.743, 18.0961], zoom: 12 },
  kielce: { name: "Kielce", agency: "ZTM Kielce", center: [50.8376, 20.6278], zoom: 11 },
  konin: { name: "Konin", agency: "MZK Konin", center: [52.2223, 18.2692], zoom: 12 },
  koszalin: { name: "Koszalin", agency: "MZK Koszalin", center: [54.1978, 16.2131], zoom: 12 },
  kolobrzeg: { name: "Kołobrzeg", agency: "KM Kołobrzeg", center: [54.1591, 15.5747], zoom: 13 },
  krakow: { name: "Kraków", agency: "ZTP Kraków", center: [50.0739, 19.9682], zoom: 10 },
  krasnik: { name: "Kraśnik", agency: "MPK Kraśnik", center: [50.9534, 22.1546], zoom: 12 },
  krosno: { name: "Krosno", agency: "MKS Krosno", center: [49.7232, 21.7365], zoom: 12 },
  kutno: { name: "Kutno", agency: "MZK Kutno", center: [52.2297, 19.371], zoom: 13 },
  legnica: { name: "Legnica", agency: "MPK Legnica", center: [51.2177, 16.2394], zoom: 12 },
  leszno: { name: "Leszno", agency: "MZK Leszno", center: [51.8555, 16.582], zoom: 12 },
  lublin: { name: "Lublin", agency: "ZTM Lublin", center: [51.2426, 22.5655], zoom: 11 },
  mielec: { name: "Mielec", agency: "MKS Mielec", center: [50.2978, 21.4643], zoom: 12 },
  olsztyn: { name: "Olsztyn", agency: "MPK Olsztyn", center: [53.7998, 20.4965], zoom: 12 },
  opole: { name: "Opole", agency: "MZK Opole", center: [50.6715, 17.8878], zoom: 12 },
  ostrowiecSwietokrzyski: { name: "Ostrowiec Świętokrzyski", agency: "MZK Ostrowiec Świętokrzyski", center: [50.9339, 21.3737], zoom: 12 },
  ostroleka: { name: "Ostrołęka", agency: "MZK Ostrołęka", center: [53.0568, 21.6106], zoom: 12 },
  oswiecim: { name: "Oświęcim", agency: "MZK Oświęcim", center: [50.0246, 19.2087], zoom: 12 },
  piotrkowTrybunalski: { name: "Piotrków Trybunalski", agency: "MZK Piotrków Trybunalski", center: [51.4062, 19.6847], zoom: 13 },
  pila: { name: "Piła", agency: "MZK Piła", center: [53.109, 16.6942], zoom: 12 },
  poznan: { name: "Poznań", agency: "ZTM Poznań", center: [52.3694, 16.8448], zoom: 11 },
  przemysl: { name: "Przemyśl", agency: "MZK Przemyśl", center: [49.7705, 22.7617], zoom: 12 },
  plock: { name: "Płock", agency: "KM Płock", center: [52.5696, 19.7444], zoom: 11 },
  radom: { name: "Radom", agency: "MZDiK Radom", center: [51.3891, 21.1809], zoom: 12 },
  rybnik: { name: "Rybnik", agency: "Komunikacja Miejska Rybnik", center: [50.1003, 18.5413], zoom: 12 },
  rzeszow: { name: "Rzeszów", agency: "MPK Rzeszów", center: [50.0207, 22.0186], zoom: 11 },
  siedlce: { name: "Siedlce", agency: "MPK Siedlce", center: [52.1636, 22.3528], zoom: 11 },
  skarzyskoKamienna: { name: "Skarżysko-Kamienna", agency: "MKS Skarżysko-Kamienna", center: [51.1181, 20.8719], zoom: 13 },
  stalowaWola: { name: "Stalowa Wola", agency: "MZK Stalowa Wola", center: [50.5743, 22.0463], zoom: 12 },
  starachowice: { name: "Starachowice", agency: "MPK Starachowice", center: [51.0363, 21.0783], zoom: 13 },
  suwalki: { name: "Suwałki", agency: "PGK Suwałki", center: [54.089, 22.9401], zoom: 12 },
  szczecin: { name: "Szczecin", agency: "ZDiTM Szczecin", center: [53.4385, 14.5444], zoom: 11 },
  slupsk: { name: "Słupsk", agency: "MZK Słupsk", center: [54.4642, 17.0478], zoom: 13 },
  tarnow: { name: "Tarnów", agency: "MPK Tarnów", center: [50.0237, 20.9766], zoom: 13 },
  tczew: { name: "Tczew", agency: "Komunikacja Miejska Tczew", center: [54.2085, 18.7163], zoom: 11 },
  tomaszowMazowiecki: { name: "Tomaszów Mazowiecki", agency: "MZK Tomaszów Mazowiecki", center: [51.5244, 20.0215], zoom: 12 },
  torun: { name: "Toruń", agency: "MZK Toruń", center: [53.0146, 18.6263], zoom: 11 },
  tricity: { name: "Trójmiasto", agency: "ZTM Gdańsk", center: [54.3563, 18.6447], zoom: 11 },
  warsaw: { name: "Warszawa", agency: "Warszawski Transport Publiczny", center: [52.2077, 21.0251], zoom: 10, stopMinZoom: 15 },
  walbrzych: { name: "Wałbrzych", agency: "MPK Wałbrzych", center: [50.7489, 16.2388], zoom: 12 },
  wroclaw: { name: "Wrocław", agency: "MPK Wrocław", center: [51.1112, 17.0022], zoom: 11 },
  zielonaGora: { name: "Zielona Góra", agency: "MZK Zielona Góra", center: [51.9171, 15.5517], zoom: 12 },
  lodz: { name: "Łódź", agency: "MPK Łódź", center: [51.7784, 19.4839], zoom: 11 },
  swinoujscie: { name: "Świnoujście", agency: "KA Świnoujście", center: [53.8899, 14.3359], zoom: 12 },
  zywiec: { name: "Żywiec", agency: "MZK Żywiec", center: [49.708, 19.2272], zoom: 12 },
} satisfies Record<string, ZbCity>;

export type ZbSlug = keyof typeof ZB_CITIES;

export const ZB_SLUGS = Object.keys(ZB_CITIES) as ZbSlug[];

export function isZbSlug(v: unknown): v is ZbSlug {
  return typeof v === "string" && Object.hasOwn(ZB_CITIES, v);
}

/** The zbiorkom city of a prefixed id ("krakow:1234", "gzm:283_4285"); null for a BB id (kb:, mzk:, plain). */
export function zbCityOf(id: unknown): ZbSlug | null {
  if (typeof id !== "string") return null;
  const p = id.slice(0, id.indexOf(":"));
  return isZbSlug(p) ? p : null;
}
