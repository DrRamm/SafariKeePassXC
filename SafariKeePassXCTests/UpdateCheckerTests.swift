//
//  UpdateCheckerTests.swift
//  SafariKeePassXCTests
//

import Testing
@testable import SafariKeePassXC
import Foundation

@Suite("UpdateChecker") struct UpdateCheckerTests {

    // MARK: - Version parsing

    @Test func parsesPlainVersion() {
        #expect(UpdateChecker.versionParts("1.2.3") == [1, 2, 3])
    }

    @Test func parsesVersionWithVPrefix() {
        #expect(UpdateChecker.versionParts("v1.2.3") == [1, 2, 3])
        #expect(UpdateChecker.versionParts("V1.2.3") == [1, 2, 3])
    }

    @Test func ignoresPreReleaseAndBuildSuffixes() {
        #expect(UpdateChecker.versionParts("1.2.3-beta.1") == [1, 2, 3])
        #expect(UpdateChecker.versionParts("1.2.3+build.7") == [1, 2, 3])
    }

    @Test func rejectsUnparseableVersion() {
        #expect(UpdateChecker.versionParts("") == nil)
        #expect(UpdateChecker.versionParts("not-a-version") == nil)
        #expect(UpdateChecker.versionParts("1.x.3") == nil)
        #expect(UpdateChecker.versionParts("1..3") == nil)
    }

    // MARK: - Comparison

    @Test func detectsNewerPatch() {
        #expect(UpdateChecker.isNewer("v1.2.4", than: "1.2.3"))
    }

    @Test func detectsNewerMinorAndMajor() {
        #expect(UpdateChecker.isNewer("1.3.0", than: "1.2.9"))
        #expect(UpdateChecker.isNewer("2.0.0", than: "1.9.9"))
    }

    @Test func sameVersionIsNotNewer() {
        #expect(!UpdateChecker.isNewer("1.2.4", than: "1.2.4"))
        #expect(!UpdateChecker.isNewer("v1.2.4", than: "1.2.4"))
    }

    @Test func olderVersionIsNotNewer() {
        #expect(!UpdateChecker.isNewer("1.2.3", than: "1.2.4"))
    }

    @Test func missingComponentsCountAsZero() {
        #expect(!UpdateChecker.isNewer("1.2", than: "1.2.0"))
        #expect(!UpdateChecker.isNewer("1.2", than: "1.2.1"))
        #expect(UpdateChecker.isNewer("1.2.1", than: "1.2"))
    }

    @Test func unparseableVersionIsNeverNewer() {
        #expect(!UpdateChecker.isNewer("latest", than: "1.2.3"))
        #expect(!UpdateChecker.isNewer("1.2.3", than: "latest"))
    }

    @Test func preReleaseSuffixIsIgnored() {
        // Documented limitation: "1.2.4" is not considered newer than "1.2.4-beta".
        #expect(!UpdateChecker.isNewer("1.2.4", than: "1.2.4-beta"))
        #expect(UpdateChecker.isNewer("1.2.5", than: "1.2.4-beta"))
    }

    @Test func currentVersionIsParsable() {
        let version = UpdateChecker.currentVersion()
        #expect(version != nil)
        #expect(UpdateChecker.versionParts(version ?? "") != nil)
    }

    // MARK: - Check gating

    @Test func checkIsDueWithoutPreviousCheck() {
        #expect(UpdateChecker.shouldCheck(lastCheck: nil, now: Date(), interval: 3600))
    }

    @Test func checkIsDueAfterInterval() {
        let now = Date()
        let interval: TimeInterval = 3600
        #expect(UpdateChecker.shouldCheck(lastCheck: now.addingTimeInterval(-interval), now: now, interval: interval))
        #expect(UpdateChecker.shouldCheck(lastCheck: now.addingTimeInterval(-interval - 1), now: now, interval: interval))
    }

    @Test func checkIsNotDueBeforeInterval() {
        let now = Date()
        let interval: TimeInterval = 3600
        #expect(!UpdateChecker.shouldCheck(lastCheck: now.addingTimeInterval(-interval + 1), now: now, interval: interval))
        #expect(!UpdateChecker.shouldCheck(lastCheck: now, now: now, interval: interval))
    }

    // MARK: - Release decoding

    @Test func decodesLatestRelease() throws {
        let json = """
        {
            "tag_name": "v1.9.9",
            "html_url": "https://github.com/DrRamm/SafariKeePassXC/releases/tag/v1.9.9",
            "name": "Version 1.9.9",
            "draft": false,
            "prerelease": false,
            "assets": [
                {
                    "name": "SafariKeePassXC-1.9.9.dmg",
                    "browser_download_url": "https://github.com/DrRamm/SafariKeePassXC/releases/download/v1.9.9/SafariKeePassXC-1.9.9.dmg"
                }
            ]
        }
        """.data(using: .utf8)!

        let release = try JSONDecoder().decode(ReleaseInfo.self, from: json)
        #expect(release.tag == "v1.9.9")
        #expect(release.url == "https://github.com/DrRamm/SafariKeePassXC/releases/tag/v1.9.9")
    }

    @Test func decodingFailsWithoutRequiredFields() {
        let json = #"{"name": "Version 1.9.9"}"#.data(using: .utf8)!
        #expect(throws: (any Error).self) {
            try JSONDecoder().decode(ReleaseInfo.self, from: json)
        }
    }
}
