// Node unit tests for the page-world WebAuthn adapter.
//
// passkeys-page.js is a classic script (no exports), so it is evaluated in a
// VM with the minimal browser surface it touches. The adapter exposes its pure
// helpers only when __KPXC_PASSKEYS_TEST__ is set before it runs.
//
// Run with: node --test tests/passkeys-page.test.mjs

import assert from "node:assert";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const source = fs.readFileSync(
    new URL("SafariKeePassXC Extension/Resources/passkeys-page.js", root),
    "utf8"
);

function fixture(name) {
    return JSON.parse(
        fs.readFileSync(
            new URL(`tests/fixtures/${name}`, root),
            "utf8"
        )
    );
}

function loadAdapter() {
    const context = {
        __KPXC_PASSKEYS_TEST__: true,
        document: {
            addEventListener() {},
            dispatchEvent() {},
            documentElement: { dataset: {} },
        },
        navigator: {
            credentials: {
                create: async () => null,
                get: async () => null,
                store: async () => null,
                preventSilentAccess: async () => {},
            },
        },
        CustomEvent: class CustomEvent {
            constructor(type, init) {
                this.type = type;
                this.detail = init?.detail;
            }
        },
        PublicKeyCredential: class PublicKeyCredential {},
        AuthenticatorAttestationResponse: class AuthenticatorAttestationResponse {},
        AuthenticatorAssertionResponse: class AuthenticatorAssertionResponse {},
        DOMException,
        TypeError,
        ArrayBuffer,
        Uint8Array,
        DataView,
        btoa,
        atob,
        setTimeout: () => 0,
        clearTimeout: () => {},
        console,
    };
    context.window = context;
    context.window.top = context.window;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: "passkeys-page.js" });
    return context;
}

const context = loadAdapter();
const api = context.__KPXC_PASSKEYS_TEST_API__;

function bytes(value) {
    return Array.from(new context.Uint8Array(value));
}

test("adapter exposes its test API", () => {
    assert.ok(api);
    assert.equal(typeof api.buildCredential, "function");
});

test("BufferSource serialization respects byteOffset and byteLength", () => {
    const backing = new context.Uint8Array([0, 1, 2, 3, 4]);
    const view = new context.Uint8Array(backing.buffer, 1, 3);

    assert.equal(api.toBase64Url(view), "AQID");
    assert.equal(api.toBase64Url(new context.Uint8Array([1, 2, 3]).buffer), "AQID");
    assert.deepEqual(bytes(api.fromBase64Url("AQID")), [1, 2, 3]);
});

test("fromBase64Url rejects non-strings instead of returning empty buffers", () => {
    assert.throws(() => api.fromBase64Url(undefined), TypeError);
    assert.throws(() => api.fromBase64Url(""), TypeError);
});

test("registration response is reconstructed from the pinned fixture", () => {
    const register = fixture("passkeys-register-response.json").response;
    const credential = api.buildCredential(register);

    assert.equal(credential.id, "AQIDBA");
    assert.equal(credential.type, "public-key");
    assert.deepEqual(bytes(credential.rawId), [1, 2, 3, 4]);
    assert.equal(credential.authenticatorAttachment, "platform");
    assert.deepEqual(
        bytes(credential.response.attestationObject),
        bytes(api.fromBase64Url(register.response.attestationObject))
    );
    assert.deepEqual(
        bytes(credential.response.clientDataJSON),
        bytes(api.fromBase64Url(register.response.clientDataJSON))
    );
    assert.deepEqual(credential.response.getTransports(), ["internal"]);
    assert.equal(credential.response.getPublicKeyAlgorithm(), -7);
    assert.equal(credential.response.getPublicKey(), null);
    assert.deepEqual(credential.getClientExtensionResults(), {
        credProps: { rk: true },
    });

    const json = credential.toJSON();
    assert.equal(json.id, "AQIDBA");
    assert.equal(json.rawId, "AQIDBA");
    assert.equal(json.response.attestationObject, register.response.attestationObject);
    assert.deepEqual(json.response.transports, ["internal"]);
    assert.deepEqual(json.clientExtensionResults, { credProps: { rk: true } });
});

