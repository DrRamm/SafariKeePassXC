//
//  ViewController.swift
//  SafariKeePassXC
//
//  Created by Markus Griesslehner on 29.07.26.
//

import Cocoa
import SafariServices
import WebKit

let extensionBundleIdentifier = "dev.kotsareu.SafariKeePassXC.Extension"

class ViewController: NSViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self
        self.webView.configuration.userContentController.add(self, name: "controller")
        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)

        UpdateChecker.shared.onResult = { [weak self] release in
            self?.applyUpdateState(release)
        }
    }

    private func applyUpdateState(_ release: ReleaseInfo?) {
        guard let release else {
            webView.evaluateJavaScript("hideUpdate()") { _, _ in }
            return
        }
        showUpdateBanner(version: release.tag, url: release.url)
    }

    private func showUpdateBanner(version: String, url: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["version": version, "url": url]),
                let json = String(data: data, encoding: .utf8) else {
            return
        }
        webView.evaluateJavaScript("showUpdate(" + json + ")") { _, _ in }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The update check may have finished before the page was ready.
        if let release = UpdateChecker.shared.pendingRelease {
            showUpdateBanner(version: release.tag, url: release.url)
        }

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show(\(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show(\(state.isEnabled), false)")
                }
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? String else {
            return
        }

        if body.hasPrefix("open-release-url:") {
            openReleasePage(url: String(body.dropFirst("open-release-url:".count)))
            return
        }

        guard body == "open-preferences" else {
            return
        }

        SFSafariApplication.showPreferencesForExtension(
            withIdentifier: extensionBundleIdentifier
        ) { error in
            if let error {
                print("Could not open Safari Extension preferences:")
                print("   \(error)")
                print("   domain: \((error as NSError).domain)")
                print("   code: \((error as NSError).code)")
                print("   userInfo: \((error as NSError).userInfo)")
                return
            }

            DispatchQueue.main.async {
                if let window = self.view.window ?? NSApp.mainWindow {
                    (NSApp.delegate as? AppDelegate)?.moveToBackground(window)
                }
            }
        }
    }

    private func openReleasePage(url: String) {
        // The URL comes from the GitHub API response, but only ever open a
        // GitHub page from here.
        guard let url = URL(string: url), url.scheme == "https", url.host == "github.com" else {
            return
        }
        NSWorkspace.shared.open(url)
    }

}
