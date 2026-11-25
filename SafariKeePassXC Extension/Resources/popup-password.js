// Pure password generation and strength estimation.
//
// Ported from the design's `password.ts` so it can be unit-tested in Node and
// reused by the popup. No DOM access: only `crypto.getRandomValues`.

const WORDS = [
    "glacier", "sail", "coffee", "orbit", "beacon", "north", "key", "fog",
    "amber", "cedar", "wave", "dawn", "river", "stone", "maple", "cloud",
    "harbor", "meadow", "silver", "thunder", "violet", "canyon", "falcon",
    "garden", "ember", "island", "jacket", "kettle", "lantern", "marble",
    "needle", "ocean", "pepper", "quartz", "rocket", "saddle", "timber",
    "umbrella", "velvet", "walnut", "yellow", "zephyr", "anchor", "basket",
    "copper", "dolphin", "eagle", "forest", "guitar", "hammer", "indigo",
    "jungle", "kitten", "lemon", "magnet", "nickel", "olive", "pencil",
    "rabbit", "sunset", "tiger", "urban", "vapor", "willow",
];

export const DEFAULT_OPTIONS = Object.freeze({
    length: 20,
    upper: true,
    lower: true,
    digits: true,
    symbols: true,
    phrase: false,
});

const MIN_LENGTH = 8;
const MAX_LENGTH = 64;

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function randomInt(maximum) {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] % maximum;
}

function optionsWithDefaults(options) {
    return { ...DEFAULT_OPTIONS, ...(options ?? {}) };
}

export function wordList() {
    return WORDS.slice();
}

export function generate(options) {
    const opts = optionsWithDefaults(options);
    const length = clamp(Math.round(Number(opts.length) || DEFAULT_OPTIONS.length), MIN_LENGTH, MAX_LENGTH);

    if (opts.phrase) {
        const count = Math.max(3, Math.round(length / 6));
        return Array.from({ length: count }, () => WORDS[randomInt(WORDS.length)]).join("-");
    }

    let set = "";
    if (opts.upper) set += "ABCDEFGHJKLMNPQRSTUVWXYZ";
    if (opts.lower) set += "abcdefghijkmnopqrstuvwxyz";
    if (opts.digits) set += "23456789";
    if (opts.symbols) set += "!@#$%^&*-_=+?";
    if (!set) set = "abcdefghijkmnopqrstuvwxyz";

    return Array.from({ length }, () => set[randomInt(set.length)]).join("");
}

// Returns a score (1-4) and a stable label key. The popup maps the label to a
// localized string (`generator_strength_<label>`).
export function strength(options) {
    const opts = optionsWithDefaults(options);
    let bits;

    if (opts.phrase) {
        const count = Math.max(3, Math.round((Number(opts.length) || DEFAULT_OPTIONS.length) / 6));
        bits = count * Math.log2(WORDS.length);
    } else {
        const pool =
            (opts.upper ? 24 : 0) +
            (opts.lower ? 25 : 0) +
            (opts.digits ? 8 : 0) +
            (opts.symbols ? 13 : 0) || 25;
        bits = (Number(opts.length) || DEFAULT_OPTIONS.length) * Math.log2(pool);
    }

    if (bits < 50) return { score: 1, label: "weak" };
    if (bits < 80) return { score: 2, label: "medium" };
    if (bits < 110) return { score: 3, label: "strong" };
    return { score: 4, label: "very_strong" };
}
