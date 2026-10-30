/** A GZM pole's name without its post number: "Pszczelnik Park 02", "... Pętla Zach. 1t", "Katowice Sądowa 1A".
 *  Isomorphic: the router groups a stop's poles by it, the connection search lists each stop once by it. */
export function gzmStopKey(name: string): string {
  return name.replace(/\s\d{1,2}[a-z]?$/i, "");
}
