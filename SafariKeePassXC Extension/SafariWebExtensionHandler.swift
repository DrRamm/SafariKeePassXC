//
//  SafariWebExtensionHandler.swift
//  SafariKeePassXC Extension
//
//  Validates incoming JSON from the JS side and forwards it to the host
//  app's BridgeServer - the extension itself can't reach KeePassXC.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = item?.userInfo?[SFExtensionMessageKey]
        } else {
            message = item?.userInfo?["message"]
        }

        guard let request = message as? [String: Any], request["action"] is String else {
            complete(context, with: ["success": false, "error": "invalid_request"])
            return
        }

        if request["action"] as? String == "get-version" {
            let info = Bundle.main.infoDictionary
            var response: [String: Any] = [
                "success": true,
                "result": [
                    "version": info?["CFBundleShortVersionString"] as? String ?? "",
                    "build": info?["CFBundleVersion"] as? String ?? "",
                ],
            ]
            if let id = request["id"] as? Int { response["id"] = id }
            complete(context, with: response)
            return
        }

        // Passkey requests come from a page-controlled channel. Validate the
        // shape here as well; the background script and BridgeRouter apply the
        // origin/RP ID rules.
        if let action = request["action"] as? String,
           action == "passkeys-register" || action == "passkeys-get" {
            guard let origin = request["origin"] as? String,
                  let url = URL(string: origin),
                  url.scheme?.lowercased() == "https",
                  url.host?.isEmpty == false,
                  url.user == nil,
                  url.password == nil,
                  let publicKey = request["publicKey"] as? [String: Any],
                  let challenge = publicKey["challenge"] as? String,
                  !challenge.isEmpty
            else {
                var failure: [String: Any] = [
                    "success": false,
                    "error": "invalid_passkey_request",
                ]
                if let id = request["id"] as? Int { failure["id"] = id }
                complete(context, with: failure)
                return
            }
        }

        os_log(.default, "Forwarding action to host app: %{public}@", (request["action"] as? String) ?? "?")

        Task {
            do {
                let response = try await HostBridgeConnection.roundTrip(request)
                complete(context, with: response)
            } catch {
                var failure: [String: Any] = [
                    "success": false,
                    "error": (error as? LocalizedError)?.errorDescription ?? String(describing: error),
                ]
                if let id = request["id"] as? Int { failure["id"] = id }
                complete(context, with: failure)
            }
        }
    }

    private func complete(_ context: NSExtensionContext, with body: [String: Any]) {
        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [SFExtensionMessageKey: body]
        } else {
            response.userInfo = ["message": body]
        }
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
