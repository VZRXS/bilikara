// Build-time inspection only. Never emit device IDs, certificate bytes or the
// complete provisioning profile to Actions logs/artifacts.
import Foundation
import CryptoKit

do {
    guard CommandLine.arguments.count == 3 else { throw NSError(domain: "arguments", code: 1) }
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
    guard let root = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
        throw NSError(domain: "plist", code: 1)
    }
    let isProfile = CommandLine.arguments[1] == "profile"
    guard isProfile || CommandLine.arguments[1] == "entitlements" else { throw NSError(domain: "arguments", code: 1) }
    let entitlements = isProfile ? root["Entitlements"] as? [String: Any] ?? [:] : root
    var result: [String: Any] = ["entitlements": [
        "application-identifier": entitlements["application-identifier"] ?? NSNull(),
        "com.apple.developer.team-identifier": entitlements["com.apple.developer.team-identifier"] ?? NSNull(),
        "get-task-allow": entitlements["get-task-allow"] ?? NSNull(),
    ]]
    if isProfile {
        result["teamIds"] = root["TeamIdentifier"] ?? NSNull()
        result["prefixes"] = root["ApplicationIdentifierPrefix"] ?? NSNull()
        result["platforms"] = root["Platform"] ?? NSNull()
        result["expiresAt"] = (root["ExpirationDate"] as? Date)?.timeIntervalSince1970 ?? 0
        result["deviceCount"] = (root["ProvisionedDevices"] as? [String])?.count ?? 0
        result["allDevices"] = root["ProvisionsAllDevices"] ?? false
        result["certificateSha256"] = (root["DeveloperCertificates"] as? [Data] ?? []).map {
            SHA256.hash(data: $0).map { String(format: "%02x", $0) }.joined()
        }
    }
    let json = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(json)
} catch {
    FileHandle.standardError.write(Data("iOS signing plist inspection failed\n".utf8))
    exit(1)
}
