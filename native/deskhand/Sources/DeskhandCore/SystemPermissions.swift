import Foundation
import ApplicationServices
import CoreGraphics

/// System-level permission checks. Deskhand needs two grants on macOS:
/// Accessibility (to read and drive other apps' UI) and Screen Recording
/// (to capture window pixels). Both are surfaced to the user once, then
/// re-checked cheaply.
public enum SystemPermissions {
    public struct Status: Sendable {
        public var accessibility: Bool
        public var screenRecording: Bool

        public var allGranted: Bool { accessibility && screenRecording }

        public var summary: String {
            var missing: [String] = []
            if !accessibility { missing.append("Accessibility") }
            if !screenRecording { missing.append("Screen Recording") }
            if missing.isEmpty { return "all permissions granted" }
            return "missing permission(s): " + missing.joined(separator: ", ")
        }
    }

    public static func current() -> Status {
        Status(
            accessibility: AXIsProcessTrusted(),
            screenRecording: CGPreflightScreenCaptureAccess()
        )
    }

    /// Shows the system prompt for Accessibility if it has not been decided yet.
    @discardableResult
    public static func requestAccessibility() -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        let options = [key: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    /// Shows the Screen Recording prompt once; returns the current state.
    @discardableResult
    public static func requestScreenRecording() -> Bool {
        if CGPreflightScreenCaptureAccess() { return true }
        return CGRequestScreenCaptureAccess()
    }

    public static func openAccessibilityPrivacySettings() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        if let url {
            NSWorkspaceShim.open(url)
        }
    }
}

import AppKit

private enum NSWorkspaceShim {
    static func open(_ url: URL) {
        NSWorkspace.shared.open(url)
    }
}
