import { mount, type Component } from "svelte";

import PwaRegister from "@/components/PwaRegister.svelte";

/** Mounts a page: `App` replaces the static markup in #app (the splash), the update toast goes to <body>. */
export function boot(App?: Component): void {
  if (App) {
    const target = document.getElementById("app")!;
    target.textContent = "";
    mount(App, { target });
  }
  mount(PwaRegister, { target: document.body });
}
