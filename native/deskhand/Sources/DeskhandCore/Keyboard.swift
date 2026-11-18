import ApplicationServices
import CoreGraphics
import Foundation

/// The modifier spellings every caller accepts.
///
/// Two callers parse modifier names: the keyboard grammar (`ctrl+shift+t`) and
/// the click tool's `modifiers` array. They used to carry separate tables with
/// separate synonyms, so `opt` worked in a key sequence and was silently
/// dropped from a click. One table, so a name the model has learned means the
/// same thing in both places.
///
/// Every name maps to exactly one flag, so neither caller has to disambiguate:
/// the accepted set is the union of what the two tables took before, and no
/// spelling changed meaning.
enum ModifierName {
    /// The flag a name stands for, or nil when the name is not a modifier.
    static func flag(named name: String) -> CGEventFlags? {
        switch name.lowercased() {
        case "cmd", "command", "super", "meta", "win": return .maskCommand
        case "ctrl", "control": return .maskControl
        case "alt", "option", "opt": return .maskAlternate
        case "shift": return .maskShift
        case "fn", "function": return .maskSecondaryFn
        // A lock rather than a held key, but it is still a modifier flag and
        // the keyboard grammar has always accepted it.
        case "capslock": return .maskAlphaShift
        default: return nil
        }
    }

    /// The union of the flags named in a list, ignoring entries that are not
    /// modifiers — which is how the click tool treats an unknown name.
    static func flags(of names: [String]) -> CGEventFlags {
        names.reduce(into: CGEventFlags()) { flags, name in
            if let flag = flag(named: name) { flags.insert(flag) }
        }
    }
}

/// Keyboard input.
///
/// The syntax follows xdotool's `key` grammar because it is compact, widely
/// documented, and models already know it: `a`, `Return`, `Tab`, `super+c`,
/// `ctrl+shift+t`, `KP_0`. We parse it ourselves and post CGEvents, so no
/// external binary is required.
public enum Keyboard {
    public struct ParsedKey: Sendable, Equatable {
        public var keyCode: CGKeyCode
        public var flags: CGEventFlags
        /// True when the character needs a synthesized unicode payload rather
        /// than a physical key code (e.g. emoji or non-Latin text).
        public var unicode: String?
    }

    public enum KeyError: Error, CustomStringConvertible {
        case unknownKey(String)
        case emptySequence

        public var description: String {
            switch self {
            case .unknownKey(let key): return "unknown key name: \"\(key)\""
            case .emptySequence: return "key sequence is empty"
            }
        }
    }

    /// Parses `ctrl+shift+t` into a keycode plus modifier flags.
    public static func parse(_ sequence: String) throws -> ParsedKey {
        let trimmed = sequence.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw KeyError.emptySequence }

        let parts = trimmed.split(separator: "+").map(String.init)
        var flags: CGEventFlags = []
        var keyName: String?

        for part in parts {
            if let modifier = ModifierName.flag(named: part) {
                flags.insert(modifier)
            } else {
                keyName = part
            }
        }

        guard let key = keyName else { throw KeyError.emptySequence }

