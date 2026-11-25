//
//  PasskeyRequest.swift
//  SafariKeePassXC
//
//  Native-side validation of passkey requests that already passed the
//  extension's checks. Defence in depth: the host app never trusts the
//  extension blindly, and the same rules are easy to unit test here.
//

import Foundation

nonisolated enum PasskeyRequest {

    enum ValidationError: LocalizedError {
        case invalidAction
        case invalidOrigin
        case invalidChallenge
        case invalidUser
        case invalidAlgorithms
        case invalidRpId

        var errorDescription: String? {
            switch self {
            case .invalidAction:
                return "invalid_action"
            case .invalidOrigin:
                return "invalid_origin"
            case .invalidChallenge:
                return "invalid_challenge"
            case .invalidUser:
                return "invalid_user"
            case .invalidAlgorithms:
                return "invalid_algorithms"
            case .invalidRpId:
                return "invalid_rp_id"
            }
        }
    }

    static let actions: Set<String> = ["passkeys-register", "passkeys-get"]

    /// Throws when the request cannot be handed to KeePassXC safely.
    static func validate(
        action: String,
        origin: String,
        publicKey: [String: Any]
    ) throws {
        guard actions.contains(action) else {
            throw ValidationError.invalidAction
        }

        guard let url = URL(string: origin),
              url.scheme?.lowercased() == "https",
              let host = url.host,
              !host.isEmpty,
              url.user == nil,
              url.password == nil
        else {
            throw ValidationError.invalidOrigin
        }

        guard let challenge = publicKey["challenge"] as? String,
              let challengeBytes = base64URLByteCount(challenge),
              challengeBytes >= 16
        else {
            throw ValidationError.invalidChallenge
        }

        if action == "passkeys-register" {
            guard let user = publicKey["user"] as? [String: Any],
                  let userId = user["id"] as? String,
                  let userIdBytes = base64URLByteCount(userId),
                  (1...64).contains(userIdBytes)
            else {
                throw ValidationError.invalidUser
            }

            guard let params = publicKey["pubKeyCredParams"] as? [[String: Any]],
                  !params.isEmpty
            else {
                throw ValidationError.invalidAlgorithms
            }
        } else if let rpId = publicKey["rpId"] as? String {
            guard !rpId.isEmpty else {
                throw ValidationError.invalidRpId
            }
        }
    }

    /// Byte count of an unpadded base64url string, or nil when it is not
    /// valid base64url.
    static func base64URLByteCount(_ value: String) -> Int? {
        guard !value.isEmpty else { return nil }
        guard value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
            return nil
        }

        var base64 = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }

        guard let data = Data(base64Encoded: base64) else { return nil }
        return data.count
    }
}
