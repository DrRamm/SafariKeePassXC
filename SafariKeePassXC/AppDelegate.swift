//
//  AppDelegate.swift
//  SafariKeePassXC
//
//  Created by Markus Griesslehner on 29.07.26.
//

import Cocoa

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    private let bridgeServer = BridgeServer()
    private var mainWindow: NSWindow?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Task {
            await bridgeServer.start()
        }
        UpdateChecker.shared.startChecking()
    }

    // MARK: - Background mode

    /// Hides the app while keeping the bridge process alive.
    /// The only entry point for going to the background.
    func moveToBackground(_ window: NSWindow) {
        mainWindow = window
        window.orderOut(nil)
        NSApp.setActivationPolicy(.accessory)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        NSApp.setActivationPolicy(.regular)
        if #available(macOS 14.0, *) {
            NSApp.activate()
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
        let window = mainWindow ?? NSApp.windows.first(where: { $0 is MainWindow })
        window?.makeKeyAndOrderFront(nil)

        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        Task {
            await bridgeServer.stop()
        }
    }
}

class MainWindow: NSWindow {

    override func performClose(_ sender: Any?) {
        // Avoid the system alert sound that `performClose:` emits when the
        // delegate refuses the close. Closing always means "go to background".
        (NSApp.delegate as? AppDelegate)?.moveToBackground(self)
    }

    override func miniaturize(_ sender: Any?) {
        (NSApp.delegate as? AppDelegate)?.moveToBackground(self)
    }

}

class MainWindowController: NSWindowController, NSWindowDelegate {

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        (NSApp.delegate as? AppDelegate)?.moveToBackground(sender)
        return false
    }

}
