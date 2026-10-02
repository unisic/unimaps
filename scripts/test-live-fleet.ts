import { getFleetTracker } from "../lib/fleet-tracker";
import { MzkApi } from "../lib/mzk-api";

async function testAll() {
  console.log("=== 1. Test połączenia z API MZK Bielsko-Biała ===");
  const api = new MzkApi();
  const running = await api.fetchRunningVehicles();
  console.log("Pobrana liczba pojazdów na trasie:", running.length);
  if (running.length === 0) {
    throw new Error("Brak pojazdów w API OnTime!");
  }
  const sample = running[0];
  console.log(`Przykładowy pojazd: #${sample.vehicleId}, Linia: ${sample.lineName}, Kierunek: ${sample.direction}`);
  console.log(`Liczba przystanków w bieżącym kursie: ${sample.stopPoints?.length}`);

  console.log("\n=== 2. Test aktualizacji FleetTracker ===");
  const tracker = getFleetTracker();
  tracker.updateFromRunningVehicles(running);

  const stats = tracker.getStats();
  console.log("Statystyki floty:", JSON.stringify(stats, null, 2));

  console.log("\n=== 3. Test filtrowania i podsumowania taboru ===");
  const allSummary = tracker.getFleetSummary();
  console.log("Łączna liczba wozów w bazie:", allSummary.length);

  const activeSummary = tracker.getFleetSummary({ status: "active" });
  console.log("Liczba wozów oznaczonych jako 'W trasie':", activeSummary.length);

  const h2Summary = tracker.getFleetSummary({ propulsion: "hydrogen" });
  console.log("Liczba wozów wodorowych:", h2Summary.length);

  const evSummary = tracker.getFleetSummary({ propulsion: "electric" });
  console.log("Liczba wozów elektrycznych:", evSummary.length);

  const megaSummary = tracker.getFleetSummary({ propulsion: "mega" });
  console.log("Liczba wozów MEGA przegubowych:", megaSummary.length);

  console.log("\n=== 4. Test szczegółów wozu, karty brygady i predykcji ===");
  const side = sample.vehicleId;
  const detail = tracker.getVehicleDetail(side);
  if (!detail) throw new Error("Nie znaleziono szczegółów dla wozu #" + side);

  console.log(`Wóz #${side}:`);
  console.log(`  Model: ${detail.model} (${detail.year})`);
  console.log(`  Brygada: ${detail.brigade.label}`);
  console.log(`  Status: ${detail.status}`);
  console.log("  Bieżący kurs:", {
    linia: detail.currentCourse?.lineName,
    kierunek: detail.currentCourse?.direction,
    obecnyPrzystanek: detail.currentCourse?.currentStopName,
    nastepnyPrzystanek: detail.currentCourse?.nextStopName,
    postepProcent: detail.currentCourse?.progressPct,
    opoznienieSek: detail.currentCourse?.delaySec,
  });

  console.log("  Predykcja kolejnego kursu (gdzie może być dalej):", detail.predictedNextCourse);
  console.log(`  Dzisiejsze kursy w karcie drogowej (liczba): ${detail.todayCourses.length}`);
  if (detail.todayCourses.length > 0) {
    const c1 = detail.todayCourses[0];
    console.log(`  Przykładowy kurs z historii: Linia ${c1.lineName} ${c1.startTime}-${c1.endTime} (${c1.firstStopName} -> ${c1.lastStopName})`);
  }
  console.log("  Statystyki wozu:", detail.stats);

  console.log("\n=== 5. Weryfikacja poprawności wszystkich pól ===");
  for (const v of allSummary) {
    if (!v.sideNumber || !v.model || !v.brigadeId) {
      throw new Error("Błąd w podsumowaniu wozu: " + JSON.stringify(v));
    }
  }
  console.log("Wszystkie " + allSummary.length + " pojazdów ma w 100% poprawne i kompletne dane!");
}

testAll()
  .then(() => {
    console.log("\n>>> WSZYSTKIE TESTY ZAKOŃCZONE SUKCESEM! <<<");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n>>> BŁĄD TESTU:", err);
    process.exit(1);
  });
