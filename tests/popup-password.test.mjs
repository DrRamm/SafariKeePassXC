// Unit tests for the popup's password generator.
//
// Run with: node --test tests/popup-password.test.mjs

import assert from "node:assert";
import test from "node:test";

const moduleUrl = new URL(
    "../SafariKeePassXC Extension/Resources/popup-password.js",
    import.meta.url
);
const { generate, strength, wordList, DEFAULT_OPTIONS } = await import(moduleUrl.href);

test("default options produce a 20 character password", () => {
    const password = generate();
    assert.equal(password.length, 20);
    assert.match(password, /^[A-Za-z0-9!@#$%^&*\-_=+?]+$/);
});

test("length is respected and clamped to 8..64", () => {
    assert.equal(generate({ ...DEFAULT_OPTIONS, length: 32 }).length, 32);
    assert.equal(generate({ ...DEFAULT_OPTIONS, length: 1 }).length, 8);
    assert.equal(generate({ ...DEFAULT_OPTIONS, length: 100 }).length, 64);
});

test("character sets are respected", () => {
    const digitsOnly = generate({
        ...DEFAULT_OPTIONS,
        length: 24,
        upper: false,
        lower: false,
        symbols: false,
        digits: true,
    });
    assert.match(digitsOnly, /^[2-9]+$/);

    const symbolsOnly = generate({
        ...DEFAULT_OPTIONS,
        length: 24,
        upper: false,
        lower: false,
        digits: false,
        symbols: true,
    });
    assert.match(symbolsOnly, /^[!@#$%^&*\-_=+?]+$/);
});

test("an empty character set falls back to lowercase", () => {
    const password = generate({
        ...DEFAULT_OPTIONS,
        length: 24,
        upper: false,
        lower: false,
        digits: false,
        symbols: false,
    });
    assert.match(password, /^[a-z]+$/);
});

test("passphrase mode joins words with hyphens", () => {
    const words = wordList();
    const phrase = generate({ ...DEFAULT_OPTIONS, phrase: true, length: 24 });
    const parts = phrase.split("-");
    assert.equal(parts.length, Math.max(3, Math.round(24 / 6)));
    for (const part of parts) {
        assert.ok(words.includes(part), `unexpected word: ${part}`);
    }
});

test("word list is large enough for passphrases", () => {
    assert.ok(wordList().length >= 32);
    assert.equal(new Set(wordList()).size, wordList().length);
});

test("strength thresholds", () => {
    const weak = strength({ ...DEFAULT_OPTIONS, length: 8, upper: false, lower: true, digits: false, symbols: false });
    assert.equal(weak.score, 1);
    assert.equal(weak.label, "weak");

    const medium = strength({ ...DEFAULT_OPTIONS, length: 12 });
    assert.equal(medium.score, 2);
    assert.equal(medium.label, "medium");

    const strong = strength({ ...DEFAULT_OPTIONS, length: 14 });
    assert.equal(strong.score, 3);
    assert.equal(strong.label, "strong");

    const veryStrong = strength({ ...DEFAULT_OPTIONS, length: 20 });
    assert.equal(veryStrong.score, 4);
    assert.equal(veryStrong.label, "very_strong");
});
