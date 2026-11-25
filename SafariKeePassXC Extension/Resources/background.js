// Background script: the single bridge between the extension's JS contexts
// (popup, content scripts) and the native macOS app.
//
// Popup and content scripts send JSON requests via browser.runtime.sendMessage.
// Here we forward them to the native app (Swift), which talks to KeePassXC, and
// relay the JSON response straight back to the caller.
//
// Passkey requests get extra checks here because the page world is untrusted:
// the origin is derived from sender.url, never from the page, and the RP ID is
// validated against the WebAuthn rules (registrable domain suffix, public
// suffixes). Only registration and authentication are forwarded.
//
// The application identifier is required by the API signature; on Safari the
// message is always delivered to this extension's native handler.

import {
    PUBLIC_SUFFIXES,
    PUBLIC_SUFFIX_WILDCARDS,
    PUBLIC_SUFFIX_EXCEPTIONS,
} from "./public-suffixes.js";

const NATIVE_APP_ID = "dev.kotsareu.SafariKeePassXC";

const PASSKEY_ACTIONS = new Set(["passkeys-register", "passkeys-get"]);

// -- Pending saves (save banner) --

const pendingSaves = new Map();
const PENDING_SAVE_TTL = 60 * 1000;

function pendingSaveFor(tabId, url) {
    const pending = pendingSaves.get(tabId);
    if (!pending) return null;

    let sameHost = false;
    try {
        sameHost = new URL(pending.url).hostname === new URL(url).hostname;
    } catch {
        // Leave sameHost false for unparsable URLs.
    }
    if (!sameHost || Date.now() - pending.queuedAt > PENDING_SAVE_TTL) {
        pendingSaves.delete(tabId);
        return null;
    }
    return pending;
}

// -- Passkey setting --

async function passkeysEnabled() {
    try {
        const { passkeysEnabled } = await browser.storage.local.get("passkeysEnabled");
        return passkeysEnabled === true;
    } catch {
        // A broken storage read must never enable the passkey bridge.
        return false;
    }
}

// -- RP ID validation --
//
// WebAuthn requires rpId to be a "registrable domain suffix" of the origin's
// effective domain: equal to the host or a dot-separated suffix of it, and not
// a public suffix itself. A plain endsWith() check would accept "co.uk".

const PUBLIC_SUFFIX_SET = new Set(PUBLIC_SUFFIXES.split("\n").filter(Boolean));
const PUBLIC_SUFFIX_WILDCARD_SET = new Set(
    PUBLIC_SUFFIX_WILDCARDS.split("\n").filter(Boolean)
);
const PUBLIC_SUFFIX_EXCEPTION_SET = new Set(
    PUBLIC_SUFFIX_EXCEPTIONS.split("\n").filter(Boolean)
);

