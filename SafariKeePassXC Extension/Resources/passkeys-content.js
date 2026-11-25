// Isolated-world content script for passkeys.
//
// The page-world adapter (passkeys-page.js) cannot use extension APIs, so it
// posts requests as DOM events. This script is the only bridge: it validates
// the message shape, forwards registration/authentication to background.js,
// and posts the answer back to the same document.
//
// It also publishes the passkeys setting. The page adapter keeps early
// navigator.credentials calls until it knows whether the bridge is enabled.

(() => {
    "use strict";

    // The manifest MAIN-world entry is the primary injection path and works in
    // Safari even under a strict page CSP (verified on Safari 27.2). This
    // script-tag injection is a fallback for the case where Safari ignores
    // "world": "MAIN"; the adapter ignores a second execution.
    function injectPageAdapter() {
        const type = document.contentType;
        if (type !== "text/html" && type !== "application/xhtml+xml") return;
        try {
            const script = document.createElement("script");
            script.src = browser.runtime.getURL("passkeys-page.js");
            script.onload = () => script.remove();
            script.onerror = () => script.remove();
            (document.head || document.documentElement).appendChild(script);
        } catch {
            // The manifest MAIN-world entry may still have run.
        }
    }
    injectPageAdapter();

    try {
        document.documentElement.dataset.kpxcPasskeysContent = "1";
    } catch {
        // Diagnostics only.
    }

    const ACTIONS = new Set(["passkeys-register", "passkeys-get"]);
    const MAX_ID_LENGTH = 128;
    const MAX_TIMEOUT = 140000;

    const pending = new Map();

    function respond(detail) {
        document.dispatchEvent(new CustomEvent("kpxc-passkeys-response", {
            detail,
        }));
    }

    function publishSetting(enabled) {
        document.dispatchEvent(new CustomEvent("kpxc-passkeys-setting", {
            detail: { enabled: enabled === true },
        }));
    }

    async function readSetting() {
        try {
            const { passkeysEnabled } = await browser.storage.local.get("passkeysEnabled");
            return passkeysEnabled === true;
        } catch {
            return false;
        }
    }

    function abort(id) {
        const entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        respond({ id, errorCode: "abort" });
    }

    function isPlainObject(value) {
        return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }

    function validRequest(detail) {
        if (!isPlainObject(detail)) return false;
        if (!ACTIONS.has(detail.action)) return false;
        if (typeof detail.id !== "string" || detail.id.length === 0
            || detail.id.length > MAX_ID_LENGTH) {
            return false;
        }
        if (!isPlainObject(detail.publicKey)) return false;
        if (typeof detail.publicKey.challenge !== "string"
            || detail.publicKey.challenge.length === 0
            || detail.publicKey.challenge.length > 8192) {
            return false;
        }
        return true;
    }

    function handleRequest(event) {
        const detail = event.detail;
        if (!isPlainObject(detail)) return;

        if (detail.action === "abort") {
            if (typeof detail.id === "string") abort(detail.id);
            return;
        }

        if (!validRequest(detail)) return;
        if (pending.has(detail.id)) return;

        const requestedTimeout = Number(detail.publicKey.timeout);
        const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
            ? Math.min(MAX_TIMEOUT, requestedTimeout + 15000)
            : 45000;

        const timer = setTimeout(() => {
            if (!pending.has(detail.id)) return;
            pending.delete(detail.id);
            respond({ id: detail.id, errorCode: "timeout" });
        }, timeout);

        pending.set(detail.id, { timer });

        let request;
        try {
            request = browser.runtime.sendMessage({
                id: detail.id,
                action: detail.action,
                publicKey: detail.publicKey,
            });
        } catch (error) {
            clearTimeout(timer);
            pending.delete(detail.id);
            respond({ id: detail.id, error: String(error) });
            return;
        }

        request.then((response) => {
            // A late answer after abort/pagehide/timeout is discarded.
            if (!pending.has(detail.id)) return;
            clearTimeout(timer);
            pending.delete(detail.id);

            if (response?.fallback) {
                respond({ id: detail.id, fallback: true });
                return;
            }
            if (response?.success) {
                const passkeyResponse = response.result?.response ?? null;
                // KeePassXC wraps passkey failures in the inner response as
                // {"errorCode": N}. Surface the code so the page adapter can
                // map it to the right DOMException.
                if (passkeyResponse
                    && typeof passkeyResponse === "object"
                    && passkeyResponse.errorCode !== undefined) {
                    respond({
                        id: detail.id,
                        errorCode: passkeyResponse.errorCode,
                    });
                    return;
                }
                respond({
                    id: detail.id,
                    response: passkeyResponse,
                });
                return;
            }
            respond({
                id: detail.id,
                error: response?.error ?? "unknown_error",
            });
        }).catch((error) => {
            if (!pending.has(detail.id)) return;
            clearTimeout(timer);
            pending.delete(detail.id);
            respond({ id: detail.id, error: String(error) });
        });
    }

    function clearPending() {
        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
        }
        pending.clear();
    }

    document.addEventListener("kpxc-passkeys-request", handleRequest);
    document.addEventListener("kpxc-passkeys-hello", () => {
        readSetting().then(publishSetting);
    });
    window.addEventListener("pagehide", clearPending);
    window.addEventListener("unload", clearPending);

    // Popup diagnostics: is the page adapter actually installed here?
    browser.runtime.onMessage?.addListener((request) => {
        if (request?.action !== "passkeys-diagnostic") return;
        return Promise.resolve({
            content: true,
            page: document.documentElement?.dataset.kpxcPasskeysPage ?? null,
            decision: document.documentElement?.dataset.kpxcPasskeysLastDecision ?? null,
        });
    });

    // Announce the setting more than once: the page adapter may attach its
    // listener a tick after this script starts.
    readSetting().then(publishSetting);
    setTimeout(() => readSetting().then(publishSetting), 0);
    setTimeout(() => readSetting().then(publishSetting), 250);

    browser.storage?.onChanged?.addListener((changes, area) => {
        if (area !== "local" || !changes.passkeysEnabled) return;
        publishSetting(changes.passkeysEnabled.newValue === true);
    });
})();
