// Locale coverage tests.
//
// The app ships the 40 most widely spoken languages: 40 WebExtension locales in
// `SafariKeePassXC Extension/Resources/_locales/` and the same 40 languages in
// the host window's `Resources/Script.js` dictionary.
//
// Run with: node --test tests/locales.test.mjs

import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const localesDir = new URL(
    "SafariKeePassXC Extension/Resources/_locales/",
    root
);
const scriptUrl = new URL("SafariKeePassXC/Resources/Script.js", root);
const mainHtmlUrl = new URL("SafariKeePassXC/Resources/Base.lproj/Main.html", root);

// ISO 639-1 codes, ordered by number of native speakers (en/de already existed).
const LANGUAGES = [
    "zh", "es", "en", "hi", "ar", "bn", "pt", "ru", "ja", "pa",
    "fr", "de", "tr", "id", "jv", "te", "ur", "vi", "yo", "it",
    "mr", "ta", "gu", "ne", "uz", "kn", "ml", "th", "ko", "fa",
    "am", "uk", "fil", "nl", "pl", "cs", "sv", "el", "he", "ro",
];

const HOST_KEYS = [
    "state_unknown", "state_on", "state_off", "open_preferences",
    "update_available", "update_open_release", "setup_heading",
    "setup_step_keepassxc", "setup_step_unlock", "setup_step_enable",
    "setup_step_connect", "setup_note",
];

const PLACEHOLDER_PATTERN = /\$[A-Z_]+\$/g;

function readLocale(code) {
    return JSON.parse(readFileSync(new URL(`${code}/messages.json`, localesDir), "utf8"));
}

function placeholdersIn(text) {
    return (text.match(PLACEHOLDER_PATTERN) ?? []).sort();
}

const english = readLocale("en");
const englishKeys = Object.keys(english);

test("all 40 locales exist and no unexpected locale folders are present", () => {
    const folders = readdirSync(localesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    assert.deepEqual(folders, [...LANGUAGES].sort());
});

test("every locale has the same keys as English", () => {
    for (const code of LANGUAGES) {
        const messages = readLocale(code);
        assert.deepEqual(
            Object.keys(messages),
            englishKeys,
            `${code}: key set differs from en`
        );
    }
});

test("every locale message is a non-empty string", () => {
    for (const code of LANGUAGES) {
        const messages = readLocale(code);
        for (const [key, entry] of Object.entries(messages)) {
            assert.equal(typeof entry.message, "string", `${code}/${key}: message is not a string`);
            assert.ok(entry.message.trim().length > 0, `${code}/${key}: message is empty`);
            // English is the source of truth and carries the developer-facing
            // descriptions; every other locale only needs message/placeholders.
            if (code !== "en") {
                for (const field of Object.keys(entry)) {
                    assert.ok(
                        field === "message" || field === "placeholders",
                        `${code}/${key}: unexpected field "${field}"`
                    );
                }
            }
        }
    }
});

test("placeholders are preserved exactly", () => {
    for (const code of LANGUAGES) {
        const messages = readLocale(code);
        for (const [key, entry] of Object.entries(messages)) {
            assert.deepEqual(
                placeholdersIn(entry.message),
                placeholdersIn(english[key].message),
                `${code}/${key}: placeholder mismatch`
            );
            assert.deepEqual(
                entry.placeholders,
                english[key].placeholders,
                `${code}/${key}: placeholders object mismatch`
            );
        }
    }
});

test("the product name stays untranslated", () => {
    for (const code of LANGUAGES) {
        assert.equal(readLocale(code).extension_name.message, "SafariKeePassXC Extension", code);
    }
});

// -- Host window -----------------------------------------------------------

function readHostTranslations() {
    const source = readFileSync(scriptUrl, "utf8");
    const marker = "const translations = ";
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, "Script.js: translations object not found");
    const objectStart = source.indexOf("{", start + marker.length);
    let depth = 0;
    let end = -1;
    let inString = false;
    let escaped = false;
    for (let index = objectStart; index < source.length; index += 1) {
        const char = source[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === "{") depth += 1;
        if (char === "}") {
            depth -= 1;
            if (depth === 0) {
                end = index + 1;
                break;
            }
        }
    }
    assert.notEqual(end, -1, "Script.js: translations object is not balanced");
    // The literal is static, developer-controlled data.
    return new Function(`return (${source.slice(objectStart, end)});`)();
}

test("the host window ships the same 40 languages", () => {
    const translations = readHostTranslations();
    assert.deepEqual(Object.keys(translations).sort(), [...LANGUAGES].sort());
});

test("every host language has all host keys", () => {
    const translations = readHostTranslations();
    for (const code of LANGUAGES) {
        assert.deepEqual(
            Object.keys(translations[code]),
            HOST_KEYS,
            `${code}: host key set differs`
        );
        for (const key of HOST_KEYS) {
            assert.ok(
                typeof translations[code][key] === "string" && translations[code][key].trim(),
                `${code}/${key}: host message is empty`
            );
        }
    }
});

test("every data-i18n key in Main.html exists in every host language", () => {
    const html = readFileSync(mainHtmlUrl, "utf8");
    const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(keys.length > 0, "Main.html: no data-i18n attributes found");
    const translations = readHostTranslations();
    for (const code of LANGUAGES) {
        for (const key of keys) {
            assert.ok(translations[code][key], `${code}: missing Main.html key ${key}`);
        }
    }
});
