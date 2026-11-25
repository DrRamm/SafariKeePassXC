//
//  UpdateChecker.swift
//  SafariKeePassXC
//
//  Checks GitHub releases for this app and tells the window when a newer
//  release exists than the installed one. No downloads happen here; the
//  release page is opened in the browser instead.
//

import Foundation

/// The two fields of a GitHub release that the update banner needs.
nonisolated struct ReleaseInfo: Codable, Equatable, Sendable {
    /// e.g. "v1.2.3"
    let tag: String
    /// Public page of the release, e.g. "https://github.com/.../releases/tag/v1.2.3"
    let url: String

    private enum CodingKeys: String, CodingKey {
        case tag = "tag_name"
        case url = "html_url"
    }
}

/// Checks GitHub for a newer release than the installed version.
///
/// `@unchecked Sendable`: the only mutable state is `timer`, which is touched
/// exclusively from the main actor in `startChecking()`; `pendingRelease` and
/// `onResult` are main-actor isolated, and `UserDefaults` is thread-safe.
nonisolated final class UpdateChecker: @unchecked Sendable {

    static let shared = UpdateChecker()

    /// How long a successful check is trusted, in seconds (one week).
    static let checkInterval: TimeInterval = 7 * 24 * 3600

    private let repoURL = "https://api.github.com/repos/DrRamm/SafariKeePassXC/releases/latest"
    private let defaults = UserDefaults.standard
    private let lastCheckKey = "updateChecker.lastSuccessfulCheckDate"

    private var timer: Timer?

    /// The newer release found by the last check, if any. Kept so the window
    /// can show the banner even when the check finished before the page was
    /// ready to receive it.
    @MainActor private(set) var pendingRelease: ReleaseInfo?

    /// Called on the main actor with the newer release, or with nil when the
    /// installed version is up to date.
    @MainActor var onResult: ((_ release: ReleaseInfo?) -> Void)?

    private init() {}

    // MARK: - Version comparison

    /// Parses the numeric components of a version string, e.g. "v1.2.3" -> [1, 2, 3].
    /// A leading "v" is ignored, as are pre-release ("-beta") and build ("+build")
    /// suffixes. Returns nil if the string is not parseable.
    static func versionParts(_ string: String) -> [Int]? {
        var trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.hasPrefix("v") {
            trimmed.removeFirst()
        }
        if let index = trimmed.firstIndex(of: "-") {
            trimmed = String(trimmed[..<index])
        }
        if let index = trimmed.firstIndex(of: "+") {
            trimmed = String(trimmed[..<index])
        }
        let components = trimmed.components(separatedBy: ".")
        guard !components.isEmpty, components.allSatisfy({ !$0.isEmpty }) else { return nil }
        var parts: [Int] = []
        for component in components {
            guard let value = Int(component) else { return nil }
            parts.append(value)
        }
        return parts
    }

    /// Returns true when `candidate` is a strictly newer version than `current`.
    /// Missing components count as zero, so "1.2" does not count as newer than "1.2.0".
    /// Pre-release suffixes are ignored: "1.2.4" is not newer than "1.2.4-beta".
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        guard let candidateParts = versionParts(candidate),
              let currentParts = versionParts(current) else { return false }
        let count = max(candidateParts.count, currentParts.count)
        for index in 0..<count {
            let candidateValue = index < candidateParts.count ? candidateParts[index] : 0
            let currentValue = index < currentParts.count ? currentParts[index] : 0
            if candidateValue > currentValue { return true }
            if candidateValue < currentValue { return false }
        }
        return false
    }

    /// The installed version, or nil when the bundle has no usable version.
    static func currentVersion() -> String? {
        guard let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              versionParts(version) != nil else { return nil }
        return version
    }

    /// Whether a new check is due. A missing date means "never checked".
    static func shouldCheck(lastCheck: Date?, now: Date, interval: TimeInterval) -> Bool {
        guard let lastCheck else { return true }
        return lastCheck.addingTimeInterval(interval) <= now
    }

    // MARK: - Checking

    @MainActor
    func startChecking() {
        Task { await check() }
        timer?.invalidate()
        // Tick hourly and let the one-week gate in check() decide. A timer that
        // fired exactly every week would miss its own deadline by the duration
        // of the request that recorded the previous check.
        timer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in
            Task { await self?.check() }
        }
    }

    /// Checks whether the latest release is newer than the installed version.
    /// Silently does nothing when the check fails (offline, rate limited, …)
    /// or when the last successful check is less than a week old.
    func check() async {
        guard let currentVersion = Self.currentVersion() else { return }
        let now = Date()
        guard Self.shouldCheck(
            lastCheck: defaults.object(forKey: lastCheckKey) as? Date,
            now: now,
            interval: Self.checkInterval
        ) else { return }
        guard let release = await fetchLatestRelease(currentVersion: currentVersion) else { return }
        // Only a successful fetch makes a check count, so that a network error
        // at launch does not swallow the result for a whole week.
        defaults.set(now, forKey: lastCheckKey)
        let newerRelease = Self.isNewer(release.tag, than: currentVersion) ? release : nil
        await MainActor.run {
            pendingRelease = newerRelease
            onResult?(newerRelease)
        }
    }

    func fetchLatestRelease(currentVersion: String) async -> ReleaseInfo? {
        guard let url = URL(string: repoURL) else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("SafariKeePassXC/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                return nil
            }
            return try JSONDecoder().decode(ReleaseInfo.self, from: data)
        } catch {
            return nil
        }
    }
}
