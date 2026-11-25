// Popup UI — Liquid Glass design ported to vanilla JS.
//
// Screens: home, settings, generator, search. Data comes from the native
// bridge through background.js. Passwords are never rendered on home/search;
// only the client-generated password is shown in the generator.

import { generate, strength } from "./popup-password.js";
import { filterEntries } from "./popup-search.js";

const $ = (id) => document.getElementById(id);

const PASSKEYS_MIN_VERSION = [2, 7, 7];
const RING = 2 * Math.PI * 7.5;

const ICONS = {
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"></path><path d="M2 12h20"></path></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>',
    power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"></path><path d="M18.4 6.6a9 9 0 1 1-12.77.04"></path></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"></path><path d="M15 7h2a5 5 0 1 1 0 10h-2"></path><line x1="8" x2="16" y1="12" y2="12"></line></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>',
};

const SCREEN_TITLES = {
    settings: "screen_settings_title",
    generator: "screen_generator_title",
    search: "screen_search_title",
};

const SCREENS = ["home", "settings", "generator", "search"];

const ERROR_STATES = {
    offline: { icon: "power", title: "status_offline", text: "error_offline_hint", button: "button_retry", action: "retry" },
    locked: { icon: "lock", title: "status_locked", text: "error_locked_hint", button: "button_unlock_in_keepassxc", action: "retry" },
    unpaired: { icon: "link", title: "error_pairing_required", text: "error_unpaired_hint", button: "button_pair", action: "pair" },
};

const generatorOptions = {
    length: 20,
    upper: true,
    lower: true,
    digits: true,
    symbols: true,
    phrase: false,
};

let requestId = 0;
let appState = "ok";
let screen = "home";
let pageEntries = [];
let pageDomain = "";
let statusResult = null;
let currentPassword = "";
let totpChips = [];
let totpTimer = null;
let totpRefreshing = false;
let lastTotpPeriod = null;
let toastTimer = null;
let screenTransition = 0;

// -- Helpers --

function api(message) {
    return browser.runtime.sendMessage({ id: ++requestId, ...message });
}

function t(key, substitutions) {
    return browser.i18n.getMessage(key, substitutions) || key;
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function localizeDocument() {
    // The WebExtension runtime already picks the best matching locale from
    // _locales for browser.i18n. Mirror that choice on the document so the
    // page reports the right language (and direction) to assistive tech.
    const uiLanguage = (browser.i18n.getUILanguage?.() || navigator.language || "en").toLowerCase();
    document.documentElement.lang = uiLanguage;
    document.documentElement.dir = /^(ar|fa|he|ur)$/.test(uiLanguage.split(/[-_]/)[0]) ? "rtl" : "ltr";

    for (const element of document.querySelectorAll("[data-i18n]")) {
        element.textContent = t(element.dataset.i18n);
    }
    for (const element of document.querySelectorAll("[data-i18n-aria]")) {
        const label = t(element.dataset.i18nAria);
        element.setAttribute("aria-label", label);
        element.title = label;
    }
    for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
        element.placeholder = t(element.dataset.i18nPlaceholder);
    }
}

function toast(message) {
    $("toast-text").textContent = message;
    $("toast").classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 1800);
}

function friendlyError(error) {
    const text = (error ?? "").toLowerCase();
    if (text.includes("host_app_not_running")) return t("error_host_app_not_running");
    if (text.includes("keepassxc_not_reachable")) return t("error_keepassxc_not_reachable");
    if (text.includes("database not opened") || text.includes("database is not opened")) {
        return t("error_database_locked");
    }
    if (text.includes("not_associated")) return t("error_not_associated");
    return t("error_generic", [error ?? t("error_unknown")]);
}

function isNoLoginsFound(error) {
    return (error ?? "").toLowerCase().includes("keepassxc_error 15");
}

function isLockedError(error) {
    const text = (error ?? "").toLowerCase();
    return text.includes("locked") || text.includes("not opened") || text.includes("not open");
}

function hostOf(url) {
    try {
        return new URL(url).hostname;
    } catch {
        return "";
    }
}

async function activeTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
}

