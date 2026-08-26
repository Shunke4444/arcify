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
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch (clipboardError) {
        // Fall through to the textarea path below.
    }

    const scratch = document.getElementById('clipboard-scratch');
    if (!scratch) {
        throw new Error('Clipboard scratch element missing');
    }

    scratch.value = text;
    scratch.select();

    if (!document.execCommand('copy')) {
        throw new Error('document.execCommand("copy") returned false');
    }
}
