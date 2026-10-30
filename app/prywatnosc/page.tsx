import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Prywatność i dane | Unimaps",
  description:
    "Co Unimaps robi z adresem IP, lokalizacją i powiadomieniami: bez kont, ciasteczek, analityki i reklam.",
};

/* Plain server-rendered text: facts about the running code (lib/rate-limit.ts, app/api/connections,
   app/api/geocode, lib/push-alerts.ts, lib/client/offline.ts). Change the code, change this page. */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-[17px] font-semibold text-text">{title}</h2>
      <div className="mt-2 flex flex-col gap-2 text-[14.5px] leading-relaxed text-text-mute [&_a]:text-text [&_a]:underline [&_a]:underline-offset-2 [&_strong]:font-medium [&_strong]:text-text">
        {children}
      </div>
    </section>
  );
}

export default function PrivacyPage() {
  return (
    <main className="min-h-dvh bg-bg px-4 pb-16 pt-[calc(env(safe-area-inset-top,0px)+1.5rem)] text-text">
      <div className="mx-auto max-w-[680px]">
        <Link href="/" className="text-[13px] text-text-mute hover:text-text">
          Wróć do mapy
        </Link>
        <h1 className="mt-4 text-[24px] font-semibold tracking-tight">Prywatność i dane</h1>
        <p className="mt-3 text-[14.5px] leading-relaxed text-text-mute">
          Unimaps nie ma kont, ciasteczek, analityki ani reklam. Kod jest otwarty (GPL-3.0-or-later):{" "}
          <a href="https://github.com/unisic/unimaps" className="text-text underline underline-offset-2">
            github.com/unisic/unimaps
          </a>
          .
        </p>

        <Section title="Co trafia na serwer Unimaps">
          <p>
            <strong>Adres IP.</strong> Służy wyłącznie do ograniczania liczby zapytań: licznik w pamięci serwera,
            usuwany po 60 sekundach bezczynności. Aplikacja nie zapisuje adresów IP w logach. Logi dostępu serwera
            pośredniczącego (np. nginx) zależą od konfiguracji hostingu.
          </p>
          <p>
            <strong>Lokalizacja.</strong> Przycisk „Moja lokalizacja” i przystanki w pobliżu działają w przeglądarce.
            Współrzędne trafiają na serwer tylko wtedy, gdy szukasz połączenia z punktu „Moja lokalizacja” lub z
            adresu: zaokrąglone do około 11 m, bez zapisu na dysku. W Metropolii GZM i pozostałych miastach
            wynik wyszukiwania pozostaje w pamięci serwera do minuty.
          </p>
          <p>
            <strong>Wyszukiwane adresy.</strong> Tekst zapytania serwer przekazuje do wyszukiwarki Photon (komoot,
            dane OpenStreetMap) ze swojego adresu, nie z Twojego. Wyniki pozostają w pamięci serwera do 24 godzin, bez
            powiązania z osobą.
          </p>
          <p>
            <strong>Powiadomienia („Powiadom mnie”).</strong> Po włączeniu serwer zapisuje subskrypcję push Twojej
            przeglądarki (adres w usłudze push producenta przeglądarki i klucze szyfrujące) oraz treść alertu:
            przystanek, linię, kierunek i czas odjazdu. Dane leżą w pliku na serwerze do czasu odjazdu albo do
            wyłączenia alertu. Przeglądarka bez żadnego aktywnego alertu znika z pliku. Bez tej subskrypcji alert
            działa tylko przy otwartej stronie.
          </p>
          <p>
            <strong>Zgłoszenia.</strong> „Zgłoś błąd lub pomysł” prowadzi do serwisu GitHub, który stosuje własne
            zasady prywatności.
          </p>
        </Section>

        <Section title="Co zostaje w Twojej przeglądarce">
          <p>
            Ulubione przystanki, zapisane miejsca (Dom, Praca) i trasy, włączone alerty, wybrane miasto, motyw, styl
            mapy, filtr linii, zasięg dojścia pieszego, przeczytane komunikaty oraz kopie listy przystanków i
            rozkładów ulubionych przystanków do użytku bez sieci. Nic z tego nie jest wysyłane na serwer. Usuniesz
            to, czyszcząc dane witryny w przeglądarce.
          </p>
        </Section>

        <Section title="Usługi, z którymi łączy się Twoja przeglądarka">
          <p>
            <strong>Mapa:</strong> tiles.openfreemap.org (OpenFreeMap), awaryjnie tile.openstreetmap.org. Widzą Twój
            adres IP i oglądany fragment mapy.
          </p>
          <p>
            <strong>Trasy po drogach:</strong> router.project-osrm.org (OSRM), tylko gdy serwer nie ma jeszcze
            kształtu trasy. Wysyłane są współrzędne przystanków kursu, nigdy Twoja pozycja.
          </p>
          <p>
            <strong>Powiadomienia push:</strong> usługa push producenta przeglądarki (Google, Apple lub Mozilla)
            dostarcza treść alertu.
          </p>
        </Section>

        <Section title="Skąd są dane o pojazdach">
          <p>
            Serwer Unimaps pobiera je sam, bez żadnych danych użytkowników: Komunikacja Beskidzka (KiedyPrzyjedzie),
            MZK Bielsko-Biała (rozklady.bielsko.pl, system OnTime), Metropolia GZM (ZTM / Metropolia GZM, CC BY,
            oraz SDIP), pozostałe miasta (rozkłady GTFS i pozycje pojazdów ich przewoźników). Historia floty na stronie{" "}
            <Link href="/brygady">/brygady</Link> dotyczy pojazdów, nie pasażerów.
          </p>
        </Section>

        <Section title="Kontakt">
          <p>
            Unimaps to niezależny projekt, niepowiązany z przewoźnikami. Pytania i wnioski dotyczące danych:{" "}
            <a href="https://github.com/unisic/unimaps/issues">github.com/unisic/unimaps/issues</a>.
          </p>
        </Section>
      </div>
    </main>
  );
}
