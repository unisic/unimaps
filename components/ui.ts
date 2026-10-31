/* Chips: one height, one radius. "On" uses the same accent as a pressed IconButton. */
export const CHIP = "tap inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full text-[12px] font-medium";
export const CHIP_ON = "bg-primary-dim text-primary";
export const CHIP_OFF = "bg-tint/6 text-text-mute hover:bg-tint/10 hover:text-text";
export const chip = (on: boolean) => `${CHIP} px-3 ${on ? CHIP_ON : CHIP_OFF}`;