test("authentication response is reconstructed from the pinned fixture", () => {
    const get = fixture("passkeys-get-response.json").response;
    const credential = api.buildCredential(get);

    assert.equal(credential.id, "AQIDBA");
    assert.deepEqual(bytes(credential.rawId), [1, 2, 3, 4]);
    assert.deepEqual(bytes(credential.response.signature), bytes(api.fromBase64Url(get.response.signature)));
    assert.deepEqual(bytes(credential.response.userHandle), [1, 2]);

    const json = credential.toJSON();
    assert.equal(json.response.signature, get.response.signature);
    assert.equal(json.response.userHandle, "AQI");
    assert.equal(json.response.attestationObject, undefined);
});

test("assertion without userHandle yields null", () => {
    const get = fixture("passkeys-get-response.json").response;
    const credential = api.buildCredential({
        ...get,
        response: { ...get.response, userHandle: undefined },
    });
    assert.equal(credential.response.userHandle, null);
    assert.equal(credential.toJSON().response.userHandle, null);
});

test("malformed binary fields fail with NotSupportedError, not an empty credential", () => {
    assert.throws(
        () => api.buildCredential({
            id: "AQID",
            response: { clientDataJSON: "e30", attestationObject: "" },
        }),
        (error) => error.name === "NotSupportedError"
    );
    assert.throws(
        () => api.buildCredential({
            id: "AQID",
            response: { clientDataJSON: "e30", authenticatorData: "", signature: "AQID" },
        }),
        (error) => error.name === "NotSupportedError"
    );
    assert.throws(
        () => api.buildCredential({
            id: "not base64!",
            response: { clientDataJSON: "e30", attestationObject: "o2NmbXRkbm9uZQ" },
        }),
        (error) => error.name === "NotSupportedError"
    );
});

test("KeePassXC error codes map to the specified DOMException types", () => {
    const expected = {
        15: "NotAllowedError",
        20: "NotAllowedError",
        21: "InvalidStateError",
        22: "NotAllowedError",
        27: "SecurityError",
        28: "SecurityError",
        29: "NotSupportedError",
        32: "TypeError",
        33: "TypeError",
        34: "NotSupportedError",
        35: "NotSupportedError",
        36: "SyntaxError",
    };
    for (const [code, name] of Object.entries(expected)) {
        assert.equal(api.passkeyError(Number(code)).name, name, `code ${code}`);
    }
});

test("top-level protocol errors recover the KeePassXC code", () => {
    assert.equal(
        api.errorFromString("keepassxc_error 21: Credential is excluded").name,
        "InvalidStateError"
    );
    assert.equal(
        api.errorFromString("keepassxc_error 28: Origin and RP ID do not match").name,
        "SecurityError"
    );
    assert.equal(api.errorFromString("invalid_rp_id").name, "SecurityError");
    assert.equal(api.errorFromString("not_associated").name, "NotAllowedError");
});

