import type { Metadata } from "next";

import MapShell from "@/components/MapShell";

/* the tab title is a React <title> in MapShell: it follows the city a load shows, which the server cannot know */
export const metadata: Metadata = { title: null };

export default function Page() {
  return <MapShell />;
}