function versionAtLeast(version, minimum) {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(version ?? ""));
    if (!match) return false;
    const parts = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
    for (let index = 0; index < minimum.length; index += 1) {
        if (parts[index] > minimum[index]) return true;
        if (parts[index] < minimum[index]) return false;
    }
    return true;
}

// -- Status --

function stateFromStatus(result) {
    if (!result || !result.connected) return "offline";
    if (isLockedError(result.error)) return "locked";
    if (!result.associated) return "unpaired";
    return "ok";
}

function renderStatus() {
    const version = statusResult?.keePassXCVersion ?? "";
    const dot = $("status-dot");
    const text = $("status-text");

    dot.className = "dot";
    if (appState === "ok") {
        dot.classList.add("success");
        text.textContent = version
            ? t("status_connected_short", [version])
            : t("toast_connected");
    } else if (appState === "locked") {
        dot.classList.add("warning");
        text.textContent = t("status_locked");
    } else if (appState === "unpaired") {
        dot.classList.add("warning");
        text.textContent = t("status_unpaired");
    } else {
        dot.classList.add("destructive");
        text.textContent = t("status_offline");
    }

    const blocked = appState !== "ok";
    $("nav-search").disabled = blocked;
    $("nav-generator").disabled = blocked;
}

// -- Screens --

function setScreen(name) {
    if (appState !== "ok" && name !== "settings") name = "home";
    const previous = screen;
    const animate = previous !== name;
    screen = name;

    const content = $("content");
    const from = $("screen-" + previous);
    const to = $("screen-" + name);

    if (animate) {
        // Freeze the current height before the screens leave the flow, so the
        // panel can animate to the incoming screen's height.
        content.style.height = `${content.offsetHeight}px`;
    }

    for (const id of SCREENS) {
        const element = $("screen-" + id);
        const visible = id === name || (animate && id === previous);
        element.hidden = !visible;
        if (!visible) {
            element.classList.remove(
                "animating", "enter-forward", "enter-back", "exit-forward", "exit-back"
            );
            element.inert = false;
            element.removeAttribute("aria-hidden");
        }
    }

    $("header").hidden = name !== "home";
    $("subheader").hidden = name === "home";

    if (name !== "home") {
        $("screen-title").textContent = t(SCREEN_TITLES[name]);
    }

    if (name === "home") {
        renderHome();
    } else if (name === "generator") {
        renderGenerator();
    } else if (name === "search") {
        $("search-input").value = "";
        renderSearch();
        $("search-input").focus();
    }

    if (!animate) {
        screenTransition += 1;
        content.style.height = "";
        return;
    }

    // Slide the screens past each other: the outgoing one leaves on one side
    // while the incoming one arrives from the other. Going back to home
    // reverses the direction.
    const forward = name !== "home";
    to.inert = false;
    to.removeAttribute("aria-hidden");
    from.inert = true;
    from.setAttribute("aria-hidden", "true");

    for (const element of [from, to]) {
        element.classList.remove(
            "enter-forward", "enter-back", "exit-forward", "exit-back"
        );
        element.classList.add("animating");
    }
    from.classList.add(forward ? "exit-forward" : "exit-back");
    to.classList.add(forward ? "enter-forward" : "enter-back");

    // Flush the frozen height, then let the panel resize to the new screen
    // while both screens slide.
    void content.offsetHeight;
    content.style.height = `${to.offsetHeight}px`;

    const transition = ++screenTransition;
    let finished = false;
    const finish = () => {
        if (finished || transition !== screenTransition) return;
        finished = true;
        to.removeEventListener("animationend", onAnimationEnd);
        from.hidden = true;
        from.inert = false;
        from.removeAttribute("aria-hidden");
        from.classList.remove(
            "animating", "enter-forward", "enter-back", "exit-forward", "exit-back"
        );
        to.classList.remove(
            "animating", "enter-forward", "enter-back", "exit-forward", "exit-back"
        );
        content.style.height = "";
    };
    const onAnimationEnd = (event) => {
        if (event.target === to && event.animationName.startsWith("screen-enter")) {
            finish();
        }
    };
    to.addEventListener("animationend", onAnimationEnd);
    setTimeout(finish, 320);
}

