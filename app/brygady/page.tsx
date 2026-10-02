import type { Metadata } from "next";
import BrigadesApp from "@/components/BrigadesApp";

export const metadata: Metadata = {
  title: "Brygady i Tabor — MZK Bielsko-Biała & KB | KB Mapa",
  description:
    "Śledzenie numerów taborowych, rozkładów brygad, przebytych kursów i przewidywanej lokalizacji pojazdów MZK Bielsko-Biała i Komunikacji Beskidzkiej.",
};

export default function BrigadesPage() {
  return <BrigadesApp />;
}
