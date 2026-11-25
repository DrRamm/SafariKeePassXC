// Unit tests for the popup's search filter.
//
// Run with: node --test tests/popup-search.test.mjs

import assert from "node:assert";
import test from "node:test";

const moduleUrl = new URL(
    "../SafariKeePassXC Extension/Resources/popup-search.js",
    import.meta.url
);
const { filterEntries } = await import(moduleUrl.href);

const entries = [
    { uuid: "1", name: "GitHub", login: "octocat", group: "Development", domain: "github.com" },
    { uuid: "2", name: "Example", login: "user@example.com", group: "Hosting", domain: "example.com" },
    { uuid: "3", name: "Bank", login: "+1 555", group: "Finance", domain: "bank.example.com" },
];

test("an empty query returns every entry", () => {
    assert.deepEqual(filterEntries(entries, "").map((entry) => entry.uuid), ["1", "2", "3"]);
    assert.deepEqual(filterEntries(entries, "   ").map((entry) => entry.uuid), ["1", "2", "3"]);
});

test("matches name, login, group and domain case-insensitively", () => {
    assert.deepEqual(filterEntries(entries, "github").map((entry) => entry.uuid), ["1"]);
    assert.deepEqual(filterEntries(entries, "OCTOCAT").map((entry) => entry.uuid), ["1"]);
    assert.deepEqual(filterEntries(entries, "hosting").map((entry) => entry.uuid), ["2"]);
    assert.deepEqual(filterEntries(entries, "example.com").map((entry) => entry.uuid), ["2", "3"]);
});

test("returns no matches for an unknown query", () => {
    assert.deepEqual(filterEntries(entries, "nothing"), []);
});

test("tolerates missing fields and a non-array input", () => {
    assert.deepEqual(filterEntries([{ uuid: "4", name: "Only name" }], "only"), [{ uuid: "4", name: "Only name" }]);
    assert.deepEqual(filterEntries(null, "x"), []);
    assert.deepEqual(filterEntries(entries, null).length, 3);
});