// -- Home --

function sectionLabel(text, domain) {
    const label = el("div", "section-label");
    label.append(el("span", "", text));
    if (domain) {
        const right = el("span", "section-domain");
        right.innerHTML = ICONS.globe;
        right.append(document.createTextNode(domain));
        label.append(right);
    }
    return label;
}

function formatTotp(code) {
    const value = String(code ?? "");
    return value.length === 6 ? `${value.slice(0, 3)} ${value.slice(3)}` : value;
}

function renderTotpChip(entry) {
    const chip = el("button", "totp-chip");
    chip.type = "button";
    chip.setAttribute("aria-label", t("totp_copy_label"));
    chip.title = t("totp_copy_label");

    const code = el("span", "totp-code", formatTotp(entry.totp));
    const ringWrap = el("span", "totp-ring-wrap");
    ringWrap.innerHTML = `<svg viewBox="0 0 20 20" class="totp-ring"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2" class="totp-track"></circle><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="${RING}" class="totp-progress"></circle></svg><span class="totp-copy">${ICONS.copy}</span>`;
    chip.append(code, ringWrap);

    chip.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(entry.totp);
            toast(t("toast_totp_copied"));
        } catch {
            toast(t("clipboard_failed"));
        }
    });

    totpChips.push({
        entry,
        code,
        progress: ringWrap.querySelector(".totp-progress"),
    });
    return chip;
}

function renderLoginRow(entry, subtitle) {
    const row = el("div", "login-row");
    const main = el("button", "login-main");
    main.type = "button";

    const name = entry.name || entry.login || "?";
    const avatar = el("div", "avatar", name.slice(0, 1).toUpperCase());
    const text = el("div", "login-text");
    text.append(
        el("div", "login-name", name),
        el("div", "login-sub", subtitle ?? entry.login)
    );
    main.append(avatar, text);
    main.addEventListener("click", () => fill(entry));
    row.append(main);

    if (entry.totp) row.append(renderTotpChip(entry));
    return row;
}

function renderEmpty() {
    const box = el("div", "empty-state");
    box.append(
        el("div", "empty-title", t("home_empty_title", [pageDomain || "—"])),
        el("div", "empty-hint", t("home_empty_hint"))
    );

    const actions = el("div", "empty-actions");
    const search = el("button", "pill");
    search.type = "button";
    search.innerHTML = ICONS.search;
    search.append(document.createTextNode(t("button_search")));
    search.addEventListener("click", () => setScreen("search"));
    actions.append(search);
    box.append(actions);
    return box;
}

function renderError() {
    const config = ERROR_STATES[appState] ?? ERROR_STATES.offline;
    const box = el("div", "error-state");

    const icon = el("div", "error-icon");
    icon.innerHTML = ICONS[config.icon];

    const button = el("button", "pill primary error-button", t(config.button));
    button.type = "button";
    button.addEventListener("click", () => runErrorAction(config.action));

    box.append(
        icon,
        el("div", "error-title", t(config.title)),
        el("div", "error-text", t(config.text)),
        button
    );
    return box;
}

function renderHome() {
    const body = $("home-body");
    body.replaceChildren();
    stopTotp();

    if (appState !== "ok") {
        body.append(renderError());
        return;
    }
    if (!pageEntries.length) {
        body.append(renderEmpty());
        return;
    }

    body.append(sectionLabel(t("section_for_site"), pageDomain));
    const group = el("div", "group entries");
    for (const entry of pageEntries) group.append(renderLoginRow(entry));
    body.append(group);
    startTotp();
}

async function runErrorAction(action) {
    try {
        if (action === "pair") {
            const response = await api({ action: "associate" });
            if (!response?.success) {
                toast(friendlyError(response?.error));
                return;
            }
            await init();
            if (appState === "ok") toast(t("toast_connected"));
            return;
        }

        await init();
        if (appState === "ok") toast(t("toast_connected"));
    } catch {
        // The popup is closing or the background is unavailable.
    }
}

