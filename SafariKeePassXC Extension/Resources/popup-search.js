// Pure entry filtering for the popup's search screen.
//
// The KeePassXC-Browser protocol has no "search the whole database" action, so
// the popup searches the entries it already has for the active page. Kept in a
// separate module so it can be unit-tested in Node.

export function filterEntries(entries, query) {
    const list = Array.isArray(entries) ? entries : [];
    const needle = String(query ?? "").trim().toLowerCase();
    if (!needle) return list.slice();

    return list.filter((entry) =>
        [entry?.name, entry?.login, entry?.group, entry?.domain]
            .filter((value) => typeof value === "string" && value.length > 0)
            .some((value) => value.toLowerCase().includes(needle))
    );
}