function isIpAddress(host) {
    if (host.includes(":")) return true; // IPv6 (including bracketed forms)
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isValidDomain(host) {
    if (typeof host !== "string" || host.length === 0 || host.length > 253) {
        return false;
    }
    if (host.endsWith(".") || isIpAddress(host)) return false;
    // WebAuthn RP IDs are ASCII host names. Reject percent-encoding, ports,
    // paths and Unicode look-alikes outright.
    if (!/^[A-Za-z0-9.-]+$/.test(host)) return false;

    const labels = host.split(".");
    return labels.every(
        (label) =>
            label.length > 0 &&
            label.length <= 63 &&
            !label.startsWith("-") &&
            !label.endsWith("-")
    );
}

function isPublicSuffix(domain) {
    const value = String(domain).toLowerCase();
    if (!value) return true;
    if (PUBLIC_SUFFIX_EXCEPTION_SET.has(value)) return false;
    if (PUBLIC_SUFFIX_SET.has(value)) return true;

    const labels = value.split(".");
    // A single label is a TLD (the implicit "*" rule).
    if (labels.length === 1) return true;

    // A "*.X" rule matches exactly one label before X, so only the domain
    // with its first label removed can be a wildcard public suffix. Deeper
    // subdomains (bar.foo.ck) are registrable under foo.ck.
    return PUBLIC_SUFFIX_WILDCARD_SET.has(labels.slice(1).join("."));
}

function validateRpId(rpId, host) {
    if (typeof rpId !== "string" || rpId.length === 0) return false;

    const candidate = rpId.toLowerCase();
    const originHost = String(host).toLowerCase().replace(/\.$/, "");

    // localhost is a special case in WebAuthn and is not in the PSL.
    if (candidate === "localhost") {
        return originHost === "localhost" || originHost.endsWith(".localhost");
    }

    if (!isValidDomain(candidate)) return false;
    if (isPublicSuffix(candidate)) return false;

    return originHost === candidate || originHost.endsWith(`.${candidate}`);
}

// -- Passkey request validation --

function base64UrlByteLength(value) {
    if (typeof value !== "string" || value.length === 0) return -1;
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return -1;

    const unpadded = value.replace(/=+$/, "");
    const padding = (4 - (unpadded.length % 4)) % 4;
    if (padding === 3) return -1;

    const base64 = unpadded.replace(/-/g, "+").replace(/_/g, "/")
        + "=".repeat(padding);
    try {
        return atob(base64).length;
    } catch {
        return -1;
    }
}

function isCredentialDescriptor(value) {
    return Boolean(value)
        && typeof value === "object"
        && typeof value.id === "string"
        && base64UrlByteLength(value.id) > 0
        && (value.type === undefined || value.type === "public-key");
}

function validatePublicKey(action, publicKey, host) {
    if (!publicKey || typeof publicKey !== "object" || Array.isArray(publicKey)) {
        return { ok: false, error: "invalid_public_key" };
    }

    // KeePassXC requires at least 16 bytes of challenge.
    if (typeof publicKey.challenge !== "string"
        || publicKey.challenge.length > 8192
        || base64UrlByteLength(publicKey.challenge) < 16) {
        return { ok: false, error: "invalid_challenge" };
    }

    if (action === "passkeys-register") {
        const rp = publicKey.rp;
        if (rp !== undefined && (typeof rp !== "object" || rp === null)) {
            return { ok: false, error: "invalid_rp" };
        }
        if (rp?.id !== undefined && typeof rp.id !== "string") {
            return { ok: false, error: "invalid_rp" };
        }

        const user = publicKey.user;
        if (!user || typeof user !== "object") {
            return { ok: false, error: "invalid_user" };
        }
        const userIdLength = base64UrlByteLength(user.id);
        if (userIdLength < 1 || userIdLength > 64) {
            return { ok: false, error: "invalid_user_id" };
        }

        if (!Array.isArray(publicKey.pubKeyCredParams)
            || publicKey.pubKeyCredParams.length === 0) {
            return { ok: false, error: "invalid_algorithms" };
        }

        const excluded = publicKey.excludeCredentials ?? [];
        if (!Array.isArray(excluded) || !excluded.every(isCredentialDescriptor)) {
            return { ok: false, error: "invalid_exclude_credentials" };
        }

        return { ok: true, rpId: rp?.id ?? host };
    }

    if (publicKey.rpId !== undefined && typeof publicKey.rpId !== "string") {
        return { ok: false, error: "invalid_rp_id" };
    }

    const allowed = publicKey.allowCredentials ?? [];
    if (!Array.isArray(allowed) || !allowed.every(isCredentialDescriptor)) {
        return { ok: false, error: "invalid_allow_credentials" };
    }

    return { ok: true, rpId: publicKey.rpId ?? host };
}

async function handlePasskeyMessage(message, sender) {
    const action = message.action;
    if (!PASSKEY_ACTIONS.has(action)) {
        return { success: false, error: "forbidden_action" };
    }

    // Passkeys are only accepted from a real tab, top frame, HTTPS document.
    if (!sender.tab || sender.tab.id === undefined) {
        return { success: false, error: "no_tab" };
    }
    if (sender.frameId !== undefined) {
        if (sender.frameId !== 0) {
            return { success: false, error: "not_top_frame" };
        }
    } else if (sender.tab.url && sender.url && sender.tab.url !== sender.url) {
        // Safari versions without sender.frameId: a subframe reports its own
        // URL, which differs from the tab's top-level URL.
        return { success: false, error: "not_top_frame" };
    }
    if (typeof sender.url !== "string" || sender.url.length === 0) {
        return { success: false, error: "no_sender_url" };
    }

    let documentUrl;
    try {
        documentUrl = new URL(sender.url);
    } catch {
        return { success: false, error: "invalid_sender_url" };
    }
    if (documentUrl.protocol !== "https:") {
        return { success: false, error: "insecure_origin" };
    }

    if (!(await passkeysEnabled())) {
        // The page adapter falls back to Safari when it sees this.
        return { success: false, error: "passkeys_disabled", fallback: true };
    }

    const validation = validatePublicKey(
        action,
        message.publicKey,
        documentUrl.hostname
    );
    if (!validation.ok) {
        return { success: false, error: validation.error };
    }

    if (!validateRpId(validation.rpId, documentUrl.hostname)) {
        return { success: false, error: "invalid_rp_id" };
    }

    return browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
        id: message.id,
        action,
        origin: documentUrl.origin,
        publicKey: message.publicKey,
    });
}

