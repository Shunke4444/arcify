/**
 * Arcify floating rail.
 *
 * Why this exists: chrome.sidePanel cannot render below kMinSidePanelContentsWidth, which
 * is 320 device-independent pixels compiled into Chromium. No extension API, command line
 * flag or setting changes it. A content script owns no browser chrome, so it can be any
 * size - this is the only route to a narrower sidebar.
 *
 * Design: nothing is reserved. A thin strip along the left edge is the only thing present
 * until the pointer reaches it, at which point a floating panel slides out OVER the page.
 * The page is never displaced, because shifting body margin breaks position:fixed headers.
 *
 * Plain script, no imports, so the build copies it verbatim. All UI lives in a shadow root
 * so page stylesheets cannot reach it and it cannot leak into the page.
 *
 * KNOWN LIMIT: content scripts do not run on brave:// chrome:// the Web Store, the PDF
 * viewer, other extensions' pages, or the new tab page. There is no rail on any of those.
 * The 320px side panel remains available (Alt+S) and is the only option there.
 */

(() => {
    'use strict';

    // Bump on every behavioural change to this file.
    const RAIL_VERSION = 18;

    // Guard against double injection, but NOT against upgrades.
    //
    // The old guard was a bare boolean, so a page loaded before an extension reload kept
    // running whatever build it started with FOREVER: reloading the extension does not
    // touch content scripts already in a page, and re-injecting hit the guard and returned
    // immediately. That is why stale builds appeared to survive a reload.
    // A resident copy only counts if its extension context is still ALIVE. Reloading the
    // extension invalidates every already-injected script: its chrome.* calls start
    // throwing "Extension context invalidated", so the panel is still on screen and every
    // click silently does nothing. Version alone would let that corpse block its
    // replacement, which looks exactly like "no action is being rendered".
    const residentIsAlive = (() => {
        try {
            return typeof window.__arcifyRailAlive === 'function' && window.__arcifyRailAlive() === true;
        } catch (error) {
            return false;
        }
    })();

    if (residentIsAlive
        && typeof window.__arcifyRailVersion === 'number'
        && window.__arcifyRailVersion >= RAIL_VERSION) {
        return;
    }

    // An older build is resident. Shut it down as far as we can reach it - newer builds
    // expose a teardown, older ones only left their host element behind.
    if (typeof window.__arcifyRailTeardown === 'function') {
        try {
            window.__arcifyRailTeardown();
        } catch (error) {
            // Best effort.
        }
    }
    document.getElementById('arcify-rail-host')?.remove();

    window.__arcifyRailVersion = RAIL_VERSION;
    window.__arcifyRailLoaded = true;

    // Never render inside frames - one rail per tab, top document only.
    if (window.top !== window) return;

    const HOST_ID = 'arcify-rail-host';
    const HIDE_DELAY_MS = 70;
    // How long a freshly handed-over panel is immune from hiding.
    const HANDOVER_GRACE_MS = 700;
    // How close to the left edge the pointer must get to summon the panel.
    const EDGE_TRIGGER_PX = 6;
    // How far past the panel's right edge the pointer must go before it hides. Kept
    // small so leaving feels immediate rather than sticky.
    const HIDE_MARGIN_PX = 10;
    const MIN_WIDTH_PX = 160;
    const MAX_WIDTH_PX = 460;
    const DEFAULT_WIDTH_PX = 215;
    const WIDTH_STORAGE_KEY = 'railWidth';
    // Arcify's own palette from styles.css, not Chrome's tab-group colours - the point is
    // for the rail to look like the side panel it stands in for.
    const SPACE_COLORS = {
        grey: '#cccccc',
        blue: '#8bb3f3',
        red: '#ff9e97',
        yellow: '#ffe29f',
        green: '#8bda99',
        pink: '#fbaad7',
        purple: '#d6a6ff',
        cyan: '#a5e2ea',
        orange: '#ffc48b'
    };

    let state = { spaces: [], tabs: [], pinned: [] };
    let hideTimer = null;
    let pinned = false;
    let open = false;
    let refreshQueued = false;
    let width = DEFAULT_WIDTH_PX;
    let resizing = false;
    let pointerInside = false;
    // Browser zoom for this tab. Everything the rail measures is in the page's CSS pixels,
    // which zoom redefines - so it divides by this to keep a constant PHYSICAL size.
    let zoom = 1;
    // Last pointer position actually seen in this document, used to spot replays.
    let lastMoveX = null;
    let lastMoveY = null;
    let refreshPending = false;
    // Wall-clock deadline before which nothing may hide the panel. A handover arrives with
    // the pointer already over the panel but no mouseenter fired in this document, so
    // pointerInside is false and the very first stray mousemove would close it again.
    let holdOpenUntil = 0;

    // Everything bound outside the shadow root is registered with this signal, so a
    // teardown can remove the lot in one go. Listeners on the panel itself go with it.
    const abort = new AbortController();
    const listenerOpts = { signal: abort.signal };

    // ---------------------------------------------------------------- shadow root

    const host = document.createElement('div');
    host.id = HOST_ID;
    // The host itself must not intercept the page. Only its children opt back in.
    host.style.cssText = [
        'all: initial',
        'position: fixed',
        'top: 0',
        'left: 0',
        'width: 0',
        'height: 0',
        'z-index: 2147483646'
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
        <style>
            :host { all: initial; }

            .panel {
                position: fixed;
                top: 0;
                left: 0;
                width: var(--rail-width, 215px);
                /* Near full height, like Arc's sidebar - the width is what shrinks, not
                   the height. */
                height: 100vh;
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 12px 10px 10px;
                box-sizing: border-box;

                background: var(--space-bg, #cccccc);
                /* Flush against the window edge like Arc's sidebar - only the inner
                   corners are rounded. */
                border-radius: 0 14px 14px 0;
                box-shadow: 6px 0 32px rgba(0, 0, 0, 0.32);

                color: #333;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px;
                line-height: 1.3;

                /* Hidden by default: translated out AND non-interactive, so a hidden rail
                   can never swallow a click meant for the page. */
                transform: translateX(-100%);
                opacity: 0;
                pointer-events: none;
                /* Leaving: quick. */
                transition: transform 0.11s ease-in, opacity 0.09s ease-in, background-color 0.3s ease;
            }

            /* A handover opens a DIFFERENT document's panel. Sliding in each time made
               every tab switch look like the rail flying off-screen and back. */
            .panel.instant { transition: none !important; }

            .panel.open {
                transform: translateX(0);
                opacity: 1;
                pointer-events: auto;
                /* Arriving: a touch softer than leaving. */
                transition: transform 0.17s ease-out, opacity 0.14s ease-out, background-color 0.3s ease;
            }

            .header {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 0 2px;
            }

            .title {
                flex: 1;
                min-width: 0;
                font-size: 15px;
                font-weight: 600;
                opacity: 0.95;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .icon-btn {
                flex: none;
                width: 22px;
                height: 22px;
                display: flex;
                align-items: center;
                justify-content: center;
                border: none;
                border-radius: 6px;
                background: transparent;
                color: inherit;
                cursor: pointer;
                opacity: 0.55;
                font-size: 13px;
                line-height: 1;
                padding: 0;
            }

            .icon-btn:hover { background: rgba(255, 255, 255, 0.35); opacity: 1; }
            .icon-btn.active { opacity: 1; background: rgba(255, 255, 255, 0.55); }

            .spaces {
                flex: none;
                display: flex;
                gap: 6px;
                overflow-x: auto;
                scrollbar-width: none;
                padding: 2px;
            }
            .spaces::-webkit-scrollbar { display: none; }

            .space {
                flex: none;
                height: 26px;
                max-width: 104px;
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 0 10px;
                border: none;
                border-radius: 13px;
                background: rgba(255, 255, 255, 0.25);
                color: inherit;
                font: inherit;
                font-size: 12px;
                cursor: pointer;
                white-space: nowrap;
                overflow: hidden;
                transition: background-color 0.2s;
            }

            .space:hover { background: rgba(255, 255, 255, 0.45); }
            .space.active { background: #ffffff; font-weight: 600; }

            .dot {
                flex: none;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: var(--dot, #cccccc);
            }

            .space-name {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            /* --- drag handle on the right edge --- */
            .resizer {
                position: absolute;
                top: 0;
                right: -3px;
                width: 8px;
                height: 100%;
                cursor: col-resize;
                border-radius: 0 14px 14px 0;
            }

            .resizer:hover, .panel.resizing .resizer {
                background: rgba(0, 0, 0, 0.16);
            }

            /* While dragging, the pointer leaves the panel constantly - suppress the
               hover-out hide and the text selection the drag would otherwise cause. */
            .panel.resizing { user-select: none; }

            /* --- space colour picker --- */
            .swatches {
                display: none;
                flex-wrap: wrap;
                gap: 6px;
                padding: 6px 4px;
                flex: none;
            }

            .swatches.open { display: flex; }

            .swatch {
                flex: none;
                width: 20px;
                height: 20px;
                border-radius: 50%;
                border: 2px solid transparent;
                cursor: pointer;
                padding: 0;
                background: var(--swatch, #cccccc);
                transition: transform 0.15s ease;
            }

            .swatch:hover { transform: scale(1.12); }
            .swatch.selected { border-color: rgba(0, 0, 0, 0.45); }

            /* Mirrors .pinned-favicons in the side panel: a wrapping grid, not a strip. */
            .pinned {
                flex: none;
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                justify-content: space-between;
            }

            .pin-tab {
                flex: 1 1 24%;
                min-width: 0;
                height: 40px;
                display: flex;
                align-items: center;
                justify-content: center;
                border: none;
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.2);
                cursor: pointer;
                padding: 0;
                transition: background-color 0.2s;
            }

            .pin-tab:hover { background: rgba(0, 0, 0, 0.10); }
            .pin-tab.active { background: #ECEFF1; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); }

            .pin-tab .favicon, .pin-tab .fallback-icon {
                width: 20px;
                height: 20px;
            }

            .divider {
                flex: none;
                height: 1px;
                background: rgba(0, 0, 0, 0.10);
                margin: 0 4px;
            }

            /* The part that grows, so the panel fills its height. */
            .tabs {
                flex: 1 1 auto;
                min-height: 0;
                display: flex;
                flex-direction: column;
                gap: 4px;
                overflow-y: auto;
                scrollbar-width: none;
            }
            .tabs::-webkit-scrollbar { display: none; }

            .tab {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 4px 10px;
                min-height: 30px;
                border-radius: 12px;
                cursor: pointer;
                transition: background-color 0.2s;
            }

            .tab:hover { background: rgba(0, 0, 0, 0.10); }
            .tab.active { background: #ECEFF1; }

            .favicon, .fallback-icon {
                flex: none;
                width: 16px;
                height: 16px;
                border-radius: 3px;
                object-fit: contain;
            }

            .fallback-icon { background: rgba(0, 0, 0, 0.18); }

            .tab-title {
                flex: 1;
                min-width: 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .close {
                flex: none;
                width: 20px;
                height: 20px;
                display: flex;
                align-items: center;
                justify-content: center;
                border: none;
                border-radius: 5px;
                background: transparent;
                color: inherit;
                cursor: pointer;
                opacity: 0;
                font-size: 14px;
                line-height: 1;
                padding: 0;
            }

            .tab:hover .close { opacity: 0.6; }
            .close:hover { opacity: 1; background: rgba(0, 0, 0, 0.12); }

            .new-tab {
                flex: none;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                height: 38px;
                border: none;
                border-radius: 12px;
                background: rgba(255, 255, 255, 0.25);
                color: inherit;
                font: inherit;
                font-size: 13px;
                font-weight: 500;
                cursor: pointer;
                transition: background-color 0.2s;
            }

            .new-tab:hover { background: rgba(255, 255, 255, 0.45); }

            .empty {
                padding: 10px 4px;
                opacity: 0.5;
                font-size: 12px;
            }

        </style>

        <div class="panel">
            <div class="pinned"></div>
            <div class="header">
                <span class="title">Arcify</span>
                <button class="icon-btn palette" title="Space colour">&#9679;</button>
                <button class="icon-btn pin" title="Keep open">&#9678;</button>
            </div>
            <div class="swatches"></div>
            <div class="divider"></div>
            <div class="tabs"></div>
            <button class="new-tab">+ New Tab</button>
            <div class="spaces"></div>
            <div class="resizer" title="Drag to resize"></div>
        </div>
    `;

    const panel = shadow.querySelector('.panel');
    const spacesEl = shadow.querySelector('.spaces');
    const pinnedEl = shadow.querySelector('.pinned');
    const tabsEl = shadow.querySelector('.tabs');
    const titleEl = shadow.querySelector('.title');
    const pinBtn = shadow.querySelector('.pin');
    const newTabBtn = shadow.querySelector('.new-tab');
    const paletteBtn = shadow.querySelector('.palette');
    const swatchesEl = shadow.querySelector('.swatches');
    const resizer = shadow.querySelector('.resizer');

    // ---------------------------------------------------------------- width

    // `width` is stored unzoomed, so every tab agrees on it regardless of its own zoom.
    function applyWidth(next) {
        width = Math.round(Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, next)));
        panel.style.setProperty('--rail-width', `${width / zoom}px`);
    }

    function setZoom(next) {
        if (typeof next !== 'number' || !(next > 0) || next === zoom) return;
        zoom = next;
        applyWidth(width);
    }

    // Width is per browser profile, not per tab - every rail in every tab should agree.
    async function loadWidth() {
        try {
            const stored = await chrome.storage.local.get(WIDTH_STORAGE_KEY);
            if (stored && typeof stored[WIDTH_STORAGE_KEY] === 'number') {
                applyWidth(stored[WIDTH_STORAGE_KEY]);
                return;
            }
        } catch (error) {
            // Storage unavailable; the default is fine.
        }
        applyWidth(DEFAULT_WIDTH_PX);
    }

    function saveWidth() {
        chrome.storage.local.set({ [WIDTH_STORAGE_KEY]: width }).catch(() => { });
    }

    // Rails in other tabs pick the new width up without needing a reload.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[WIDTH_STORAGE_KEY]) return;
        const next = changes[WIDTH_STORAGE_KEY].newValue;
        if (typeof next === 'number' && next !== width) applyWidth(next);
    });

    resizer.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        resizing = true;
        panel.classList.add('resizing');
        resizer.setPointerCapture(event.pointerId);
    });

    resizer.addEventListener('pointermove', (event) => {
        if (!resizing) return;
        // The panel is flush to the edge, so its width is simply the pointer position.
        // clientX is in the page's zoomed pixels; store the unzoomed width.
        applyWidth(event.clientX * zoom);
    });

    function endResize(event) {
        if (!resizing) return;
        resizing = false;
        panel.classList.remove('resizing');
        try {
            resizer.releasePointerCapture(event.pointerId);
        } catch (error) {
            // Capture already gone.
        }
        saveWidth();
    }

    resizer.addEventListener('pointerup', endResize);
    resizer.addEventListener('pointercancel', endResize);

    // ---------------------------------------------------------------- messaging

    let orphaned = false;

    // Reloading the extension invalidates this script's context. It keeps running - its
    // listeners still fire, its panel is still on screen - but every chrome.* call throws
    // and nothing it does can ever work again. Left alone it sits there reacting to the
    // mouse and failing, which is indistinguishable from a broken rail.
    function selfDestruct(reason) {
        if (orphaned) return;
        orphaned = true;
        console.warn(`[ArcifyRail] orphaned (${reason}); removing this copy`);
        try {
            clearTimeout(hideTimer);
            abort.abort();
            host.remove();
        } catch (error) {
            // Nothing left to clean up.
        }
    }

    async function send(action, extra = {}) {
        if (orphaned) return null;

        try {
            const response = await chrome.runtime.sendMessage({ action, ...extra });
            return response;
        } catch (error) {
            const message = String(error && error.message);
            if (message.includes('Extension context invalidated') || !chrome.runtime?.id) {
                selfDestruct(message);
                return null;
            }
            // Worker asleep mid-send, or no receiver. Recoverable; keep going.
            console.warn('[ArcifyRail] send failed:', action, extra, error);
            return null;
        }
    }

    async function refresh() {
        const response = await send('railGetState');
        if (!response || response.success === false) return;

        state = {
            spaces: response.spaces || [],
            tabs: response.tabs || [],
            pinned: response.pinned || []
        };
        render();
    }

    // Only fetch while visible; a background tab's rail does not need to stay current.
    function queueRefresh() {
        if (!open) return;

        // Never rebuild the list while the pointer is inside the panel.
        //
        // render() replaces every row, and a click only fires when mousedown and mouseup
        // land on the SAME element. Background tab churn - a title or favicon updating,
        // which busy pages do constantly - was destroying the row mid-click, so clicks
        // simply never completed. Defer until the pointer leaves.
        if (pointerInside) {
            refreshPending = true;
            return;
        }

        if (refreshQueued) return;
        refreshQueued = true;
        requestAnimationFrame(() => {
            refreshQueued = false;
            refresh();
        });
    }

    // Refresh even though the pointer is inside: used right after an action the user just
    // took, where redrawing is the expected outcome rather than an interruption.
    function forceRefresh() {
        refreshPending = false;
        refresh();
    }

    // ---------------------------------------------------------------- rendering

    // Resolve icons through the extension's own /_favicon/ endpoint rather than the tab's
    // favIconUrl. The rail renders inside the page, so using a tab's real icon URL would
    // make THIS page fetch it - and for a localhost dev tab that is a local-network request
    // from a public site, which Brave prompts about and which leaks what you have open.
    function faviconUrlFor(tab) {
        if (!tab.url) return null;
        try {
            const url = new URL(chrome.runtime.getURL('/_favicon/'));
            url.searchParams.set('pageUrl', tab.url);
            url.searchParams.set('size', '32');
            return url.toString();
        } catch (error) {
            return null;
        }
    }

    function faviconFor(tab) {
        const src = faviconUrlFor(tab);
        if (src) {
            const img = document.createElement('img');
            img.className = 'favicon';
            img.src = src;
            img.alt = '';
            img.addEventListener('error', () => {
                const stub = document.createElement('span');
                stub.className = 'fallback-icon';
                img.replaceWith(stub);
            });
            return img;
        }
        const stub = document.createElement('span');
        stub.className = 'fallback-icon';
        return stub;
    }

    function render() {
        const activeSpace = state.spaces.find(space => space.active);
        titleEl.textContent = activeSpace ? activeSpace.name : 'Arcify';

        // The whole panel takes the active space's colour, the way the side panel does.
        panel.style.setProperty(
            '--space-bg',
            SPACE_COLORS[activeSpace && activeSpace.color] || SPACE_COLORS.grey
        );

        // --- spaces ---
        spacesEl.replaceChildren();
        let activeChip = null;
        for (const space of state.spaces) {
            const btn = document.createElement('button');
            btn.className = 'space' + (space.active ? ' active' : '');
            btn.title = space.name;

            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.style.setProperty('--dot', SPACE_COLORS[space.color] || SPACE_COLORS.grey);

            const label = document.createElement('span');
            label.className = 'space-name';
            label.textContent = space.name;

            btn.append(dot, label);
            btn.dataset.spaceId = String(space.id);
            if (space.active) activeChip = btn;
            spacesEl.appendChild(btn);
        }

        if (swatchesEl.classList.contains('open')) renderSwatches();

        // The row scrolls horizontally, so with more spaces than fit at 200px the active
        // one was simply off the end - visible as a clipped chip showing only its dot.
        if (activeChip) {
            requestAnimationFrame(() => {
                activeChip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            });
        }

        // --- browser-pinned tabs ---
        pinnedEl.replaceChildren();
        for (const tab of state.pinned) {
            const btn = document.createElement('button');
            btn.className = 'pin-tab' + (tab.active ? ' active' : '');
            btn.title = tab.title;
            btn.dataset.tabId = String(tab.id);
            btn.appendChild(faviconFor(tab));
            pinnedEl.appendChild(btn);
        }

        // --- tabs in the active space ---
        tabsEl.replaceChildren();
        if (state.tabs.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = 'No tabs in this space';
            tabsEl.appendChild(empty);
        }

        for (const tab of state.tabs) {
            const row = document.createElement('div');
            row.className = 'tab' + (tab.active ? ' active' : '');
            row.title = tab.title;
            row.dataset.tabId = String(tab.id);

            const label = document.createElement('span');
            label.className = 'tab-title';
            label.textContent = tab.title;

            const close = document.createElement('button');
            close.className = 'close';
            close.textContent = '×';
            close.title = 'Close tab';
            close.dataset.action = 'close';

            row.append(faviconFor(tab), label, close);
            tabsEl.appendChild(row);
        }
    }

    // ---------------------------------------------------------------- space colour

    function renderSwatches() {
        const activeSpace = state.spaces.find(space => space.active);
        swatchesEl.replaceChildren();
        if (!activeSpace) return;

        for (const [name, hex] of Object.entries(SPACE_COLORS)) {
            const swatch = document.createElement('button');
            swatch.className = 'swatch' + (activeSpace.color === name ? ' selected' : '');
            swatch.title = name;
            swatch.style.setProperty('--swatch', hex);
            swatch.addEventListener('click', async () => {
                await send('railSetSpaceColor', { spaceId: activeSpace.id, color: name });
                swatchesEl.classList.remove('open');
                paletteBtn.classList.remove('active');
                // forceRefresh, not queueRefresh: your pointer is necessarily inside the
                // panel when you click a swatch, and queueRefresh defers while it is - so
                // the rail kept its old colour while the side panel repainted at once.
                forceRefresh();
            });
            swatchesEl.appendChild(swatch);
        }
    }

    paletteBtn.addEventListener('click', () => {
        const opening = !swatchesEl.classList.contains('open');
        swatchesEl.classList.toggle('open', opening);
        paletteBtn.classList.toggle('active', opening);
        if (opening) renderSwatches();
    });

    // ---------------------------------------------------------------- visibility

    function show() {
        clearTimeout(hideTimer);
        if (!open) {
            open = true;
            panel.classList.add('open');
            // Tell the service worker this window wants a rail, so switching tabs by any
            // means re-opens it in the tab being switched to.
            send('railOpened');
        }
        refresh();
    }

    // closeReason 'user' means the person actually dismissed it. Anything else is this
    // document going away underneath the panel, which must NOT be reported as a close.
    function hideNow(closeReason = 'user') {
        open = false;
        panel.classList.remove('open');
        panel.classList.remove('instant');
        swatchesEl.classList.remove('open');
        paletteBtn.classList.remove('active');

        if (closeReason === 'user') {
            send('railClosed');
        }
    }

    function scheduleHide() {
        // Dragging the edge drags the pointer outside the panel constantly.
        if (pinned || resizing) return;

        // Just handed over from another tab; give the pointer a moment to be counted.
        if (Date.now() < holdOpenUntil) return;

        // Switching tab fires mouseleave on the panel in the tab being LEFT, because the
        // document is hidden while the pointer is still over it. Acting on that queued a
        // close that then told the service worker this window no longer wants a rail -
        // wiping the flag the handover depends on, so the NEXT switch had nothing to
        // reopen. A hidden document has no business hiding anything.
        if (document.visibilityState !== 'visible') return;

        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => hideNow('user'), HIDE_DELAY_MS);
    }

    // Edge detection by pointer position rather than a hit-testing element. A fixed strip
    // over the left edge would swallow every click landing in that band - links, sidebars,
    // scrollbars on RTL pages. This intercepts nothing.
    window.addEventListener('mousemove', (event) => {
        // A mousemove that does not move is not information.
        //
        // Activating a tab makes Chrome replay the pointer's last known position into the
        // newly visible document as a synthetic mousemove. Those coordinates are stale -
        // they are from before the tab was switched - and acting on them closed a panel
        // that had just been handed over, because the old position was outside it. A
        // genuine move always reports a different coordinate; a replay never does.
        if (event.clientX === lastMoveX && event.clientY === lastMoveY) return;
        lastMoveX = event.clientX;
        lastMoveY = event.clientY;

        if (event.clientX <= EDGE_TRIGGER_PX / zoom) {
            // The edge is inside the panel whenever it is open, so nothing here may hide
            // it. This used to only call show(), which clears the hide timer - but show()
            // is skipped when the panel is ALREADY open, so a hide armed by a flick to the
            // right survived the pointer coming straight back and closed the panel with
            // the pointer sitting on the very edge. That was the flicker.
            clearTimeout(hideTimer);
            pointerInside = true;
            if (!open) show();
            return;
        }
        // Moving away from the edge while the panel is closed: nothing to do. While open,
        // the panel's own mouseleave handles it.
        if (!open || pinned || resizing) return;

        const inside = pointerIsOverPanel(event.clientX);

        // Leaving the panel releases any refresh that was held back while inside it.
        if (pointerInside && !inside && refreshPending) {
            refreshPending = false;
            queueRefresh();
        }
        pointerInside = inside;

        if (inside) {
            clearTimeout(hideTimer);
            return;
        }

        // Left during the handover grace. Not now - but not never either: if the pointer
        // settles out there, the panel still has to go once the grace is over. Dropping
        // the event left it open until the mouse happened to move again.
        if (Date.now() < holdOpenUntil) {
            clearTimeout(hideTimer);
            hideTimer = setTimeout(() => {
                if (!pointerInside) scheduleHide();
            }, holdOpenUntil - Date.now() + 1);
            return;
        }

        scheduleHide();
    }, { passive: true, signal: abort.signal });

    // Delegated on the PANEL, which is never replaced.
    //
    // Per-row listeners died with their rows: render() rebuilds the list with
    // replaceChildren, and a page like Gmail emits tab updates constantly, so the row under
    // the pointer could be swapped between being drawn and being pressed. Nothing was
    // listening on the element that actually got the press - hence presses that produced no
    // log line at all. Delegation survives any number of re-renders.
    panel.addEventListener('pointerdown', async (event) => {
        if (event.button !== 0) return;

        const path = event.composedPath();
        const hit = (selector) => path.find(
            node => node instanceof Element && node.matches && node.matches(selector)
        );

        const closeBtn = hit('[data-action="close"]');
        if (closeBtn) {
            const row = hit('.tab');
            event.preventDefault();
            event.stopPropagation();
            console.log('[ArcifyRail] close tab', row?.dataset.tabId);
            await send('railCloseTab', { tabId: Number(row.dataset.tabId) });
            forceRefresh();
            return;
        }

        const tabEl = hit('.tab[data-tab-id]') || hit('.pin-tab[data-tab-id]');
        if (tabEl) {
            event.preventDefault();
            console.log('[ArcifyRail] activate tab', tabEl.dataset.tabId);
            send('railActivateTab', { tabId: Number(tabEl.dataset.tabId) });
            return;
        }

        const spaceEl = hit('.space[data-space-id]');
        if (spaceEl) {
            event.preventDefault();
            console.log('[ArcifyRail] switch space', spaceEl.dataset.spaceId);
            await send('railSwitchSpace', { spaceId: Number(spaceEl.dataset.spaceId) });
            forceRefresh();
            return;
        }
    });

    // Deliberately NOT mouseenter/mouseleave.
    //
    // Those fire as boundary events, and replacing the rows under the pointer - which
    // render() does on every refresh - makes the browser emit them even though the pointer
    // never moved. That is why the panel hid while the pointer was sitting at the far left,
    // well inside it. Pointer position against the panel's own edge cannot lie.
    function pointerIsOverPanel(clientX) {
        // The panel is flush to the left and full height, so X alone decides it.
        return clientX <= (width + HIDE_MARGIN_PX) / zoom;
    }

    // Leaving this tab: drop the panel silently, so returning to it is a clean re-open
    // and the window-level open flag is left alone.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') return;
        clearTimeout(hideTimer);
        if (open) hideNow('document-hidden');
    }, listenerOpts);

    // Never sit on top of fullscreen video.
    document.addEventListener('fullscreenchange', () => {
        const isFullscreen = Boolean(document.fullscreenElement);
        host.style.display = isFullscreen ? 'none' : '';
        if (isFullscreen) {
            clearTimeout(hideTimer);
            hideNow('user');
        }
    }, listenerOpts);

    // Ctrl+S toggle.
    //
    // Bound here rather than in manifest commands for two reasons: the manifest is already
    // at Chrome's hard limit of four suggested_key entries, and unlike Ctrl+T the browser's
    // Ctrl+S (Save page) IS cancelable from a page, so preventDefault actually holds.
    function toggleRail() {
        if (open) {
            pinned = false;
            pinBtn.classList.remove('active');
            clearTimeout(hideTimer);
            hideNow('user');
            return;
        }

        // Opened by keyboard, so there is no pointer to keep it alive - pin it, otherwise
        // it would vanish the moment the mouse moved.
        pinned = true;
        pinBtn.classList.add('active');
        pinBtn.title = 'Unpin';
        show();
    }

    window.addEventListener('keydown', (event) => {
        if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
        if (event.key !== 's' && event.key !== 'S') return;

        event.preventDefault();
        event.stopPropagation();
        toggleRail();
    }, { capture: true, signal: abort.signal });

    pinBtn.addEventListener('click', () => {
        pinned = !pinned;
        pinBtn.classList.toggle('active', pinned);
        pinBtn.title = pinned ? 'Unpin' : 'Keep open';
        if (!pinned) scheduleHide();
    });

    newTabBtn.addEventListener('click', async () => {
        await send('railNewTab');
        // Same reasoning as the swatches: the click came from inside the panel.
        forceRefresh();
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message) return;

        if (message.action === 'railStateChanged') {
            queueRefresh();
            return;
        }

        // The rail in the tab we just came FROM was clicked. Clicking a tab moves the user
        // to this document, and the panel would otherwise look like it closed - it was
        // simply left behind in the other tab. Open here instead.
        //
        // Not pinned: the point is that it survives the action, not that it stays forever.
        // The next mousemove away from the panel hides it, exactly like a hover-open.
        if (message.action === 'railZoomChanged') {
            setZoom(message.zoom);
            return;
        }

        if (message.action === 'railOpenImmediately') {
            openInPlace();
            sendResponse({ success: true });
            return true;
        }
    });

    // Open without the slide-in, and hold it open long enough for the pointer to be
    // counted. Used by a handover from another tab and by the arrival check below.
    function openInPlace() {
        panel.classList.add('instant');
        holdOpenUntil = Date.now() + HANDOVER_GRACE_MS;
        clearTimeout(hideTimer);
        show();
        requestAnimationFrame(() => {
            requestAnimationFrame(() => panel.classList.remove('instant'));
        });
        // The pointer may already be sitting over the panel, but no mousemove has fired in
        // this document yet, so nothing would keep it alive. Leave no hide timer armed.
        clearTimeout(hideTimer);
    }

    // Ask, rather than wait to be told.
    //
    // handOverRail pushes railOpenImmediately at the destination tab, but clicking a row
    // for a tab that is loading destroys the old document and the replacement does not run
    // this script until later - so the push arrives when no listener exists, burns its
    // retries, and the freshly attached rail sits closed while the page finishes loading.
    // The window already knows whether it wants a rail; asking on arrival cannot race.
    async function openIfWindowWantsRail() {
        const response = await send('railShouldBeOpen');
        if (response && response.open && !open) openInPlace();
    }

    // At document_start the page has not built its DOM yet, and some pages replace
    // documentElement outright (document.write, framework bootstraps), which would take the
    // host with it. Put it back if that happens.
    function ensureAttached() {
        if (orphaned) return;
        if (!host.isConnected) document.documentElement.appendChild(host);
    }

    document.addEventListener('DOMContentLoaded', ensureAttached, listenerOpts);
    window.addEventListener('load', ensureAttached, listenerOpts);

    // Let a future build retire this one properly rather than just orphaning its DOM.
    window.__arcifyRailTeardown = () => {
        clearTimeout(hideTimer);
        abort.abort();
        host.remove();
    };

    // Lets a later injection tell a live copy from an invalidated one.
    window.__arcifyRailAlive = () => {
        try {
            return Boolean(chrome.runtime && chrome.runtime.id);
        } catch (error) {
            return false;
        }
    };

    // Diagnostics. Closure state is invisible from the page and from DevTools' page
    // context; select the extension's context in the console and call this.
    window.__arcifyRailDebug = () => ({
        version: RAIL_VERSION,
        open,
        pinned,
        resizing,
        pointerInside,
        refreshPending,
        orphaned,
        holdRemainingMs: Math.max(0, holdOpenUntil - Date.now()),
        hideTimerSet: hideTimer !== null,
        width,
        visibility: document.visibilityState
    });

    console.log(`[ArcifyRail] v${RAIL_VERSION} attached`);

    // documentElement, not body: body may not exist yet and may be replaced by the page.
    document.documentElement.appendChild(host);

    loadWidth();
    openIfWindowWantsRail();
    send('railGetZoom').then(response => setZoom(response && response.zoom));
})();