async function fill(entry) {
    try {
        const tab = await activeTab();
        if (!tab?.id) {
            toast(t("fill_no_access"));
            return;
        }
        const response = await browser.tabs.sendMessage(tab.id, {
            action: "fill-credentials",
            login: entry.login,
            password: entry.password,
        });
        if (response && response.success === false) {
            toast(t("fill_no_form"));
            return;
        }
        window.close();
    } catch {
        toast(t("fill_no_access"));
    }
}

// -- TOTP ticker --

function startTotp() {
    if (totpTimer || !totpChips.length) return;
    lastTotpPeriod = Math.floor(Date.now() / 30000);
    tickTotp();
    totpTimer = setInterval(tickTotp, 1000);
}

function stopTotp() {
    if (totpTimer) {
        clearInterval(totpTimer);
        totpTimer = null;
    }
    totpChips = [];
    lastTotpPeriod = null;
}

function tickTotp() {
    const now = Math.floor(Date.now() / 1000);
    const period = Math.floor(now / 30);
    const remaining = 30 - (now % 30);

    for (const chip of totpChips) {
        chip.progress.style.strokeDashoffset = String(RING * (1 - remaining / 30));
        chip.progress.classList.toggle("low", remaining <= 5);
    }

    // Compare period numbers instead of a single second: a throttled timer
    // must not skip the rollover and keep showing an expired code.
    if (lastTotpPeriod !== null && period !== lastTotpPeriod && !totpRefreshing) {
        totpRefreshing = true;
        refreshTotpCodes()
            .catch(() => {})
            .finally(() => {
                totpRefreshing = false;
            });
    }
    lastTotpPeriod = period;
}

async function refreshTotpCodes() {
    const tab = await activeTab();
    if (!tab?.url?.startsWith("http")) return;

    const response = await api({ action: "get-logins", url: tab.url });
    if (!response?.success) return;

    const fresh = new Map((response.result?.entries ?? []).map((entry) => [entry.uuid, entry]));
    for (const chip of totpChips) {
        const updated = fresh.get(chip.entry.uuid);
        if (updated?.totp) {
            chip.entry.totp = updated.totp;
            chip.code.textContent = formatTotp(updated.totp);
        }
    }
}

// -- Data loading --

async function loadEntries() {
    const tab = await activeTab();
    pageDomain = hostOf(tab?.url);

    if (!tab?.url?.startsWith("http")) {
        pageEntries = [];
        renderHome();
        return;
    }

    try {
        const response = await api({ action: "get-logins", url: tab.url });
        if (!response?.success) {
            if (!isNoLoginsFound(response?.error) && isLockedError(response?.error)) {
                appState = "locked";
                renderStatus();
            }
            pageEntries = [];
            renderHome();
            return;
        }
        pageEntries = (response.result?.entries ?? []).map((entry) => ({
            ...entry,
            domain: pageDomain,
        }));
        renderHome();
    } catch {
        pageEntries = [];
        renderHome();
    }
}

async function loadSettings() {
    const select = $("save-group");
    const defaultOption = el("option", "", t("save_group_default"));
    defaultOption.value = "";
    select.replaceChildren(defaultOption);

    try {
        const response = await api({ action: "get-database-groups" });
        const groups = response?.success ? response.result?.groups ?? [] : [];
        const stored = await browser.storage.local.get("saveGroup");
        const selected = stored.saveGroup?.uuid;

        for (const group of groups) {
            const option = el("option", "", group.name);
            option.value = group.uuid;
            option.selected = group.uuid === selected;
            select.append(option);
        }
    } catch {
        // The default option stays as a fallback.
    }

    let stored = {};
    try {
        stored = await browser.storage.local.get([
            "passkeysEnabled",
            "autofillOnLoad",
            "savePromptEnabled",
        ]);
    } catch {
        // Treat unreadable settings as their defaults.
    }

    $("save-prompt").checked = stored.savePromptEnabled !== false;
    $("autofill").checked = stored.autofillOnLoad !== false;

    renderConnection();
    await loadPasskeys();
}

function renderConnection() {
    const connected = statusResult?.connected === true;
    const associated = statusResult?.associated === true;
    const ok = connected && associated;

    $("connection-dot").className = "dot " + (ok ? "success" : "destructive");
    $("connection-title").textContent = ok
        ? t("settings_connected_to", [statusResult?.keePassXCVersion ?? "?"])
        : t("settings_not_connected");
}

