# The floating rail — state of play

Handoff notes. Read this before touching `rail/rail.js` or the `rail*` handlers in
`background.js`. Current: `RAIL_VERSION 19`, 17 end-to-end scenarios green.

## What it is and why

`chrome.sidePanel` cannot render narrower than its compiled floor. That floor is
`kSidePanelDefaultContentWidth = 360` in `chrome/browser/ui/side_panel/side_panel_entry.h`
in current Chromium — it replaced the older `kMinSidePanelContentsWidth = 320`, so it went
*up*. `SidePanelEntry::GetDefaultContentWidth()` accepts a per-entry width only when it is
`>= kSidePanelDefaultContentWidth`, so that API can make panels wider and never narrower.
No flag, policy or extension API changes it. Three crbugs have asked (40926440, 40943583,
378404989) and the code says the answer was no.

So the rail is a **content script**: it owns no browser chrome, so it can be any width.
That is the only route to a narrower sidebar from inside an extension, and every quirk
below follows from it.

### The rule that matters

**The rail must PULL its state, never rely on being pushed.**

A content script cannot be messaged before it exists. Clicking a row for a loading tab
destroys the old document, and the replacement runs its script later — so a pushed
`railOpenImmediately` arrives with no listener and burns its retries in under a second.
The rail asks `railShouldBeOpen` as it attaches instead. A question cannot lose that race.
Any new cross-tab behaviour needs the same treatment.

### Permanent limits — do not spend time here

- **No rail on `brave://`, `chrome://`, the Web Store, other extensions' pages, or PDFs.**
  No extension can run any script there. `Alt+S` opens the side panel on those pages
  instead, which is the only surface that works. This is the sandbox boundary, not a bug.
- **DevTools device emulation distorts the rail**, because it is laid out inside the
  emulated viewport. Browser *zoom* is compensated (below); emulation is not, and is not
  worth chasing.

## Build and verify

```
npm run build:dev          # one-shot dev build -> dist-dev   (what Brave loads)
npm run build              # production build   -> dist
npm run test:rail          # 17 scenarios against dist-dev
npm run test:rail -- dist
```

Brave loads the unpacked extension from **`dist-dev`** (confirmed in its Secure
Preferences). `dist-dev` is a vite bundle — never copy raw `background.js` over it.

Use `npm run dev` only when you actually want a file watcher. It never exits, and killing
it mid-rebuild leaves `dist-dev` empty (`emptyOutDir` wipes before writing), which the
browser reports as *"Manifest file is missing or unreadable"*. That is what `build:dev` is
for.

`npm run test:rail` drives real input in a headed Chrome: hovering the edge, clicking rows,
dragging the pointer away, Ctrl+S, tab switches, and an extension reload with pages still
open. Add a scenario for anything you fix.

## Fixed — do not reintroduce

Each of these has a scenario in the suite.

1. **`host_permissions` is required for `chrome.scripting.executeScript`.**
   `content_scripts.matches` does not grant it. Without it every re-injection threw into a
   catch, so after reloading the extension a tab had no rail until reloaded by hand.
2. **Pull, not push** (`railShouldBeOpen`) — see the rule above.
3. **`run_at: document_start`**, plus a re-attach guard on DOMContentLoaded/load for pages
   that replace `documentElement`. At `document_idle` the rail did not exist until the page
   finished loading — 4s on a slow page.
4. **Pinned tabs need `url` in `getRailState`.** `faviconUrlFor` resolves through
   `/_favicon/` and returns null without one, so every pinned tab fell back to a grey square
   that read as a spinner that never finished.
5. **User actions must call `forceRefresh()`, never `queueRefresh()`.** Refreshes are
   deliberately deferred while the pointer is inside the panel (it stops rows being
   destroyed mid-click). Your pointer is *necessarily* inside when you click a swatch, so
   the colour change repainted the side panel and not the rail.
6. **Hovering the edge must cancel a pending hide.** `show()` clears the timer but is
   skipped when the panel is already open, so a flick right and back closed the panel with
   the pointer resting on the edge.
7. **Chrome replays the pointer's last position into a newly activated tab** as a synthetic
   mousemove. The coordinates are stale and closed panels that had just been handed over.
   The rail ignores a move whose coordinates are identical to the previous one — a replay
   never differs, a real move always does.
8. **Zoom compensation.** A content script is measured in the page's CSS pixels, which zoom
   redefines: 215px was 322 physical px at 150%, wider than the panel it exists to undercut.
   `width` is stored unzoomed and divided by the tab's zoom, reported by `railGetZoom` and
   kept current via `chrome.tabs.onZoomChange`. Verified constant at 215 physical px.
9. **The newtab override includes `rail/rail.js` via a `<script>` tag.** Content scripts
   never run on `chrome-extension://` pages, not even our own.
