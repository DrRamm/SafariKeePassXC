// Node unit tests for the isolated passkeys content script.
//
// passkeys-content.js is a classic IIFE, so it is evaluated in a VM with a
// minimal DOM/browser surface. The tests drive the DOM events it listens to
// and inspect the events and runtime messages it produces.
//
// Run with: node --test tests/passkeys-content.test.mjs

import assert from "node:assert";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const source = fs.readFileSync(
    new URL("SafariKeePassXC Extension/Resources/passkeys-content.js", root),
    "utf8"
);

const CHALLENGE = "AAAAAAAAAAAAAAAAAAAAAA";

function tick() {
    return new Promise((resolve) => setImmediate(resolve));
}

function loadContent() {
    const events = [];
    const listeners = new Map();
    const messages = [];
    const requests = [];
    const timers = [];
    let nextTimerId = 1;

    function setTimeoutFake(fn, ms) {
        const timer = { id: nextTimerId++, fn, ms, cancelled: false };
        timers.push(timer);
        return timer.id;
    }

    function clearTimeoutFake(id) {
        const timer = timers.find((candidate) => candidate.id === id);
        if (timer) timer.cancelled = true;
    }

    const context = {
        document: {
            addEventListener(type, listener) {
                listeners.set(`document:${type}`, listener);
            },
            dispatchEvent(event) {
                events.push(event);
            },
        },
        window: {
            addEventListener(type, listener) {
                listeners.set(`window:${type}`, listener);
            },
        },
        browser: {
            runtime: {
                sendMessage(message) {
                    messages.push(message);
                    return new Promise((resolve, reject) => {
                        requests.push({ resolve, reject });
                    });
                },
            },
            storage: {
                local: {
                    async get() {
                        return { passkeysEnabled: true };
                    },
                },
                onChanged: { addListener() {} },
            },
        },
        CustomEvent: class CustomEvent {
            constructor(type, init) {
                this.type = type;
                this.detail = init?.detail;
            }
        },
        setTimeout: setTimeoutFake,
        clearTimeout: clearTimeoutFake,
        console,
    };
    context.window.top = context.window;

    vm.createContext(context);
    vm.runInContext(source, context, { filename: "passkeys-content.js" });

    function dispatch(type, detail) {
        const listener = listeners.get(`document:${type}`);
        assert.ok(listener, `no listener for ${type}`);
        listener({ detail });
    }

    function responses(id) {
        return events.filter(
            (event) => event.type === "kpxc-passkeys-response"
                && (id === undefined || event.detail?.id === id)
        );
    }

    return {
        context,
        events,
        listeners,
        messages,
        requests,
        timers,
        dispatch,
        responses,
        runLastTimer() {
            const timer = timers[timers.length - 1];
            assert.ok(timer, "no timer scheduled");
            assert.equal(timer.cancelled, false);
            timer.cancelled = true;
            timer.fn();
        },
        pagehide() {
            listeners.get("window:pagehide")?.();
        },
    };
}

function request(id = "req-1", action = "passkeys-get") {
    return {
        id,
        action,
        publicKey: {
            challenge: CHALLENGE,
            rpId: "example.com",
            allowCredentials: [{ id: "AQID", type: "public-key" }],
        },
    };
}

test("publishes the stored setting", async () => {
    const content = loadContent();
    await tick();

    const setting = content.events.find((event) => event.type === "kpxc-passkeys-setting");
    assert.ok(setting);
    assert.equal(setting.detail.enabled, true);
});

test("forwards only registration and authentication", async () => {
    const content = loadContent();
    await tick();

    content.dispatch("kpxc-passkeys-request", { ...request(), action: "get-logins" });
    assert.equal(content.messages.length, 0);

    content.dispatch("kpxc-passkeys-request", request());
    assert.equal(content.messages.length, 1);
    assert.equal(content.messages[0].action, "passkeys-get");
    assert.equal(content.messages[0].publicKey.challenge, CHALLENGE);
});

test("relays a successful credential response to the same id", async () => {
    const content = loadContent();
    await tick();

    content.dispatch("kpxc-passkeys-request", request("req-ok"));
    content.requests[0].resolve({
        success: true,
        result: { response: { id: "AQIDBA", type: "public-key", response: {} } },
    });
    await tick();

    const [response] = content.responses("req-ok");
    assert.ok(response);
    assert.equal(response.detail.response.id, "AQIDBA");
});

test("surfaces an inner KeePassXC errorCode", async () => {
    const content = loadContent();
    await tick();

    content.dispatch("kpxc-passkeys-request", request("req-excluded"));
    content.requests[0].resolve({
        success: true,
        result: { response: { errorCode: 21 } },
    });
    await tick();

    const [response] = content.responses("req-excluded");
    assert.equal(response.detail.errorCode, 21);
});

test("relays the disabled setting as a fallback", async () => {
    const content = loadContent();
    await tick();

    content.dispatch("kpxc-passkeys-request", request("req-off"));
    content.requests[0].resolve({
        success: false,
        error: "passkeys_disabled",
        fallback: true,
    });
    await tick();

    const [response] = content.responses("req-off");
    assert.equal(response.detail.fallback, true);
});

test("abort frees the request and drops the late native answer", async () => {
    const content = loadContent();
    await tick();

    content.dispatch("kpxc-passkeys-request", request("req-abort"));
    content.dispatch("kpxc-passkeys-request", { action: "abort", id: "req-abort" });

    const [aborted] = content.responses("req-abort");
    assert.equal(aborted.detail.errorCode, "abort");

    content.requests[0].resolve({
        success: true,
        result: { response: { id: "late" } },
    });
    await tick();

    assert.equal(content.responses("req-abort").length, 1);
});

test("timeout frees the request and drops the late native answer", async () => {
    const content = loadContent();
    await tick();

    content.dispatch("kpxc-passkeys-request", request("req-timeout"));
    content.runLastTimer();

    const [timedOut] = content.responses("req-timeout");
    assert.equal(timedOut.detail.errorCode, "timeout");

    content.requests[0].resolve({
        success: true,
        result: { response: { id: "late" } },
    });
    await tick();

    assert.equal(content.responses("req-timeout").length, 1);
});

test("pagehide frees pending requests and drops late answers", async () => {
    const content = loadContent();
    await tick();

    content.dispatch("kpxc-passkeys-request", request("req-nav"));
    content.pagehide();

    content.requests[0].resolve({
        success: true,
        result: { response: { id: "late" } },
    });
    await tick();

    assert.equal(content.responses("req-nav").length, 0);
});

test("rejects malformed requests without contacting the background", async () => {
    const content = loadContent();
    await tick();

    content.dispatch("kpxc-passkeys-request", {
        id: "bad",
        action: "passkeys-get",
        publicKey: {},
    });
    content.dispatch("kpxc-passkeys-request", {
        id: "bad-action",
        action: "passkeys-create",
        publicKey: { challenge: CHALLENGE },
    });
    content.dispatch("kpxc-passkeys-request", {
        id: "x".repeat(200),
        action: "passkeys-get",
        publicKey: { challenge: CHALLENGE },
    });

    assert.equal(content.messages.length, 0);
});
