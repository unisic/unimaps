import type { Metadata } from "next";
import BrigadesApp from "@/components/BrigadesApp";

export const metadata: Metadata = {
  title: "Brygady i tabor MZK Bielsko-Biała | Unimaps",
  description:
    "Autobusy MZK Bielsko-Biała na żywo: gdzie jest każdy pojazd, dzisiejsze kursy, przejechane kilometry, opóźnienia i statystyki punktualności floty.",
};

export default function BrigadesPage() {
  return <BrigadesApp />;
}
