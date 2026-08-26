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
    const CHROME_GROUP_COLORS = {
        grey: '#9aa0a6',
        blue: '#8ab4f8',
        red: '#f28b82',
        yellow: '#fdd663',
        green: '#81c995',
        pink: '#ff8bcb',
        purple: '#d7aefb',
        cyan: '#78d9ec',
        orange: '#fcad70'
    };

    let state = { spaces: [], tabs: [], pinned: [] };
    let hideTimer = null;
    let pinned = false;
    let open = false;
    let refreshQueued = false;

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

            .trigger {
                position: fixed;
                top: 0;
                left: 0;
                width: 10px;
                height: 100vh;
                z-index: 1;
            }

            .panel {
                position: fixed;
                top: 12px;
                left: 12px;
                width: 236px;
                max-height: calc(100vh - 24px);
                display: flex;
                flex-direction: column;
                gap: 8px;
                padding: 10px;
                box-sizing: border-box;

                background: rgba(32, 33, 36, 0.86);
                -webkit-backdrop-filter: blur(18px) saturate(160%);
                backdrop-filter: blur(18px) saturate(160%);
                border: 1px solid rgba(255, 255, 255, 0.10);
                border-radius: 14px;
                box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);

                color: #e8eaed;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                font-size: 13px;
                line-height: 1.3;

                /* Hidden by default: translated out AND non-interactive, so a hidden rail
                   can never swallow a click meant for the page. */
                transform: translateX(calc(-100% - 16px));
                opacity: 0;
                pointer-events: none;
                transition: transform 0.18s ease, opacity 0.18s ease;
            }

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
                font-weight: 600;
                font-size: 12px;
                letter-spacing: 0.02em;
                text-transform: uppercase;
                opacity: 0.6;
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

            .icon-btn:hover { background: rgba(255, 255, 255, 0.12); opacity: 1; }
            .icon-btn.active { opacity: 1; background: rgba(255, 255, 255, 0.16); }

            .spaces {
                display: flex;
                gap: 6px;
                overflow-x: auto;
                scrollbar-width: none;
                padding-bottom: 2px;
            }
            .spaces::-webkit-scrollbar { display: none; }

            .space {
                flex: none;
                height: 24px;
                max-width: 110px;
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 0 9px;
                border: none;
                border-radius: 12px;
                background: rgba(255, 255, 255, 0.08);
                color: inherit;
                font: inherit;
                font-size: 12px;
                cursor: pointer;
                white-space: nowrap;
                overflow: hidden;
            }

            .space:hover { background: rgba(255, 255, 255, 0.16); }
            .space.active { background: rgba(255, 255, 255, 0.22); }

            .dot {
                flex: none;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: var(--dot, #9aa0a6);
            }

            .space-name {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .pinned {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
            }

            .pin-tab {
                flex: none;
                width: 30px;
                height: 30px;
                display: flex;
                align-items: center;
                justify-content: center;
                border: none;
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.08);
                cursor: pointer;
                padding: 0;
            }

            .pin-tab:hover { background: rgba(255, 255, 255, 0.18); }
            .pin-tab.active { background: rgba(255, 255, 255, 0.26); }

            .divider {
                height: 1px;
                background: rgba(255, 255, 255, 0.10);
                margin: 2px 0;
            }

            .tabs {
                display: flex;
                flex-direction: column;
                gap: 2px;
                overflow-y: auto;
                scrollbar-width: thin;
                scrollbar-color: rgba(255,255,255,0.2) transparent;
                min-height: 0;
            }
            .tabs::-webkit-scrollbar { width: 6px; }
            .tabs::-webkit-scrollbar-thumb {
                background: rgba(255, 255, 255, 0.18);
                border-radius: 3px;
            }

            .tab {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 5px 6px;
                border-radius: 8px;
                cursor: pointer;
                min-height: 26px;
            }

            .tab:hover { background: rgba(255, 255, 255, 0.10); }
            .tab.active { background: rgba(255, 255, 255, 0.18); }

            .favicon {
                flex: none;
                width: 16px;
                height: 16px;
                border-radius: 3px;
                object-fit: contain;
            }

            .fallback-icon {
                flex: none;
                width: 16px;
                height: 16px;
                border-radius: 3px;
                background: rgba(255, 255, 255, 0.2);
            }

            .tab-title {
                flex: 1;
                min-width: 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            .close {
                flex: none;
                width: 18px;
                height: 18px;
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
            .close:hover { opacity: 1; background: rgba(255, 255, 255, 0.16); }

            .new-tab {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                height: 28px;
                border: none;
                border-radius: 8px;
                background: rgba(255, 255, 255, 0.08);
                color: inherit;
                font: inherit;
                font-size: 12px;
                cursor: pointer;
            }

            .new-tab:hover { background: rgba(255, 255, 255, 0.18); }

            .empty {
                padding: 10px 4px;
                opacity: 0.5;
                font-size: 12px;
            }

            @media (prefers-color-scheme: light) {
                .panel {
                    background: rgba(250, 250, 250, 0.88);
                    border-color: rgba(0, 0, 0, 0.10);
                    color: #202124;
                    box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22);
                }
                .space, .pin-tab, .new-tab { background: rgba(0, 0, 0, 0.06); }
                .space:hover, .pin-tab:hover, .new-tab:hover { background: rgba(0, 0, 0, 0.12); }
                .space.active, .pin-tab.active { background: rgba(0, 0, 0, 0.16); }
                .tab:hover { background: rgba(0, 0, 0, 0.07); }
                .tab.active { background: rgba(0, 0, 0, 0.12); }
                .divider { background: rgba(0, 0, 0, 0.10); }
                .icon-btn:hover { background: rgba(0, 0, 0, 0.10); }
            }
        </style>

        <div class="trigger"></div>
        <div class="panel">
            <div class="header">
                <span class="title">Arcify</span>
                <button class="icon-btn pin" title="Keep open">&#9678;</button>
            </div>
            <div class="spaces"></div>
            <div class="pinned"></div>
            <div class="divider"></div>
            <div class="tabs"></div>
            <button class="new-tab">+ New Tab</button>
        </div>
    `;

    const trigger = shadow.querySelector('.trigger');
    const panel = shadow.querySelector('.panel');
    const spacesEl = shadow.querySelector('.spaces');
    const pinnedEl = shadow.querySelector('.pinned');
    const tabsEl = shadow.querySelector('.tabs');
    const titleEl = shadow.querySelector('.title');
    const pinBtn = shadow.querySelector('.pin');
    const newTabBtn = shadow.querySelector('.new-tab');

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

        // --- spaces ---
        spacesEl.replaceChildren();
        for (const space of state.spaces) {
            const btn = document.createElement('button');
            btn.className = 'space' + (space.active ? ' active' : '');
            btn.title = space.name;

            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.style.setProperty('--dot', CHROME_GROUP_COLORS[space.color] || CHROME_GROUP_COLORS.grey);

            const label = document.createElement('span');
            label.className = 'space-name';
            label.textContent = space.name;

            btn.append(dot, label);
            btn.addEventListener('click', async () => {
                await send('railSwitchSpace', { spaceId: space.id });
                queueRefresh();
            });
            spacesEl.appendChild(btn);
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

    // ---------------------------------------------------------------- visibility

    function show() {
        clearTimeout(hideTimer);
        if (!open) {
            open = true;
            panel.classList.add('open');
        }
        refresh();
    }

    function scheduleHide() {
        if (pinned) return;
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            open = false;
            panel.classList.remove('open');
        }, HIDE_DELAY_MS);
    }

    trigger.addEventListener('mouseenter', show);
    panel.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    panel.addEventListener('mouseleave', scheduleHide);
    trigger.addEventListener('mouseleave', scheduleHide);

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

    chrome.runtime.onMessage.addListener((message) => {
        if (message && message.action === 'railStateChanged') {
            queueRefresh();
        }
    });

    // documentElement, not body: body may not exist yet and may be replaced by the page.
    document.documentElement.appendChild(host);
})();
