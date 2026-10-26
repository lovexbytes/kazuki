// Account
// =======
// The account page (Html.account_html), drawn anew each time it is shown
// and after each act on it.

import * as View from "../../src/view/view.ts";
import { post } from "../../src/view/link.ts";
import * as Html from "./html.ts";
import { $, draw, P } from "./main.ts";


// shows the page at path: the chat ("/") or the account
export function go(path: string): void {
  if (location.pathname !== path) {
    history.pushState(null, "", path);
  }
  route();
}

// the account page keeps of the footer only its toasts (style.css)
export function route(): void {
  const page = location.pathname === "/account";
  $("#log").hidden = page;
  document.body.classList.toggle("account", page);
  $("#account").hidden = !page;
  P.shown = location.pathname;
  if (page) {
    account();
  }
  draw(false);
}

async function account(): Promise<void> {
  const el = $("#account");
  const res = await fetch("/api/account").catch(() => null);
  const a: View.Account | null = res !== null && res.ok ? await res.json() : null;
  if (a === null) {
    el.innerHTML = `<p class="sub">Could not read your account. Try again in a moment.</p>`;
    return;
  }
  el.innerHTML = Html.account_html(a);
  const kill = $<HTMLFormElement>("#account .kill");
  const del  = $<HTMLButtonElement>("#account .del");
  const name = kill.querySelector("input")!;
  const sure = (open: boolean) => {
    kill.hidden = !open;
    del.hidden = open;
  };
  del.onclick = () => {
    sure(true);
    name.focus();
  };
  $("#account .keep").onclick = () => sure(false);
  name.oninput = () => (kill.querySelector<HTMLButtonElement>(".red")!.disabled = name.value.trim().toLowerCase() !== a.name.toLowerCase());
  kill.onsubmit = (ev) => {
    ev.preventDefault();
    account_delete(kill);
  };
}

// the server deletes it all, once the account's name is typed
async function account_delete(kill: HTMLFormElement): Promise<void> {
  const name = kill.querySelector("input")!.value;
  const out = await post("/api/delete", { confirm: name });
  if (out.ok) {
    location.href = "/?deleted";
    return;
  }
  kill.querySelector(".why")!.textContent = out.error().message;
}