async function loadPasskeys() {
    let stored = {};
    try {
        stored = await browser.storage.local.get("passkeysEnabled");
    } catch {
        // Treat an unreadable setting as off.
    }

    const toggle = $("passkeys");
    toggle.checked = stored.passkeysEnabled === true;

    const connected = statusResult?.connected === true;
    const associated = statusResult?.associated === true;
    const version = statusResult?.keePassXCVersion;
    const compatible = versionAtLeast(version, PASSKEYS_MIN_VERSION);

    toggle.disabled = !connected || !associated || !compatible;

    const pageState = toggle.checked ? await passkeysPageState() : null;
    const pageInstalled = pageState?.page === "enabled" || pageState?.page === "installed";
    const fallbackReason = pageState?.decision?.includes(":safari:")
        ? pageState.decision.split(":safari:")[1]
        : null;

    const hint = $("passkeys-hint");
    if (!connected) {
        hint.textContent = t("passkeys_bridge_stopped");
    } else if (!associated) {
        hint.textContent = t("passkeys_not_associated");
    } else if (!compatible) {
        hint.textContent = t("passkeys_unsupported_version", [version ?? "?"]);
    } else if (toggle.checked && pageState === null) {
        // No https page to diagnose (start page, about:blank, …): keep the
        // neutral hint instead of claiming the bridge is inactive.
        hint.textContent = t("passkeys_toggle_hint");
    } else if (toggle.checked && !pageInstalled) {
        hint.textContent = t("passkeys_page_not_active");
    } else if (fallbackReason) {
        hint.textContent = t("passkeys_fallback_reason", [fallbackReason]);
    } else {
        hint.textContent = t("passkeys_toggle_hint");
    }
}

async function passkeysPageState() {
    try {
        const tab = await activeTab();
        if (tab?.id === undefined || !tab.url?.startsWith("https://")) return null;
        return await browser.tabs.sendMessage(tab.id, { action: "passkeys-diagnostic" });
    } catch {
        return null;
    }
}

async function loadVersion() {
    try {
        const response = await api({ action: "get-version" });
        const result = response?.result;
        if (!response?.success || !result?.version) return;
        $("footer").textContent = `SafariKeePassXC v${result.version} (${result.build})`;
    } catch {
        // The footer simply stays empty.
    }
}

// -- Generator --

function renderGenerator() {
    currentPassword = generate(generatorOptions);

    const display = $("generated-password");
    display.replaceChildren();
    for (const character of currentPassword) {
        const span = document.createElement("span");
        span.textContent = character;
        if (/[0-9]/.test(character)) span.className = "digit";
        else if (/[^a-zA-Z]/.test(character)) span.className = "symbol";
        display.append(span);
    }

    const result = strength(generatorOptions);
    const bars = $("strength-bars").children;
    for (let index = 0; index < bars.length; index += 1) {
        bars[index].className = index < result.score ? `bar on score-${result.score}` : "bar";
    }
    $("strength-label").textContent = t(`generator_strength_${result.label}`);

    $("length").value = String(generatorOptions.length);
    $("length-value").textContent = String(generatorOptions.length);
    $("length").style.setProperty(
        "--fill",
        `${((generatorOptions.length - 8) / (64 - 8)) * 100}%`
    );
    $("length-label").textContent = t(
        generatorOptions.phrase ? "generator_phrase_length" : "generator_length"
    );
    $("length").setAttribute(
        "aria-label",
        t(generatorOptions.phrase ? "generator_phrase_length" : "generator_length")
    );
    $("phrase").checked = generatorOptions.phrase;
    $("charset-grid").hidden = generatorOptions.phrase;

    for (const button of document.querySelectorAll(".charset")) {
        button.classList.toggle("on", generatorOptions[button.dataset.option] === true);
    }
}

// -- Search --