// -- Message router --

browser.runtime.onMessage.addListener((request, sender) => {
    const message = { ...request };
    const tabId = sender.tab?.id;

    switch (message.action) {
        case "queue-save": {
            if (tabId === undefined) {
                return Promise.resolve({ success: false, error: "no_tab" });
            }
            pendingSaves.set(tabId, {
                url: sender.url ?? message.url,
                login: message.login,
                password: message.password,
                uuid: message.uuid,
                queuedAt: Date.now(),
            });
            return Promise.resolve({ success: true, result: {} });
        }

        // The banner only ever learns the login name, never the password.
        case "get-pending-save": {
            const pending = tabId === undefined
                ? null
                : pendingSaveFor(tabId, sender.url ?? message.url ?? "");
            return Promise.resolve({
                success: true,
                result: pending
                    ? { login: pending.login, isUpdate: Boolean(pending.uuid) }
                    : null,
            });
        }

        case "confirm-pending-save": {
            const pending = tabId === undefined ? null : pendingSaves.get(tabId);
            if (!pending) {
                return Promise.resolve({ success: false, error: "nothing_pending" });
            }
            pendingSaves.delete(tabId);
            return browser.storage.local.get("saveGroup").then(({ saveGroup }) =>
                browser.runtime.sendNativeMessage(NATIVE_APP_ID, {
                    id: message.id,
                    action: "set-login",
                    url: pending.url,
                    login: pending.login,
                    password: pending.password,
                    uuid: pending.uuid,
                    ...(saveGroup ? { group: saveGroup.name, groupUuid: saveGroup.uuid } : {}),
                }));
        }

        case "dismiss-pending-save": {
            if (tabId !== undefined) pendingSaves.delete(tabId);
            return Promise.resolve({ success: true, result: {} });
        }

        case "passkeys-register":
        case "passkeys-get":
            return handlePasskeyMessage(message, sender);
    }

    // -- Native forwarding --

    // set-login is the only write action in the bridge API. It must only be
    // reachable through confirm-pending-save (which enforces the save banner,
    // host check, and TTL above); it is never forwarded here as-is.
    if (message.action === "set-login") {
        return Promise.resolve({ success: false, error: "forbidden_action" });
    }

    const urlBoundActions = ["get-logins"];
    if (urlBoundActions.includes(message.action) && sender.tab && sender.url) {
        message.url = sender.url;
    }

    return browser.runtime.sendNativeMessage(NATIVE_APP_ID, message);
});

// Exported for the Node unit tests. The extension itself never reads this.
export const __test = {
    isPublicSuffix,
    validateRpId,
    validatePublicKey,
    base64UrlByteLength,
    handlePasskeyMessage,
};
