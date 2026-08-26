/**
 * Offscreen clipboard writer.
 *
 * Loaded only by offscreen.html, which background.js opens on demand. Plain script (no
 * modules, no imports) so the build can copy it verbatim alongside its HTML.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // background.js addresses this document explicitly; ignore everything else so the
    // side panel and newtab page keep receiving their own messages.
    if (!message || message.target !== 'offscreen' || message.action !== 'copyToClipboard') {
        return;
    }

    writeToClipboard(String(message.text ?? ''))
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error && error.message }));

    return true; // Keep the message channel open for the async response.
});

async function writeToClipboard(text) {
    // execCommand FIRST, not as a fallback. An offscreen document is never focused, and
    // navigator.clipboard.writeText rejects with NotAllowedError ("Document is not
    // focused") in an unfocused document. The textarea path has no such requirement, which
    // is why Chrome's own offscreen clipboard sample uses it.
    const scratch = document.getElementById('clipboard-scratch');
    if (scratch) {
        try {
            scratch.value = text;
            scratch.focus();
            scratch.select();
            scratch.setSelectionRange(0, text.length);

            if (document.execCommand('copy')) {
                return;
            }
            console.warn('[Offscreen] execCommand("copy") returned false');
        } catch (execError) {
            console.warn('[Offscreen] execCommand path threw:', execError);
        }
    } else {
        console.warn('[Offscreen] Clipboard scratch element missing');
    }

    // Async clipboard API as the backstop, for the case where execCommand is unavailable.
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch (clipboardError) {
        throw new Error(`Both clipboard paths failed: ${clipboardError && clipboardError.message}`);
    }
}
