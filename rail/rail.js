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

    // Guard against double injection (SPA navigations, re-injection after an update).
    if (window.__arcifyRailLoaded) return;
    window.__arcifyRailLoaded = true;

    // Never render inside frames - one rail per tab, top document only.
    if (window.top !== window) return;

    const HOST_ID = 'arcify-rail-host';
    const HIDE_DELAY_MS = 260;
    // How close to the left edge the pointer must get to summon the panel.
    const EDGE_TRIGGER_PX = 6;
    // How far past the panel's right edge the pointer must go before it hides.
    const HIDE_MARGIN_PX = 36;
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
                top: 8px;
                left: 8px;
                width: var(--rail-width, 215px);
                /* Near full height, like Arc's sidebar - the width is what shrinks, not
                   the height. */
                height: calc(100vh - 16px);
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 12px 8px 10px;
                box-sizing: border-box;

                background: var(--space-bg, #cccccc);
                border-radius: 14px;
                box-shadow: 0 14px 44px rgba(0, 0, 0, 0.38);

                color: #333;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px;
                line-height: 1.3;

                /* Hidden by default: translated out AND non-interactive, so a hidden rail
                   can never swallow a click meant for the page. */
                transform: translateX(calc(-100% - 16px));
                opacity: 0;
                pointer-events: none;
                transition: transform 0.2s ease, opacity 0.2s ease, background-color 0.3s ease;
            }

            /* A handover opens a DIFFERENT document's panel. Sliding in each time made
               every tab switch look like the rail flying off-screen and back. */
            .panel.instant { transition: none !important; }

            .panel.open {
                transform: translateX(0);
                opacity: 1;
                pointer-events: auto;
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

    function applyWidth(next) {
        width = Math.round(Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, next)));
        panel.style.setProperty('--rail-width', `${width}px`);
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
        // The panel starts 8px from the viewport edge, so its right edge is at
        // clientX - 8 relative to the panel's own box.
        applyWidth(event.clientX - 8);
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

    async function send(action, extra = {}) {
        try {
            return await chrome.runtime.sendMessage({ action, ...extra });
        } catch (error) {
            // Service worker asleep or extension reloading. Nothing useful to do.
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
        if (!open || refreshQueued) return;
        refreshQueued = true;
        requestAnimationFrame(() => {
            refreshQueued = false;
            refresh();
        });
    }

    // ---------------------------------------------------------------- rendering

    function faviconFor(tab) {
        if (tab.favIconUrl) {
            const img = document.createElement('img');
            img.className = 'favicon';
            img.src = tab.favIconUrl;
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
            btn.addEventListener('click', async () => {
                await send('railSwitchSpace', { spaceId: space.id });
                queueRefresh();
            });
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
            btn.appendChild(faviconFor(tab));
            btn.addEventListener('click', () => send('railActivateTab', { tabId: tab.id }));
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

            const label = document.createElement('span');
            label.className = 'tab-title';
            label.textContent = tab.title;

            const close = document.createElement('button');
            close.className = 'close';
            close.textContent = '×';
            close.title = 'Close tab';
            close.addEventListener('click', async (event) => {
                event.stopPropagation();
                await send('railCloseTab', { tabId: tab.id });
                queueRefresh();
            });

            row.append(faviconFor(tab), label, close);
            row.addEventListener('click', () => send('railActivateTab', { tabId: tab.id }));
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
                queueRefresh();
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

    function hideNow() {
        open = false;
        panel.classList.remove('open');
        swatchesEl.classList.remove('open');
        paletteBtn.classList.remove('active');
        send('railClosed');
    }

    function scheduleHide() {
        // Dragging the edge drags the pointer outside the panel constantly.
        if (pinned || resizing) return;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hideNow, HIDE_DELAY_MS);
    }

    // Edge detection by pointer position rather than a hit-testing element. A fixed strip
    // over the left edge would swallow every click landing in that band - links, sidebars,
    // scrollbars on RTL pages. This intercepts nothing.
    window.addEventListener('mousemove', (event) => {
        if (event.clientX <= EDGE_TRIGGER_PX) {
            if (!open) show();
            return;
        }
        // Moving away from the edge while the panel is closed: nothing to do. While open,
        // the panel's own mouseleave handles it.
        if (open && !pinned && !resizing && event.clientX > width + HIDE_MARGIN_PX) {
            scheduleHide();
        }
    }, { passive: true });

    panel.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    panel.addEventListener('mouseleave', scheduleHide);

    // Never sit on top of fullscreen video.
    document.addEventListener('fullscreenchange', () => {
        const isFullscreen = Boolean(document.fullscreenElement);
        host.style.display = isFullscreen ? 'none' : '';
        if (isFullscreen) {
            clearTimeout(hideTimer);
            hideNow();
        }
    });

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
            hideNow();
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
    }, true);

    pinBtn.addEventListener('click', () => {
        pinned = !pinned;
        pinBtn.classList.toggle('active', pinned);
        pinBtn.title = pinned ? 'Unpin' : 'Keep open';
        if (!pinned) scheduleHide();
    });

    newTabBtn.addEventListener('click', async () => {
        await send('railNewTab');
        queueRefresh();
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
        if (message.action === 'railOpenImmediately') {
            // Appear already in place rather than animating in from off-screen.
            panel.classList.add('instant');
            show();
            requestAnimationFrame(() => {
                requestAnimationFrame(() => panel.classList.remove('instant'));
            });
            // The pointer is already sitting over the panel area, but no mousemove has
            // fired in this document yet, so nothing would keep it alive. Suppress the
            // hide timer until the pointer actually moves somewhere.
            clearTimeout(hideTimer);
            sendResponse({ success: true });
            return true;
        }
    });

    // documentElement, not body: body may not exist yet and may be replaced by the page.
    document.documentElement.appendChild(host);

    loadWidth();
})();