        // A single printable character that is not a named key is typed by
        // physical key code when we can map it, otherwise by unicode payload.
        if key.count == 1, let code = KeyMap.keyCode(for: key) {
            return ParsedKey(keyCode: code, flags: flags, unicode: nil)
        }
        if let code = KeyMap.named[key.lowercased()] {
            return ParsedKey(keyCode: code, flags: flags, unicode: nil)
        }
        if key.count == 1 {
            return ParsedKey(keyCode: 0, flags: flags, unicode: key)
        }
        throw KeyError.unknownKey(key)
    }

    /// Where a synthetic event is delivered.
    public enum Destination: Sendable, Equatable {
        /// The system event stream. Whatever is frontmost receives it, which is
        /// why this requires activating the target window first.
        case frontmostApp
        /// The event queue of one process, via `CGEvent.postToPid`.
        ///
        /// The target receives the event whether or not it is frontmost, and
        /// the user's focus never moves. Measured on macOS 14: typing, Return,
        /// and modifier shortcuts such as cmd+l all arrive in a background
        /// window this way, and the frontmost application stays put.
        case process(pid_t)
    }

    /// Posts a key press + release for the given sequence.
    public static func press(_ sequence: String, to destination: Destination = .frontmostApp) throws {
        WindowServer.prepare()
        let key = try parse(sequence)
        if let unicode = key.unicode {
            typeString(unicode, flags: key.flags, to: destination)
            return
        }
        let source = SyntheticEvent.eventSource()
        guard
            let down = CGEvent(
                keyboardEventSource: source, virtualKey: key.keyCode, keyDown: true),
            let up = CGEvent(
                keyboardEventSource: source, virtualKey: key.keyCode, keyDown: false)
        else { return }
        down.flags = key.flags
        up.flags = key.flags
        post(down, to: destination)
        post(up, to: destination)
    }

    /// Types literal text. Uses unicode payload events so that non-ASCII text,
    /// emoji and text pasted from a model all arrive intact, independent of the
    /// active keyboard layout.
    public static func typeString(
        _ text: String,
        flags: CGEventFlags = [],
        to destination: Destination = .frontmostApp
    ) {
        guard !text.isEmpty else { return }
        WindowServer.prepare()
        let source = SyntheticEvent.eventSource()
        for scalar in text.unicodeScalars {
            // Surrogate pair for code points above the BMP.
            if scalar.value > 0xFFFF {
                let value = scalar.value - 0x10000
                postUnicode(UniChar(0xD800 + (value >> 10)), flags: flags, source: source, to: destination)
                postUnicode(UniChar(0xDC00 + (value & 0x3FF)), flags: flags, source: source, to: destination)
                continue
            }
            postUnicode(UniChar(scalar.value & 0xFFFF), flags: flags, source: source, to: destination)
        }
    }

    private static func post(_ event: CGEvent, to destination: Destination) {
        // The host's "the user grabbed the keyboard" watcher must not fire on
        // the agent's own keystrokes.
        SyntheticEvent.mark(event)
        switch destination {
        case .frontmostApp: event.post(tap: .cghidEventTap)
        case .process(let pid): event.postToPid(pid)
        }
    }

    private static func postUnicode(
        _ unit: UniChar,
        flags: CGEventFlags,
        source: CGEventSource?,
        to destination: Destination
    ) {
        var mutable = unit
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
            let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        else { return }
        down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &mutable)
        up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &mutable)
        down.flags = flags
        up.flags = flags
        post(down, to: destination)
        post(up, to: destination)
    }
}

/// Physical key codes for US layout plus the named keys agents actually use.
public enum KeyMap {
    public static let named: [String: CGKeyCode] = [
        "return": 36, "enter": 36, "kp_enter": 76,
        "tab": 48, "space": 49, "delete": 51, "backspace": 51,
        "escape": 53, "esc": 53,
        "left": 123, "right": 124, "down": 125, "up": 126,
        "home": 115, "end": 119, "pageup": 116, "page_up": 116,
        "pagedown": 121, "page_down": 121, "prior": 116, "next": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
        "kp_0": 82, "kp_1": 83, "kp_2": 84, "kp_3": 85, "kp_4": 86,
        "kp_5": 87, "kp_6": 88, "kp_7": 89, "kp_8": 91, "kp_9": 92,
        "kp_add": 69, "kp_subtract": 78, "kp_multiply": 67, "kp_divide": 75,
        "kp_decimal": 65,
        "minus": 27, "equal": 24, "bracketleft": 33, "bracketright": 30,
        "backslash": 42, "semicolon": 41, "apostrophe": 39, "grave": 50,
        "comma": 43, "period": 47, "slash": 44,
        "caps_lock": 57,
    ]

    private static let letters: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
        "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
        "j": 38, "k": 40, "n": 45, "m": 46,
    ]

    private static let digits: [Character: CGKeyCode] = [
        "0": 29, "1": 18, "2": 19, "3": 20, "4": 21,
        "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
    ]

    public static func keyCode(for character: String) -> CGKeyCode? {
        guard let c = character.lowercased().first else { return nil }
        if let code = letters[c] { return code }
        if let code = digits[c] { return code }
        switch c {
        case "-": return 27
        case "=": return 24
        case "[": return 33
        case "]": return 30
        case "\\": return 42
        case ";": return 41
        case "'": return 39
        case "`": return 50
        case ",": return 43
        case ".": return 47
        case "/": return 44
        default: return nil
        }
    }
}
