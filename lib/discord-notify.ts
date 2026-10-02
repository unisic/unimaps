/**
 * Discord Webhook Notifications for Fleet Vehicles (e.g. Scania #167).
 */
import { DISCORD_WEBHOOK_SCANIA_167 } from "./config";
import { log } from "./logger";

export interface CourseNotificationInfo {
  sideNumber: string;
  courseLoid: number;
  lineName: string;
  direction: string;
  firstStopName: string;
  lastStopName: string;
  startTime: string;
  endTime: string;
  stopsCount: number;
  brigadeId: string;
}

/**
 * Sends a Discord notification when Scania #167 starts a course.
 * Includes user pings: <@811894133039300619> and <@1077282638013939742>.
 */
export async function sendScaniaCourseStartNotification(
  info: CourseNotificationInfo,
): Promise<boolean> {
  const webhookUrl = DISCORD_WEBHOOK_SCANIA_167;
  if (!webhookUrl) {
    log.warn("discord-notify", "No Discord webhook URL configured for Scania #167");
    return false;
  }

  const pings = "<@811894133039300619> <@1077282638013939742>";

  const payload = {
    content: pings,
    embeds: [
      {
        title: "🚌 Scania #167 rozpoczęła nowy kurs!",
        description: `**Scania CN230UB** (tabor **#167**) rozpoczęła realizację kursu na linii **${info.lineName}**!`,
        color: 0x2563eb,
        fields: [
          {
            name: "Linia i kierunek",
            value: `🚌 **Linia ${info.lineName}** → **${info.direction}**`,
            inline: false,
          },
          {
            name: "Trasa kursu",
            value: `📍 **${info.firstStopName}** → 🏁 **${info.lastStopName}**`,
            inline: false,
          },
          {
            name: "Godziny kursu",
            value: `⏱️ Odjazd: **${info.startTime}** | Przyjazd: **${info.endTime}**`,
            inline: true,
          },
          {
            name: "Brygada",
            value: `📋 **${info.brigadeId}**`,
            inline: true,
          },
          {
            name: "Liczba przystanków",
            value: `🚏 **${info.stopsCount}**`,
            inline: true,
          },
          {
            name: "Śledzenie na żywo",
            value: `[🗺️ Otwórz na mapie na żywo](https://map.debondor.com/?exec=mzk:${info.courseLoid}:${info.sideNumber}) • [📋 Karta brygady #${info.sideNumber}](https://map.debondor.com/brygady?tabor=${info.sideNumber})`,
            inline: false,
          },
        ],
        footer: {
          text: "KB Mapa • Monitoring Taboru MZK Bielsko-Biała",
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      log.warn("discord-notify", `Discord webhook error HTTP ${res.status}: ${errText}`);
      return false;
    }

    log.info(
      "discord-notify",
      `Discord notification sent for Scania #${info.sideNumber} course ${info.courseLoid} (line ${info.lineName} -> ${info.direction})`,
    );
    return true;
  } catch (err) {
    log.warn("discord-notify", `Failed to send Discord webhook: ${err}`);
    return false;
  }
}