function renderSearch() {
    const query = $("search-input").value;
    const results = filterEntries(pageEntries, query);

    $("clear-search").hidden = !query;
    $("search-label").textContent = query
        ? t("search_results", [String(results.length)])
        : t("search_all");

    stopTotp();
    const list = $("search-results");
    list.replaceChildren();

    if (!results.length) {
        list.append(el("div", "results-empty", t("search_empty")));
        return;
    }

    for (const entry of results) {
        const subtitle = [entry.login, entry.group].filter(Boolean).join(" · ");
        list.append(renderLoginRow(entry, subtitle));
    }
    startTotp();
}

// -- Init --

async function init() {
    stopTotp();
    $("home-body").replaceChildren();

    let response;
    try {
        response = await api({ action: "status" });
    } catch (error) {
        response = { success: false, error: String(error) };
    }

    statusResult = response?.success ? response.result ?? {} : null;
    appState = stateFromStatus(statusResult);
    renderStatus();

    await loadSettings();

    if (appState === "ok") {
        await loadEntries();
    } else {
        pageEntries = [];
        renderHome();
    }

    setScreen(screen);

    // Safari focuses the first control when the popup opens; the design shows
    // no focus ring until the user actually tabs or clicks.
    if (screen === "home" && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
    }
}

function wireEvents() {
    $("nav-search").addEventListener("click", () => setScreen("search"));
    $("nav-generator").addEventListener("click", () => setScreen("generator"));
    $("nav-settings").addEventListener("click", () => setScreen("settings"));
    $("nav-back").addEventListener("click", () => setScreen("home"));

    $("save-group").addEventListener("change", async (event) => {
        const option = event.target.selectedOptions[0];
        if (option?.value) {
            await browser.storage.local.set({
                saveGroup: { uuid: option.value, name: option.textContent },
            });
        } else {
            await browser.storage.local.remove("saveGroup");
        }
    });

    $("save-prompt").addEventListener("change", (event) => {
        browser.storage.local.set({ savePromptEnabled: event.target.checked });
    });

    $("autofill").addEventListener("change", (event) => {
        browser.storage.local.set({ autofillOnLoad: event.target.checked });
    });

    $("passkeys").addEventListener("change", async (event) => {
        await browser.storage.local.set({ passkeysEnabled: event.target.checked });
        $("passkeys-hint").textContent = t("passkeys_reload_hint");
    });

    $("reconnect").addEventListener("click", async () => {
        try {
            const response = await api({ action: "status" });
            if (response?.success && response.result?.associated) {
                toast(t("toast_reconnected"));
                await init();
                return;
            }
            const association = await api({ action: "associate" });
            if (association?.success) {
                toast(t("toast_connected"));
                await init();
            } else {
                toast(friendlyError(association?.error));
            }
        } catch {
            toast(t("error_host_app_not_running"));
        }
    });

    $("regenerate").addEventListener("click", renderGenerator);

    $("copy-password").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(currentPassword);
            toast(t("toast_password_copied"));
        } catch {
            toast(t("clipboard_failed"));
        }
    });

    $("length").addEventListener("input", (event) => {
        generatorOptions.length = Number(event.target.value);
        renderGenerator();
    });

    $("phrase").addEventListener("change", (event) => {
        generatorOptions.phrase = event.target.checked;
        renderGenerator();
    });

    for (const button of document.querySelectorAll(".charset")) {
        button.addEventListener("click", () => {
            const key = button.dataset.option;
            generatorOptions[key] = !generatorOptions[key];
            renderGenerator();
        });
    }

    $("search-input").addEventListener("input", renderSearch);
    $("clear-search").addEventListener("click", () => {
        $("search-input").value = "";
        renderSearch();
        $("search-input").focus();
    });

    $("search-keepassxc").addEventListener("click", async () => {
        const query = $("search-input").value.trim() || pageDomain;
        if (!query) {
            toast(t("search_empty"));
            return;
        }
        try {
            const response = await api({ action: "request-autotype", search: query });
            if (!response?.success) {
                toast(friendlyError(response?.error));
                return;
            }
            // KeePassXC opens its own search / auto-type window; the popup
            // must close so the page is the active window again.
            window.close();
        } catch {
            toast(t("error_host_app_not_running"));
        }
    });
}

localizeDocument();
wireEvents();
loadVersion();
init();
