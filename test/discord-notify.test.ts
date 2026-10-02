import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sendScaniaCourseStartNotification } from "../lib/discord-notify";

interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  description: string;
  color?: number;
  fields: DiscordField[];
}

interface DiscordPayload {
  content: string;
  embeds: DiscordEmbed[];
}

describe("discord-notify for Scania 167", () => {
  it("formats Discord webhook payload with required user pings and course details", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: DiscordPayload | undefined;

    const originalFetch = globalThis.fetch;
    // Mock fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      if (typeof init?.body === "string") {
        capturedBody = JSON.parse(init.body) as DiscordPayload;
      }
      return {
        ok: true,
        status: 204,
        text: async () => "",
      } as Response;
    }) as typeof globalThis.fetch;

    try {
      const ok = await sendScaniaCourseStartNotification({
        sideNumber: "167",
        courseLoid: 5055637,
        lineName: "7",
        direction: "Zajezdnia MZK",
        firstStopName: "Szyndzielnia",
        lastStopName: "Zajezdnia MZK.",
        startTime: "06:53",
        endTime: "07:01",
        stopsCount: 8,
        brigadeId: "7/1",
      });

      assert.equal(ok, true);
      assert(capturedUrl?.includes("discord.com/api/webhooks/"));

      // Verify exact user pings in content
      assert(capturedBody);
      assert.equal(capturedBody.content, "<@811894133039300619> <@1077282638013939742>");

      // Verify embed contents
      assert(Array.isArray(capturedBody.embeds) && capturedBody.embeds.length === 1);
      const embed = capturedBody.embeds[0];
      assert(embed.title.includes("Scania #167"));
      assert(embed.description.includes("Scania CN230UB"));
      assert(embed.description.includes("#167"));
      assert(embed.description.includes("7"));

      const fields = embed.fields;
      assert(fields.some((f) => f.name === "Linia i kierunek" && f.value.includes("7") && f.value.includes("Zajezdnia MZK")));
      assert(fields.some((f) => f.name === "Trasa kursu" && f.value.includes("Szyndzielnia") && f.value.includes("Zajezdnia MZK.")));
      assert(fields.some((f) => f.name === "Godziny kursu" && f.value.includes("06:53") && f.value.includes("07:01")));
      assert(fields.some((f) => f.name === "Brygada" && f.value.includes("7/1")));
      assert(fields.some((f) => f.name === "Liczba przystanków" && f.value.includes("8")));
      assert(fields.some((f) => f.name === "Śledzenie na żywo" && f.value.includes("exec=mzk:5055637:167") && f.value.includes("tabor=167")));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