10. **`Alt+S` (`toggleRail` command).** Two traps: `chrome.sidePanel.open()` needs a user
    gesture and **that gesture does not survive an `await`** in an MV3 service worker, so
    nothing may be awaited before it — use the tab that `chrome.commands.onCommand` hands
    you. And routing must ask whether a page *can host a rail*, not whether a content script
    would be injected, or the newtab page is sent to the fallback.

## Open work

### 1. Tab switching still flashes an empty panel — PRIORITY

Measured on a handover, sampling the destination every 10ms from the click:

```
+26ms  open=true  rows=0  active=null      space="Arcify"   <- visible, empty
+49ms  open=true  rows=3  active="Page B"  space="Work"     <- correct
```

**23ms of visible empty content on every tab switch.** That is the "page reloading" feel
the user reports. The side panel never does this because it is one document that already
holds the state; the rail is a different document per tab, so it opens and *then* fetches.

Root cause: `handOverRail` sends `railOpenImmediately` with no payload, and the destination
calls `show()` → `refresh()`, an async round trip to the service worker, before it can
render anything.

Suggested fix, in order of value:

- **Carry the state in the handover.** `handOverRail` already knows the window; have it call
  `getRailState(windowId)` once and put the result in the message. The destination renders
  synchronously before it paints. This alone should close the window to about zero.
- **Seed a cold attach.** A rail attaching on a page that never had one still round-trips.
  Have the background keep the last state per window in `chrome.storage.session` and let
  `openIfWindowWantsRail` return it alongside the answer, so the first render needs no fetch.
- Acceptance: extend the measurement above into the suite and assert that no sample is ever
  `open=true` with `rows=0`. The harness is `scripts/rail-e2e.cjs`; the throwaway measuring
  script is described in this section and is trivial to rebuild.

There is a related cosmetic case: a handed-over panel briefly shows the previous tab's row
highlighted until the state lands. The same fix removes it.

### 2. Drag a tab into the pinned grid at the top

The top grid is **Chrome-pinned tabs** — `chrome.tabs.query({ pinned: true })` — in *both*
surfaces. Verified: `updatePinnedFavicons()` at `sidebar.js:256` and the `pinned` array in
`getRailState` agree on the data source. The rail currently renders them read-only as
`.pin-tab` buttons; the side panel makes them a drag-and-drop target.

Reference implementation to mirror:

- `sidebar.js:256` `updatePinnedFavicons()` — builds the grid
- `sidebar.js:300-380` — `dragstart` on favicons, `dragover`/`dragleave`/`drop` on the
  container, with drop indicators
- `sidebar.js:1222` `calculatePinnedTabIndex()` — where the drop lands

**Gotcha that will bite you: pinning a tab removes it from its tab group**, and unpinning
does not put it back. Since spaces *are* tab groups, dragging a tab to the pinned grid takes
it out of its space. The grid is global across spaces, so that is arguably correct — but
decide it deliberately and tell the user, rather than discovering it in testing.

Do not confuse this with the **per-space bookmark pins** (`moveTabToPinned` at
`sidebar.js:1433`), a different feature backed by `chrome.bookmarks` that appears *inside*
a space, not in the top grid.

Note the rail delegates all clicks from one `pointerdown` handler on the panel, because
`render()` replaces every row and per-row listeners died with their rows. Drag handlers will
need the same treatment or an equivalent guard.

## Traps that cost real time

- **Check which build Brave has loaded and its `RAIL_VERSION`** before diagnosing anything.
  Several hours went to debugging a stale build.
- **Puppeteer needs `defaultViewport: null`.** Its default 800x600 emulation silently drops
  mouse events dispatched outside it, so "move the pointer to x=800" never arrives and the
  panel looks stuck open. This produced three separate false failures.
- **`chrome.sidePanel.open()` cannot be tested headlessly.** It needs real browser-level
  activation; CDP's synthetic gesture is refused. The routing is tested; the fallback itself
  needs a human.
- **After `chrome.runtime.reload()`, wait for a *new* service worker target.** The old one
  lingers and hands you a dead worker.
- **Reloading the extension opens the onboarding tab** — `onInstalled(update)`, upstream
  behaviour, not a bug. Close it in tests.
- **Rows do not rebuild while the pointer is inside the panel.** Expected, not a hang.
- **Brave preserves user-customised keyboard shortcuts** over manifest changes. If a
  `suggested_key` change appears not to take effect, check `brave://extensions/shortcuts`.

## If the browser question comes up again

It was researched. Vivaldi ships workspaces, two-level tab stacks, a vertical tab bar that
narrows to favicon width, and supported UI CSS — so this extension would be *deleted*, not
ported. But `chrome.tabGroups` has no Vivaldi backing (their own developer called wiring it
up "a bigger task", June 2026) and `chrome.tabs.group()` has crashed the browser there;
spaces *are* tab groups, so there is nothing to port onto. Claude in Chrome is also broken
on Vivaldi (blank side panel, VB-120826, open since Aug 2025), and Brave Shields is a native
Rust engine that MV3 never touched. The conclusion was to stay on Brave.