test("unsupported options fall back to Safari", () => {
    const challenge = new context.Uint8Array(16);
    const create = {
        publicKey: {
            challenge,
            rp: { id: "example.com", name: "Example" },
            user: { id: new context.Uint8Array([1]), name: "a", displayName: "A" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        },
    };
    assert.equal(api.supportsCreate(create), true);
    assert.equal(api.supportsCreate({ ...create, publicKey: { ...create.publicKey, attestation: "direct" } }), false);
    assert.equal(api.supportsCreate({ ...create, publicKey: { ...create.publicKey, attestation: "indirect" } }), true);
    // Optional extensions are ignored, not a reason to hand the call to Safari.
    assert.equal(api.supportsCreate({ ...create, publicKey: { ...create.publicKey, extensions: { prf: {} } } }), true);
    assert.equal(api.supportsCreate({ ...create, publicKey: { ...create.publicKey, extensions: { largeBlob: { support: "required" } } } }), false);
    assert.equal(api.supportsCreate({ ...create, publicKey: { ...create.publicKey, pubKeyCredParams: [{ type: "public-key", alg: -35 }] } }), false);

    const get = {
        publicKey: {
            challenge,
            allowCredentials: [{ type: "public-key", id: new context.Uint8Array([1]) }],
        },
    };
    assert.equal(api.supportsGet(get), true);
    assert.equal(api.supportsGet({ ...get, mediation: "conditional" }), false);
    assert.equal(api.supportsGet({ ...get, mediation: "silent" }), false);
    assert.equal(api.supportsGet({ ...get, publicKey: { ...get.publicKey, extensions: { prf: {} } } }), true);
    assert.equal(api.supportsGet({ ...get, publicKey: { ...get.publicKey, extensions: { largeBlob: { support: "required" } } } }), false);
});

test("hints are advisory and do not disable interception", () => {
    const challenge = new context.Uint8Array(16);
    const create = {
        publicKey: {
            challenge,
            rp: { id: "example.com", name: "Example" },
            user: { id: new context.Uint8Array([1]), name: "a", displayName: "A" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            hints: ["client-device"],
        },
    };
    assert.equal(api.supportsCreate(create), true);

    const get = {
        publicKey: { challenge, hints: ["hybrid"] },
    };
    assert.equal(api.supportsGet(get), true);
});

test("fallback reasons are reported for diagnostics", () => {
    const challenge = new context.Uint8Array(16);
    const create = {
        publicKey: {
            challenge,
            rp: { id: "example.com", name: "Example" },
            user: { id: new context.Uint8Array([1]), name: "a", displayName: "A" },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        },
    };
    assert.equal(api.createFallbackReason(create), null);
    assert.equal(
        api.createFallbackReason({ ...create, publicKey: { ...create.publicKey, attestation: "direct" } }),
        "attestation"
    );
    assert.equal(
        api.getFallbackReason({ publicKey: { challenge }, mediation: "conditional" }),
        "mediation"
    );
});

test("decision diagnostics use the kind:safari:reason format", () => {
    api.noteDecision("create", null);
    assert.equal(context.document.documentElement.dataset.kpxcPasskeysLastDecision, "create:keepassxc");

    api.noteDecision("get", "mediation");
    assert.equal(context.document.documentElement.dataset.kpxcPasskeysLastDecision, "get:safari:mediation");

    api.noteDecision("create", "background-fallback");
    assert.equal(
        context.document.documentElement.dataset.kpxcPasskeysLastDecision,
        "create:safari:background-fallback"
    );
});

test("creation options serialize views and defaults", () => {
    const backing = new context.Uint8Array([0, 1, 2, 3, 4]);
    const view = new context.Uint8Array(backing.buffer, 1, 3);
    const options = api.buildCreationOptions({
        challenge: view,
        rp: { id: "example.com", name: "Example" },
        user: { id: new context.Uint8Array([1, 2]), name: "alice", displayName: "Alice" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        excludeCredentials: [{ type: "public-key", id: view, transports: ["internal"] }],
    });

    assert.equal(options.challenge, "AQID");
    assert.equal(options.user.id, "AQI");
    assert.equal(options.excludeCredentials[0].id, "AQID");
    assert.equal(options.timeout, 30000);
    assert.deepEqual(options.pubKeyCredParams, [{ type: "public-key", alg: -7 }]);
});

test("request options serialize views and append the internal transport", () => {
    const backing = new context.Uint8Array([0, 1, 2, 3, 4]);
    const view = new context.Uint8Array(backing.buffer, 1, 3);
    const options = api.buildRequestOptions({
        challenge: view,
        rpId: "example.com",
        allowCredentials: [{ type: "public-key", id: view, transports: ["usb"] }],
    });

    assert.equal(options.challenge, "AQID");
    assert.equal(options.enterpriseAttestationPossible, false);
    assert.deepEqual(options.allowCredentials[0].transports, ["usb", "internal"]);
});
