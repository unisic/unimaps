/**
 * "Zapowiedzi przystanków": plays ZTM's recorded "Następny przystanek" and the stop's recorded name
 * (/api/announce/<name>). Module-level external store like smoothMotion.ts, deliberately NOT persisted: a browser
 * allows audio only after a user gesture, and the tap on the switch is that gesture, so every page load starts off.
 */
import { external } from "@/lib/client/external";
import { announceKey } from "@/lib/shared/announce";

let on = false;
const subs = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let ctl: AbortController | null = null;
let urls: string[] = [];
/* the one blob kept in JS (~50 KB); stop names come from the HTTP cache */
let phrase: Blob | null = null;

/** Ends the current announcement: its fetches, its playback and its object URLs. */
function stop(): void {
  ctl?.abort();
  ctl = null;
  if (audio) {
    audio.onended = audio.onerror = null;
    audio.pause();
  }
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
}

export function setAnnouncer(v: boolean): void {
  if (!v) stop();
  if (v === on) return;
  on = v;
  subs.forEach((fn) => fn());
}

async function clip(name: string, signal: AbortSignal): Promise<Blob | null> {
  const res = await fetch(`/api/announce/${name}`, { signal });
  return res.ok ? res.blob() : null;
}

/** Announces a stop: "Następny przystanek" + the name (`approaching`, said on leaving the previous stop) or the
 *  name alone (the repeat near / at the stop). The latest call wins, a stop without a recording stays silent. */
export function announceStop(name: string, approaching = true): void {
  const key = announceKey(name);
  if (!on || !key || typeof Audio === "undefined") return;
  stop();
  const c = (ctl = new AbortController());
  Promise.all([clip(`s-${key}`, c.signal), approaching ? (phrase ?? clip("p-next", c.signal)) : null])
    .then(([stopClip, phraseClip]) => {
      if (c.signal.aborted || !stopClip || (approaching && !phraseClip)) return;
      if (phraseClip) phrase = phraseClip;
      const a = (audio ??= new Audio());
      const queue = (urls = (phraseClip ? [phraseClip, stopClip] : [stopClip]).map((b) => URL.createObjectURL(b))).slice();
      const next = (): void => {
        const url = queue.shift();
        if (!url) return stop();
        a.src = url;
        // a rejected play() is the autoplay policy (or a newer announcement's pause): stay silent, the switch stays on
        a.play().catch(() => {
          if (ctl === c) stop();
        });
      };
      a.onended = next;
      a.onerror = stop;
      next();
    })
    // offline or aborted by a newer announcement: nothing to play, the next stop asks again
    .catch(() => {});
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** Reactive switch state (`.current`); write with setAnnouncer. */
export const announcer = external(subscribe, () => on);
