// Node unit tests for the security-critical parts of background.js.
//
// Run with: node --test tests/passkeys-background.test.mjs

import assert from "node:assert/strict";
import test from "node:test";

// background.js registers a runtime listener at import time. A minimal stub is
// enough; the tests only call the exported pure helpers.
globalThis.browser = {
    runtime: {
        onMessage: { addListener() {} },
        sendNativeMessage: async () => ({ success: true }),
    },
    storage: {
        local: { get: async () => ({}) },
        onChanged: { addListener() {} },
    },
};

const backgroundURL = new URL(
    "../SafariKeePassXC Extension/Resources/background.js",
    import.meta.url
);
const { __test } = await import(backgroundURL.href);

const { isPublicSuffix, validateRpId, validatePublicKey, base64UrlByteLength } = __test;

function base64url(bytes) {
    return Buffer.from(bytes).toString("base64url");
}

const challenge = base64url(new Uint8Array(16));

test("base64UrlByteLength counts decoded bytes", () => {
    assert.equal(base64UrlByteLength(challenge), 16);
    assert.equal(base64UrlByteLength(""), -1);
    assert.equal(base64UrlByteLength("not base64!"), -1);
});

test("public suffixes include ICANN and private entries", () => {
    assert.equal(isPublicSuffix("com"), true);
    assert.equal(isPublicSuffix("co.uk"), true);
    assert.equal(isPublicSuffix("github.io"), true);
    assert.equal(isPublicSuffix("example.com"), false);
    assert.equal(isPublicSuffix("example.co.uk"), false);
    assert.equal(isPublicSuffix("foo.github.io"), false);
});

test("wildcard and exception public suffix rules", () => {
    assert.equal(isPublicSuffix("ck"), true);
    assert.equal(isPublicSuffix("foo.ck"), true);
    assert.equal(isPublicSuffix("www.ck"), false);
    // A "*.ck" rule makes foo.ck a public suffix, not bar.foo.ck.
    assert.equal(isPublicSuffix("bar.foo.ck"), false);
    assert.equal(isPublicSuffix("a.b.foo.ck"), false);
});

test("RP ID must be a registrable domain suffix of the origin host", () => {
    assert.equal(validateRpId("example.com", "login.example.com"), true);
    assert.equal(validateRpId("example.com", "example.com"), true);
    assert.equal(validateRpId("login.example.com", "example.com"), false);
    assert.equal(validateRpId("evil.com", "login.example.com"), false);
    assert.equal(validateRpId("example.com", "example.com.evil.com"), false);
});

test("RP ID must not be a public suffix", () => {
    assert.equal(validateRpId("com", "login.example.com"), false);
    assert.equal(validateRpId("co.uk", "login.example.co.uk"), false);
    assert.equal(validateRpId("example.co.uk", "login.example.co.uk"), true);
    assert.equal(validateRpId("github.io", "user.github.io"), false);
    assert.equal(validateRpId("foo.ck", "bar.foo.ck"), false);
    assert.equal(validateRpId("bar.foo.ck", "bar.foo.ck"), true);
});

test("RP ID rejects IP addresses, ports and malformed names", () => {
    assert.equal(validateRpId("127.0.0.1", "127.0.0.1"), false);
    assert.equal(validateRpId("example.com:443", "example.com"), false);
    assert.equal(validateRpId("example..com", "example.com"), false);
    assert.equal(validateRpId("-example.com", "-example.com"), false);
});

test("localhost is a special case", () => {
    assert.equal(validateRpId("localhost", "localhost"), true);
    assert.equal(validateRpId("localhost", "app.localhost"), true);
    assert.equal(validateRpId("localhost", "example.com"), false);
});

test("registration public key validation", () => {
    const valid = {
        challenge,
        rp: { id: "example.com", name: "Example" },
        user: { id: base64url(new Uint8Array([1, 2])), name: "alice", displayName: "Alice" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        excludeCredentials: [],
    };
    assert.deepEqual(validatePublicKey("passkeys-register", valid, "login.example.com"), {
        ok: true,
        rpId: "example.com",
    });

    assert.equal(
        validatePublicKey("passkeys-register", { ...valid, challenge: base64url(new Uint8Array(8)) }, "login.example.com").error,
        "invalid_challenge"
    );
    assert.equal(
        validatePublicKey("passkeys-register", { ...valid, user: { id: "" } }, "login.example.com").error,
        "invalid_user_id"
    );
    assert.equal(
        validatePublicKey("passkeys-register", { ...valid, pubKeyCredParams: [] }, "login.example.com").error,
        "invalid_algorithms"
    );
});

test("registration defaults RP ID to the origin host", () => {
    const publicKey = {
        challenge,
        user: { id: base64url(new Uint8Array([1])), name: "a", displayName: "A" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    };
    assert.deepEqual(validatePublicKey("passkeys-register", publicKey, "login.example.com"), {
        ok: true,
        rpId: "login.example.com",
    });
});

test("authentication public key validation", () => {
    const credentialId = base64url(new Uint8Array([9, 9, 9]));
    const valid = {
        challenge,
        rpId: "example.com",
        allowCredentials: [{ id: credentialId, type: "public-key" }],
    };
    assert.deepEqual(validatePublicKey("passkeys-get", valid, "login.example.com"), {
        ok: true,
        rpId: "example.com",
    });

    assert.equal(
        validatePublicKey("passkeys-get", { ...valid, rpId: 42 }, "login.example.com").error,
        "invalid_rp_id"
    );
    assert.equal(
        validatePublicKey("passkeys-get", { ...valid, allowCredentials: [{ id: "" }] }, "login.example.com").error,
        "invalid_allow_credentials"
    );
});

test("passkey messages require a tab, HTTPS and the top frame", async () => {
    const originalGet = globalThis.browser.storage.local.get;
    globalThis.browser.storage.local.get = async () => ({ passkeysEnabled: true });
    try {
        const message = {
            action: "passkeys-get",
            id: "frame-test",
            publicKey: {
                challenge,
                rpId: "example.com",
                allowCredentials: [],
            },
        };

        const topFrame = {
            tab: { id: 1, url: "https://login.example.com" },
            url: "https://login.example.com",
            frameId: undefined,
        };
        assert.equal((await __test.handlePasskeyMessage(message, topFrame)).success, true);

        assert.equal(
            (await __test.handlePasskeyMessage(message, {
                ...topFrame,
                url: "https://other.example.com",
            })).error,
            "not_top_frame"
        );
        assert.equal(
            (await __test.handlePasskeyMessage(message, {
                ...topFrame,
                frameId: 1,
            })).error,
            "not_top_frame"
        );
        assert.equal(
            (await __test.handlePasskeyMessage(message, {
                ...topFrame,
                url: "http://login.example.com",
                tab: { id: 1, url: "http://login.example.com" },
            })).error,
            "insecure_origin"
        );
        assert.equal(
            (await __test.handlePasskeyMessage(message, { url: topFrame.url })).error,
            "no_tab"
        );
    } finally {
        globalThis.browser.storage.local.get = originalGet;
    }
});
