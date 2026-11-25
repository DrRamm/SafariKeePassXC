// Page-world WebAuthn adapter.
//
// Runs in the page's own JavaScript world at document_start (manifest
// "world": "MAIN") so it can wrap navigator.credentials before the first page
// script runs. It talks to the isolated passkeys-content.js over DOM events;
// that script is the only part with extension APIs.
//
// The adapter is deliberately conservative: anything it does not fully
// understand (iframes, conditional mediation, unsupported extensions or
// algorithms) is handed to Safari's native WebAuthn implementation unchanged.
// Original methods are always called with the original receiver and arguments.

(() => {
    "use strict";

    // The adapter may be injected twice: by the manifest MAIN-world entry and
    // as a page script from passkeys-content.js. Install only once.
    if (globalThis.__KPXC_PASSKEYS_INSTALLED__ === true) return;
    globalThis.__KPXC_PASSKEYS_INSTALLED__ = true;

    if (window.top !== window) return;

    try {
        document.documentElement.dataset.kpxcPasskeysPage = "installed";
    } catch {
        // Diagnostics only.
    }

    const originalContainer = navigator.credentials;
    if (!originalContainer) return;

    const originalCreate = originalContainer.create.bind(originalContainer);
    const originalGet = originalContainer.get.bind(originalContainer);

    const SUPPORTED_ALGORITHMS = new Set([-7, -257, -8]); // ES256, RS256, EdDSA
    const SUPPORTED_EXTENSIONS = new Set(["credProps", "uvm"]);
    const USER_VERIFICATION_VALUES = new Set([
        "required", "preferred", "discouraged",
    ]);
    const RESIDENT_KEY_VALUES = new Set([
        "required", "preferred", "discouraged",
    ]);
    const ATTACHMENT_VALUES = new Set(["platform", "cross-platform"]);

    // -- Setting handshake --
    //
    // The isolated content script reads browser.storage asynchronously. Calls
    // that arrive before the answer are kept and resolved once it is known.

    let settingKnown = false;
    let settingEnabled = false;
    let resolveSetting;
    const settingReady = new Promise((resolve) => {
        resolveSetting = resolve;
    });

    function settleSetting(enabled) {
        settingEnabled = enabled === true;
        try {
            document.documentElement.dataset.kpxcPasskeysPage =
                settingEnabled ? "enabled" : "disabled";
        } catch {
            // Diagnostics only.
        }
        if (!settingKnown) {
            settingKnown = true;
            resolveSetting(settingEnabled);
        }
    }

    document.addEventListener("kpxc-passkeys-setting", (event) => {
        settleSetting(event.detail?.enabled);
    });

    let helloAttempts = 0;
    function askForSetting() {
        if (settingKnown) return;
        document.dispatchEvent(new CustomEvent("kpxc-passkeys-hello"));
        helloAttempts += 1;
        if (helloAttempts < 20) {
            setTimeout(askForSetting, 100);
        } else {
            // No isolated script answered: behave exactly like Safari.
            settleSetting(false);
        }
    }
    askForSetting();

    // -- Binary helpers --

    function toBase64Url(source) {
        let bytes;
        if (source instanceof ArrayBuffer) {
            bytes = new Uint8Array(source);
        } else if (ArrayBuffer.isView(source)) {
            // Respect byteOffset/byteLength: a page may pass a view into a
            // larger buffer.
            bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
        } else if (Array.isArray(source)) {
            bytes = Uint8Array.from(source);
        } else {
            throw new TypeError("BufferSource expected");
        }

        let binary = "";
        for (let index = 0; index < bytes.length; index += 1) {
            binary += String.fromCharCode(bytes[index]);
        }
        return btoa(binary)
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
    }

    function fromBase64Url(value) {
        if (typeof value !== "string" || value.length === 0) {
            throw new TypeError("base64url string expected");
        }
        const normalized = String(value)
            .replace(/-/g, "+")
            .replace(/_/g, "/")
            .replace(/=+$/, "");
        const padding = (4 - (normalized.length % 4)) % 4;
        const binary = atob(normalized + "=".repeat(padding));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }
        return bytes.buffer;
    }

    // -- Option conversion (KeePassXC wire format) --

    function getTimeout(publicKey, userVerification) {
        const timeout = Number(publicKey.timeout);
        if (!timeout || Number.isNaN(timeout)) {
            return userVerification === "discouraged" ? 120000 : 30000;
        }
        if (timeout < 15000 || timeout > 120000) return 30000;
        return timeout;
    }

    function normalizeExtensions(extensions) {
        if (!extensions || typeof extensions !== "object") return undefined;
        const result = {};
        if (extensions.credProps === true) result.credProps = true;
        if (extensions.uvm === true) result.uvm = true;
        return Object.keys(result).length ? result : undefined;
    }

    // WebAuthn extensions are optional: a client that does not understand one
    // must ignore it, not fail the ceremony. Only an extension that explicitly
    // requires support (largeBlob with support: "required") makes the request
    // impossible to satisfy.
    function hasRequiredExtension(extensions) {
        if (!extensions || typeof extensions !== "object") return false;
        return Object.values(extensions).some((value) =>
            value
            && typeof value === "object"
            && value.support === "required");
    }

    function buildCreationOptions(publicKey) {
        const selection = publicKey.authenticatorSelection;
        const userVerification = selection?.userVerification;

        return {
            attestation: publicKey.attestation,
            authenticatorSelection: selection ? {
                authenticatorAttachment: selection.authenticatorAttachment,
                residentKey: selection.residentKey,
                requireResidentKey: selection.requireResidentKey,
                userVerification: selection.userVerification,
            } : undefined,
            challenge: toBase64Url(publicKey.challenge),
            extensions: normalizeExtensions(publicKey.extensions),
            pubKeyCredParams: (publicKey.pubKeyCredParams ?? []).map((param) => ({
                type: param.type,
                alg: Number(param.alg),
            })),
            rp: {
                id: publicKey.rp?.id,
                name: publicKey.rp?.name,
            },
            timeout: getTimeout(publicKey, userVerification),
            excludeCredentials: (publicKey.excludeCredentials ?? []).map((credential) => ({
                id: toBase64Url(credential.id),
                type: credential.type,
                transports: credential.transports,
            })),
            user: {
                id: toBase64Url(publicKey.user.id),
                name: publicKey.user.name,
                displayName: publicKey.user.displayName,
            },
        };
    }

    function buildRequestOptions(publicKey) {
        return {
            challenge: toBase64Url(publicKey.challenge),
            enterpriseAttestationPossible: false,
            extensions: normalizeExtensions(publicKey.extensions),
            rpId: publicKey.rpId,
            timeout: getTimeout(publicKey, publicKey.userVerification),
            userVerification: publicKey.userVerification,
            allowCredentials: (publicKey.allowCredentials ?? []).map((credential) => ({
                id: toBase64Url(credential.id),
                type: credential.type,
                transports: [...(credential.transports ?? []), "internal"],
            })),
        };
    }

    // -- Support checks --
    //
    // A non-null reason means "let Safari handle this call unchanged". The
    // reason is kept for the popup diagnostics: without it a silent fallback
    // looks exactly like a broken extension.

    function createFallbackReason(options) {
        const publicKey = options?.publicKey;
        if (!publicKey || typeof publicKey !== "object") return "no-public-key";
        if (!publicKey.user || typeof publicKey.user !== "object") return "missing-user";
        if (typeof publicKey.user.name !== "string"
            || typeof publicKey.user.displayName !== "string") {
            return "missing-user";
        }
        if (!publicKey.rp || typeof publicKey.rp !== "object") return "missing-rp";
        if (typeof publicKey.rp.name !== "string") return "missing-rp";
        if (!publicKey.challenge) return "missing-challenge";

        // KeePassXC 2.7.9 always produces a "none" attestation object, even
        // when "direct" attestation is requested. Let Safari handle direct and
        // enterprise attestation instead of returning a credential the site
        // will reject. "indirect" is fine: WebAuthn allows fmt "none" there.
        if (publicKey.attestation === "direct"
            || publicKey.attestation === "enterprise") {
            return "attestation";
        }
        if (hasRequiredExtension(publicKey.extensions)) {
            return "extensions";
        }

        // "hints" only tells the browser which UI to prefer; a local passkey is
        // still a valid answer, so it is ignored rather than losing
        // interception. "attestationFormats" is different: the site asks for a
        // specific statement format, which KeePassXC cannot produce.
        if (Array.isArray(publicKey.attestationFormats)
            && publicKey.attestationFormats.length > 0) {
            return "attestation-formats";
        }

        const params = publicKey.pubKeyCredParams;
        if (!Array.isArray(params) || params.length === 0) return "algorithms";
        const supported = params.some((param) =>
            param?.type === "public-key"
            && SUPPORTED_ALGORITHMS.has(Number(param.alg)));
        if (!supported) return "algorithms";

        const selection = publicKey.authenticatorSelection;
        if (selection) {
            if (selection.authenticatorAttachment !== undefined
                && !ATTACHMENT_VALUES.has(selection.authenticatorAttachment)) {
                return "authenticator-selection";
            }
            if (selection.residentKey !== undefined
                && !RESIDENT_KEY_VALUES.has(selection.residentKey)) {
                return "authenticator-selection";
            }
            if (selection.userVerification !== undefined
                && !USER_VERIFICATION_VALUES.has(selection.userVerification)) {
                return "authenticator-selection";
            }
        }

        const excluded = publicKey.excludeCredentials ?? [];
        if (!Array.isArray(excluded)) return "exclude-credentials";
        if (!excluded.every((credential) => credential?.type === "public-key")) {
            return "exclude-credentials";
        }

        return null;
    }

    function getFallbackReason(options) {
        const publicKey = options?.publicKey;
        if (!publicKey || typeof publicKey !== "object") return "no-public-key";

        if (options.mediation === "conditional" || options.mediation === "silent") {
            return "mediation";
        }
        if (!publicKey.challenge) return "missing-challenge";
        if (hasRequiredExtension(publicKey.extensions)) {
            return "extensions";
        }

        if (publicKey.userVerification !== undefined
            && !USER_VERIFICATION_VALUES.has(publicKey.userVerification)) {
            return "user-verification";
        }

        const allowed = publicKey.allowCredentials ?? [];
        if (!Array.isArray(allowed)) return "allow-credentials";
        if (!allowed.every((credential) => credential?.type === "public-key")) {
            return "allow-credentials";
        }

        return null;
    }

    function supportsCreate(options) {
        return createFallbackReason(options) === null;
    }

    function supportsGet(options) {
        return getFallbackReason(options) === null;
    }

    function noteDecision(kind, reason) {
        try {
            document.documentElement.dataset.kpxcPasskeysLastDecision =
                reason ? `${kind}:safari:${reason}` : `${kind}:keepassxc`;
        } catch {
            // Diagnostics only.
        }
    }

    // -- Errors --

    function passkeyError(code, message) {
        const value = Number(code);
        const text = message || "Passkeys request failed";

        if (value === 27 || value === 28) {
            return new DOMException(text, "SecurityError");
        }
        if (value === 29 || value === 34 || value === 35) {
            return new DOMException(text, "NotSupportedError");
        }
        if (value === 36) {
            return new DOMException(text, "SyntaxError");
        }
        if (value === 32 || value === 33) {
            return new TypeError(text);
        }
        // The WebAuthn spec asks for InvalidStateError when an excluded
        // credential already exists.
        if (value === 21) {
            return new DOMException(text, "InvalidStateError");
        }
        return new DOMException(text, "NotAllowedError");
    }

    function errorFromString(error) {
        const text = String(error ?? "");
        const lower = text.toLowerCase();

        // Native errors carry KeePassXC's numeric code as
        // "keepassxc_error 28: ...". Reuse the same mapping as the inner
        // response errorCode so a top-level protocol error is not downgraded.
        const coded = /keepassxc_error\s+(\d+)/i.exec(text);
        if (coded) {
            return passkeyError(Number(coded[1]), text);
        }

        if (lower.includes("invalid_rp")
            || lower.includes("invalid_origin")
            || lower.includes("security")) {
            return new DOMException(text, "SecurityError");
        }
        if (lower.includes("invalid_challenge") || lower.includes("invalid_user_id")) {
            return new TypeError(text);
        }
        if (lower.includes("unknown_action") || lower.includes("incorrect action")) {
            return new DOMException(text, "NotSupportedError");
        }
        return new DOMException(text || "Passkeys request failed", "NotAllowedError");
    }

    // -- Request/response over DOM events --

    let requestCounter = 0;

    function request(action, publicKey, signal) {
        return new Promise((resolve, reject) => {
            const id = `kpxc-${Date.now()}-${++requestCounter}`;
            const timeout = Math.min(
                140000,
                Math.max(45000, (Number(publicKey.timeout) || 30000) + 15000)
            );

            let settled = false;

            function cleanup() {
                settled = true;
                clearTimeout(timer);
                document.removeEventListener("kpxc-passkeys-response", onResponse);
                signal?.removeEventListener("abort", onAbort);
            }

            function onResponse(event) {
                const detail = event.detail;
                if (!detail || detail.id !== id) return;
                cleanup();

                if (detail.fallback) {
                    resolve({ fallback: true });
                    return;
                }
                if (detail.errorCode !== undefined && detail.errorCode !== null) {
                    reject(passkeyError(detail.errorCode, detail.errorMessage));
                    return;
                }
                if (detail.error) {
                    reject(errorFromString(detail.error));
                    return;
                }
                resolve({ response: detail.response });
            }

            function onAbort() {
                if (settled) return;
                cleanup();
                // Tell the isolated script to drop the pending request and
                // ignore a late native answer.
                document.dispatchEvent(new CustomEvent("kpxc-passkeys-request", {
                    detail: { id, action: "abort" },
                }));
                reject(signal?.reason ?? new DOMException(
                    "The operation was aborted.",
                    "AbortError"
                ));
            }

            const timer = setTimeout(() => {
                if (settled) return;
                cleanup();
                document.dispatchEvent(new CustomEvent("kpxc-passkeys-request", {
                    detail: { id, action: "abort" },
                }));
                reject(new DOMException(
                    "The passkey operation timed out.",
                    "NotAllowedError"
                ));
            }, timeout);

            if (signal?.aborted) {
                onAbort();
                return;
            }
            signal?.addEventListener("abort", onAbort, { once: true });

            document.addEventListener("kpxc-passkeys-response", onResponse);
            document.dispatchEvent(new CustomEvent("kpxc-passkeys-request", {
                detail: { id, action, publicKey },
            }));
        });
    }

    // -- Response reconstruction --

    function buildAttestationResponse(raw) {
        const response = {
            clientDataJSON: fromBase64Url(raw.clientDataJSON),
            attestationObject: fromBase64Url(raw.attestationObject),
            getAuthenticatorData: () =>
                raw.authenticatorData ? fromBase64Url(raw.authenticatorData) : null,
            getPublicKey: () =>
                raw.publicKey ? fromBase64Url(raw.publicKey) : null,
            getPublicKeyAlgorithm: () => Number(raw.publicKeyAlgorithm ?? -7),
            getTransports: () => ["internal"],
        };
        if (raw.clientExtensionResults) {
            response.clientExtensionResults = raw.clientExtensionResults;
        }
        try {
            Object.setPrototypeOf(response, AuthenticatorAttestationResponse.prototype);
        } catch {
            // A plain object still satisfies the page in practice.
        }
        return response;
    }

    function buildAssertionResponse(raw) {
        const response = {
            clientDataJSON: fromBase64Url(raw.clientDataJSON),
            authenticatorData: fromBase64Url(raw.authenticatorData),
            signature: fromBase64Url(raw.signature),
            userHandle: raw.userHandle ? fromBase64Url(raw.userHandle) : null,
        };
        if (raw.clientExtensionResults) {
            response.clientExtensionResults = raw.clientExtensionResults;
        }
        try {
            Object.setPrototypeOf(response, AuthenticatorAssertionResponse.prototype);
        } catch {
            // A plain object still satisfies the page in practice.
        }
        return response;
    }

    function credentialToJSON(credential, raw) {
        const isAttestation = typeof raw.response?.attestationObject === "string";
        return {
            id: credential.id,
            rawId: credential.id,
            type: credential.type,
            authenticatorAttachment: credential.authenticatorAttachment,
            clientExtensionResults: credential.getClientExtensionResults(),
            response: isAttestation ? {
                clientDataJSON: raw.response.clientDataJSON,
                attestationObject: raw.response.attestationObject,
                authenticatorData: raw.response.authenticatorData,
                publicKey: raw.response.publicKey ?? null,
                publicKeyAlgorithm: raw.response.publicKeyAlgorithm ?? -7,
                transports: ["internal"],
            } : {
                clientDataJSON: raw.response.clientDataJSON,
                authenticatorData: raw.response.authenticatorData,
                signature: raw.response.signature,
                userHandle: raw.response.userHandle ?? null,
            },
        };
    }

    function isBase64Url(value) {
        return typeof value === "string"
            && value.length > 0
            && /^[A-Za-z0-9_-]+={0,2}$/.test(value);
    }

    function buildCredential(raw) {
        if (!raw || typeof raw !== "object" || !isBase64Url(raw.id)) {
            throw new DOMException("Invalid passkey response", "NotSupportedError");
        }
        if (!raw.response || typeof raw.response !== "object") {
            throw new DOMException("Invalid passkey response", "NotSupportedError");
        }

        const isAttestation = typeof raw.response.attestationObject === "string";
        // A protocol mismatch must not turn into a credential with empty
        // binary fields: the page would submit it and fail later, possibly
        // retrying registration and creating a duplicate passkey.
        const required = isAttestation
            ? ["clientDataJSON", "attestationObject"]
            : ["clientDataJSON", "authenticatorData", "signature"];
        for (const field of required) {
            if (!isBase64Url(raw.response[field])) {
                throw new DOMException(
                    `Invalid passkey response: missing ${field}`,
                    "NotSupportedError"
                );
            }
        }

        const response = isAttestation
            ? buildAttestationResponse(raw.response)
            : buildAssertionResponse(raw.response);
        const clientExtensionResults =
            response.clientExtensionResults
            ?? raw.response.clientExtensionResults
            ?? {};

        const credential = {
            id: raw.id,
            rawId: fromBase64Url(raw.id),
            response,
            type: raw.type || "public-key",
            authenticatorAttachment: raw.authenticatorAttachment,
            getClientExtensionResults: () => clientExtensionResults,
            toJSON: () => credentialToJSON(credential, raw),
        };

        try {
            Object.setPrototypeOf(credential, PublicKeyCredential.prototype);
        } catch {
            // instanceof checks may fail, but the object is still usable.
        }
        return credential;
    }

    // -- Wrappers --

    async function wrappedCreate(options) {
        if (!options?.publicKey) {
            noteDecision("create", "no-public-key");
            return originalCreate(options);
        }

        if (!settingKnown) await settingReady;

        // Call Safari synchronously: WebAuthn needs the page's transient user
        // activation, and an unnecessary await can put it at risk.
        if (!settingEnabled) {
            noteDecision("create", "disabled");
            return originalCreate(options);
        }
        const reason = createFallbackReason(options);
        if (reason) {
            noteDecision("create", reason);
            return originalCreate(options);
        }

        let publicKey;
        try {
            publicKey = buildCreationOptions(options.publicKey);
        } catch {
            noteDecision("create", "options");
            return originalCreate(options);
        }

        noteDecision("create", null);
        const result = await request("passkeys-register", publicKey, options.signal);
        if (result.fallback) {
            noteDecision("create", "background-fallback");
            return originalCreate(options);
        }
        return buildCredential(result.response);
    }

    async function wrappedGet(options) {
        if (!options?.publicKey) {
            noteDecision("get", "no-public-key");
            return originalGet(options);
        }

        if (!settingKnown) await settingReady;

        if (!settingEnabled) {
            noteDecision("get", "disabled");
            return originalGet(options);
        }
        const reason = getFallbackReason(options);
        if (reason) {
            noteDecision("get", reason);
            return originalGet(options);
        }

        let publicKey;
        try {
            publicKey = buildRequestOptions(options.publicKey);
        } catch {
            noteDecision("get", "options");
            return originalGet(options);
        }

        noteDecision("get", null);
        const result = await request("passkeys-get", publicKey, options.signal);
        if (result.fallback) {
            noteDecision("get", "background-fallback");
            return originalGet(options);
        }
        return buildCredential(result.response);
    }

    try {
        Object.defineProperty(originalContainer, "create", {
            value: wrappedCreate,
            configurable: true,
            writable: true,
        });
        Object.defineProperty(originalContainer, "get", {
            value: wrappedGet,
            configurable: true,
            writable: true,
        });
    } catch {
        // Fall back to a thin wrapper object that keeps every other method
        // bound to the real container.
        try {
            const container = Object.create(originalContainer);
            for (const name of ["store", "preventSilentAccess"]) {
                if (typeof originalContainer[name] === "function") {
                    Object.defineProperty(container, name, {
                        value: originalContainer[name].bind(originalContainer),
                        configurable: true,
                        writable: true,
                    });
                }
            }
            Object.defineProperty(container, "create", {
                value: wrappedCreate,
                configurable: true,
                writable: true,
            });
            Object.defineProperty(container, "get", {
                value: wrappedGet,
                configurable: true,
                writable: true,
            });
            Object.defineProperty(navigator, "credentials", {
                value: container,
                configurable: true,
            });
        } catch {
            // If the page locks the property down, leave Safari untouched.
        }
    }

    // Test hook: only active when a test sets the flag before this script
    // runs. The exposed functions are pure and already live in the page world.
    if (globalThis.__KPXC_PASSKEYS_TEST__ === true) {
        globalThis.__KPXC_PASSKEYS_TEST_API__ = {
            toBase64Url,
            fromBase64Url,
            buildCreationOptions,
            buildRequestOptions,
            buildCredential,
            passkeyError,
            errorFromString,
            supportsCreate,
            supportsGet,
            createFallbackReason,
            getFallbackReason,
            noteDecision,
        };
    }
})();
