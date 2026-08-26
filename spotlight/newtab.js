/**
 * New Tab Spotlight - Standalone spotlight page for new tab override
 * 
 * Purpose: Provides spotlight functionality on new tab page
 * Use Case: Fallback when spotlight cannot be injected (chrome:// URLs, restricted pages)
 * Architecture: Reuses shared spotlight modules in standalone page context
 */

import { SpotlightUtils } from './shared/ui-utilities.js';
import { SelectionManager } from './shared/selection-manager.js';
import { SpotlightMessageClient } from './shared/message-client.js';
import { SpotlightTabMode } from './shared/search-types.js';
import { SharedSpotlightLogic } from './shared/shared-component-logic.js';
import { Logger } from '../logger.js';

// How long to keep trying to steal focus back from the omnibox before giving up.
const FOCUS_DEADLINE_MS = 1000;

/**
 * Hand the tab back to the browser's own new tab page.
 * background.js already implements 'navigateToDefaultNewTab' (chrome://new-tab-page/
 * with a chrome-search://local-ntp fallback) — reuse it rather than duplicating it.
 */
async function navigateToDefaultNewTab() {
    try {
        await chrome.runtime.sendMessage({ action: 'navigateToDefaultNewTab' });
    } catch (error) {
        Logger.error('[NewTab] Error navigating to default new tab:', error);
    }
}

/**
 * Focus the spotlight input.
 *
 * Chrome parks focus in the OMNIBOX on chrome_url_overrides newtab pages, and a bare
 * input.focus() from the page cannot reclaim it. Retry across a few frames and re-assert
 * when the document regains visibility or window focus. Bounded and self-terminating:
 * stops on the first success or after FOCUS_DEADLINE_MS, and removes its own listeners.
 */
function focusInput(input) {
    const deadline = performance.now() + FOCUS_DEADLINE_MS;
    let frame = null;

    const attempt = () => {
        window.focus();
        input.focus({ preventScroll: true });
        return document.activeElement === input;
    };

    const cleanup = () => {
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }
        document.removeEventListener('visibilitychange', reassert);
        window.removeEventListener('focus', reassert);
    };

    function reassert() {
        if (document.visibilityState === 'visible' && attempt()) {
            cleanup();
        }
    }

    const tick = () => {
        frame = null;
        if (attempt() || performance.now() >= deadline) {
            cleanup();
            return;
        }
        frame = requestAnimationFrame(tick);
    };

    document.addEventListener('visibilitychange', reassert);
    window.addEventListener('focus', reassert);
    tick();
}

/**
 * Alt+L / Alt+T while this page is already in front must focus the input it already has,
 * not stack another newtab page on top of it. This page is an extension page, so
 * background.js broadcasts over chrome.runtime rather than chrome.tabs — match on tabId
 * so only the tab the shortcut fired in reacts.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.action !== 'focusSpotlightInput') {
        return;
    }

    (async () => {
        try {
            const currentTab = await chrome.tabs.getCurrent();
            if (message.tabId && currentTab && currentTab.id !== message.tabId) {
                sendResponse({ success: false, reason: 'not-target-tab' });
                return;
            }

            const input = document.querySelector('.arcify-spotlight-input');
            if (!input) {
                sendResponse({ success: false, reason: 'input-not-ready' });
                return;
            }

            input.select();
            focusInput(input);
            sendResponse({ success: true });
        } catch (error) {
            Logger.error('[NewTab Spotlight] Error focusing existing input:', error);
            sendResponse({ success: false, error: error.message });
        }
    })();

    return true; // Async response.
});

// Initialize spotlight on page load
document.addEventListener('DOMContentLoaded', async () => {
    const container = document.getElementById('spotlight-container');

    // Check if spotlight is enabled (controls both spotlight and custom new tab)
    const settings = await chrome.storage.sync.get({ enableSpotlight: true });

    if (!settings.enableSpotlight) {
        // Request background script to navigate to default new tab
        await navigateToDefaultNewTab();
        return;
    }

    // If enabled, show container and initialize
    if (container) {
        container.style.visibility = 'visible';
    }
    await initializeSpotlight();
});

async function initializeSpotlight() {
    const container = document.getElementById('spotlight-container');

    // Start with default color - will update asynchronously
    let activeSpaceColor = 'purple';

    // CSS styles with default accent color
    const accentColorDefinitions = await SpotlightUtils.getAccentColorCSS(activeSpaceColor);
    const spotlightCSS = `
        ${accentColorDefinitions}
        
        /* Smooth transitions for color changes */
        :root {
            transition: --spotlight-accent-color 0.3s ease,
                       --spotlight-accent-color-15 0.3s ease,
                       --spotlight-accent-color-20 0.3s ease,
                       --spotlight-accent-color-80 0.3s ease;
        }
        
        .arcify-spotlight-wrapper {
            background: #2D2D2D;
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            padding: 0;
            color: #ffffff;
            position: relative;
            overflow: hidden;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
            animation: spotlight-appear 0.3s ease-out;
        }

        @keyframes spotlight-appear {
            from {
                opacity: 0;
                transform: scale(0.95);
            }
            to {
                opacity: 1;
                transform: scale(1);
            }
        }

        .arcify-spotlight-input-wrapper {
            display: flex;
            align-items: center;
            padding: 12px 24px 12px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .arcify-spotlight-search-icon {
            width: 20px;
            height: 20px;
            margin-right: 12px;
            opacity: 0.6;
            flex-shrink: 0;
        }

        .arcify-spotlight-input {
            flex: 1;
            background: transparent;
            border: none;
            color: #ffffff;
            font-size: 18px;
            line-height: 24px;
            padding: 8px 0;
            outline: none;
            font-weight: 400;
        }

        .arcify-spotlight-input::placeholder {
            color: rgba(255, 255, 255, 0.5);
        }

        .arcify-spotlight-results {
            max-height: 270px;
            overflow-y: auto;
            padding: 8px 0;
            scroll-behavior: smooth;
            scrollbar-width: none;
            -ms-overflow-style: none;
        }

        .arcify-spotlight-results::-webkit-scrollbar {
            display: none;
        }

        .arcify-spotlight-result-item {
            display: flex;
            align-items: center;
            padding: 12px 24px 12px 20px;
            min-height: 44px;
            cursor: pointer;
            transition: background-color 0.15s ease;
            border: none;
            background: none;
            width: 100%;
            text-align: left;
            color: inherit;
            font-family: inherit;
        }

        .arcify-spotlight-result-item:hover,
        .arcify-spotlight-result-item:focus {
            background: var(--spotlight-accent-color-15);
            outline: none;
        }

        .arcify-spotlight-result-item.selected {
            background: var(--spotlight-accent-color-20);
        }

        .arcify-spotlight-result-favicon {
            width: 20px;
            height: 20px;
            margin-right: 12px;
            border-radius: 4px;
            flex-shrink: 0;
        }

        .arcify-spotlight-result-content {
            flex: 1;
            min-width: 0;
            min-height: 32px;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }

        .arcify-spotlight-result-title {
            font-size: 14px;
            font-weight: 500;
            color: #ffffff;
            margin: 0 0 2px 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .arcify-spotlight-result-url {
            font-size: 12px;
            color: rgba(255, 255, 255, 0.6);
            margin: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .arcify-spotlight-result-url:empty {
            display: none;
        }

        .arcify-spotlight-result-action {
            font-size: 12px;
            color: var(--spotlight-accent-color-80);
            margin-left: 12px;
            flex-shrink: 0;
        }

        .arcify-spotlight-loading {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            color: rgba(255, 255, 255, 0.6);
        }

        .arcify-spotlight-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
            color: rgba(255, 255, 255, 0.6);
            font-size: 14px;
        }

        @media (max-width: 640px) {
            .arcify-spotlight-input {
                font-size: 16px;
            }
        }
    `;

    // Create and inject styles
    const styleSheet = document.createElement('style');
    styleSheet.id = 'arcify-spotlight-styles';
    styleSheet.textContent = spotlightCSS;
    document.head.appendChild(styleSheet);

    // Create spotlight UI
    container.innerHTML = `
        <div class="arcify-spotlight-wrapper">
            <div class="arcify-spotlight-input-wrapper">
                <svg class="arcify-spotlight-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                </svg>
                <input 
                    type="text" 
                    class="arcify-spotlight-input" 
                    placeholder="Search or enter URL..."
                    spellcheck="false"
                    autocomplete="off"
                    autocorrect="off"
                    autocapitalize="off"
                >
            </div>
            <div class="arcify-spotlight-results">
                <div class="arcify-spotlight-loading">Loading...</div>
            </div>
        </div>
    `;

    // Get references to key elements
    const input = container.querySelector('.arcify-spotlight-input');
    const resultsContainer = container.querySelector('.arcify-spotlight-results');

    // Initialize spotlight state
    let currentResults = [];
    let instantSuggestion = null;
    let asyncSuggestions = [];

    // Send get suggestions message to background script
    // Use 'current-tab' mode so navigation happens in the current tab (the new tab page itself)
    async function sendGetSuggestionsMessage(query, mode) {
        return await SpotlightMessageClient.getSuggestions(query, mode);
    }

    // Handle result action via message passing
    // Use 'current-tab' mode so navigation happens in the current tab (the new tab page itself)
    async function handleResultActionViaMessage(result, mode) {
        return await SpotlightMessageClient.handleResult(result, mode);
    }

    const selectionManager = new SelectionManager(resultsContainer);

    // Load initial results
    // Use 'current-tab' mode since we're on the new tab page itself
    async function loadInitialResults() {
        try {
            instantSuggestion = null;
            const results = await sendGetSuggestionsMessage('', 'current-tab');
            asyncSuggestions = results || [];
            updateDisplay();
        } catch (error) {
            Logger.error('[NewTab Spotlight] Error loading initial results:', error);
            instantSuggestion = null;
            asyncSuggestions = [];
            displayEmptyState();
        }
    }

    // Handle instant suggestion update (no debouncing)
    function handleInstantInput() {
        const query = input.value.trim();

        if (!query) {
            instantSuggestion = null;
            loadInitialResults();
            return;
        }

        instantSuggestion = SpotlightUtils.generateInstantSuggestion(query);
        updateDisplay();
    }

    // Handle async search (debounced)
    // Use 'current-tab' mode since we're on the new tab page itself
    async function handleAsyncSearch() {
        const query = input.value.trim();

        if (!query) {
            asyncSuggestions = [];
            updateDisplay();
            return;
        }

        try {
            const results = await sendGetSuggestionsMessage(query, 'current-tab');
            asyncSuggestions = results || [];
            updateDisplay();
        } catch (error) {
            Logger.error('[NewTab Spotlight] Search error:', error);
            asyncSuggestions = [];
            updateDisplay();
        }
    }

    // Combine instant and async suggestions with deduplication
    function combineResults() {
        return SharedSpotlightLogic.combineResults(instantSuggestion, asyncSuggestions);
    }

    // Update the display with combined results
    function updateDisplay() {
        currentResults = combineResults();
        selectionManager.updateResults(currentResults);

        if (currentResults.length === 0) {
            displayEmptyState();
            return;
        }

        // Use 'current-tab' mode since we're on the new tab page itself
        SharedSpotlightLogic.updateResultsDisplay(resultsContainer, [], currentResults, 'current-tab');
    }

    // Display empty state
    function displayEmptyState() {
        resultsContainer.innerHTML = '<div class="arcify-spotlight-empty">Start typing to search tabs, bookmarks, and history</div>';
        currentResults = [];
        instantSuggestion = null;
        asyncSuggestions = [];
        selectionManager.updateResults([]);
    }

    // Input event handlers
    input.addEventListener('input', SharedSpotlightLogic.createInputHandler(
        handleInstantInput,
        handleAsyncSearch,
        150
    ));

    // Handle result selection
    // Use 'current-tab' mode so navigation happens in the current tab (the new tab page itself)
    async function handleResultAction(result) {
        if (!result) {
            Logger.error('[NewTab Spotlight] No result provided');
            return;
        }

        try {
            await handleResultActionViaMessage(result, 'current-tab');
        } catch (error) {
            Logger.error('[NewTab Spotlight] Error in result action:', error);
        }
    }

    // Keyboard navigation
    input.addEventListener('keydown', SharedSpotlightLogic.createKeyDownHandler(
        selectionManager,
        (selected) => handleResultAction(selected),
        () => navigateToDefaultNewTab() // Escape dismisses to the browser's own new tab page
    ));

    // Handle clicks on results
    SharedSpotlightLogic.setupResultClickHandling(
        resultsContainer,
        (result, index) => handleResultAction(result),
        () => currentResults
    );

    // Focus input immediately (see focusInput — the omnibox fights us for it)
    focusInput(input);

    // Load initial results and update color asynchronously
    (async () => {
        try {
            // Update active space color asynchronously
            const realActiveSpaceColor = await SpotlightMessageClient.getActiveSpaceColor();
            if (realActiveSpaceColor !== activeSpaceColor) {
                const newColorDefinitions = await SpotlightUtils.getAccentColorCSS(realActiveSpaceColor);
                const styleElement = document.querySelector('#arcify-spotlight-styles');
                if (styleElement) {
                    const colorRegex = /:root\s*{([^}]*)}/;
                    const currentCSS = styleElement.textContent;
                    const newColorMatch = newColorDefinitions.match(colorRegex);
                    if (newColorMatch) {
                        const updatedCSS = currentCSS.replace(colorRegex, newColorMatch[0]);
                        styleElement.textContent = updatedCSS;
                    }
                }
            }
        } catch (error) {
            Logger.error('[NewTab Spotlight] Error updating active space color:', error);
        }

        // Load initial results
        loadInitialResults();
    })();
}
