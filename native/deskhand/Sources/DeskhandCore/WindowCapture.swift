import Foundation
import CoreGraphics
import ScreenCaptureKit
import AppKit
import ImageIO
import UniformTypeIdentifiers

/// Window capture.
///
/// ScreenCaptureKit gives us a window-only image including any sheet or popover
/// drawn on top of it, which is exactly what a "what does the app look like"
/// screenshot should show. The image is downscaled so that a 5K window does not
/// burn the whole context window, and the scale factor is reported back so
/// pixel coordinates from the model map onto real screen points.
public enum WindowCapture {
    public struct Result: Sendable {
        public let pngData: Data
        public let pixelWidth: Int
        public let pixelHeight: Int
        /// screen points -> pixels in the returned image
        public let scale: Double
        public let windowFrame: CGRect
        /// Wall time spent in ScreenCaptureKit.
        public let captureMilliseconds: Double
        /// Wall time spent encoding the PNG.
        public let encodeMilliseconds: Double
    }

    public enum CaptureError: Error, CustomStringConvertible {
        case windowNotFound
        case noPermission
        case captureFailed(String)
        case encodingFailed

        public var description: String {
            switch self {
            case .windowNotFound: return "could not find the app's window to capture"
            case .noPermission:
                return "Screen Recording permission is required to take screenshots"
            case .captureFailed(let message): return "screen capture failed: \(message)"
            case .encodingFailed: return "could not encode the screenshot as PNG"
            }
        }
    }

    public struct Options: Sendable {
        /// Longest edge of the returned image, in pixels.
        public var maxDimension: Int
        public var showsCursor: Bool

        public init(maxDimension: Int = 1280, showsCursor: Bool = false) {
            self.maxDimension = maxDimension
            self.showsCursor = showsCursor
        }
    }

    public static func capture(
        pid: pid_t,
        options: Options = Options(),
        preferredFrame: CGRect? = nil
    ) async throws -> Result {
        WindowServer.prepare()
        guard CGPreflightScreenCaptureAccess() else { throw CaptureError.noPermission }

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
        } catch {
            throw CaptureError.captureFailed(error.localizedDescription)
        }

        let windows = content.windows.filter { $0.owningApplication?.processID == pid }
        guard !windows.isEmpty else { throw CaptureError.windowNotFound }

        // Prefer the window the accessibility tree was read from.
        //
        // The tree comes from the app's *focused* window, while the largest
        // layer-0 window is usually — but not always — the same one. When an app
        // has several windows open (a chat window and a main window, a document
        // and a search window) the two disagree, and the disagreement is silent:
        // the model reads indices from one window and pixel coordinates from a
        // screenshot of the other, so an x/y click is measured against the wrong
        // frame and lands in a different window entirely. Element indices keep
        // working, which is why the run looks half-right instead of broken.
        //
        // So the frame the tree reported wins when it is available. The size
        // heuristic stays as the fallback for a caller that has no tree.
        let usable = windows.filter { $0.windowLayer == 0 && $0.frame.width > 40 && $0.frame.height > 40 }
        let largest = usable.max {
            $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
        }
        let matching = preferredFrame.flatMap { frame in
            usable.min {
                distance($0.frame, frame) < distance($1.frame, frame)
            }.flatMap { distance($0.frame, frame) <= 8 ? $0 : nil }
        }
        let candidate = matching ?? largest
            ?? windows.max { lhs, rhs in lhs.frame.width * lhs.frame.height < rhs.frame.width * rhs.frame.height }

        guard let window = candidate else { throw CaptureError.windowNotFound }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let target = fit(
            size: window.frame.size,
            longestEdge: Double(options.maxDimension)
        )

        let configuration = SCStreamConfiguration()
        configuration.width = Int(target.width.rounded())
        configuration.height = Int(target.height.rounded())
        configuration.showsCursor = options.showsCursor
        configuration.captureResolution = .best
        configuration.ignoreShadowsSingleWindow = true
        configuration.shouldBeOpaque = true

        let image: CGImage
        let captureClock = TimingClock()
        do {
            image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
        } catch {
            throw CaptureError.captureFailed(error.localizedDescription)
        }
        let captureMilliseconds = captureClock.milliseconds

        let encodeClock = TimingClock()
        guard let data = encodePNG(image) else { throw CaptureError.encodingFailed }
        let encodeMilliseconds = encodeClock.milliseconds

        // The captured image is in device pixels; the window frame is in points.
        // Divide to obtain the factor the model should use to convert its
        // pixel-space clicks into screen coordinates.
        let scale = window.frame.width > 0 ? Double(image.width) / Double(window.frame.width) : 1

        return Result(
            pngData: data,
            pixelWidth: image.width,
            pixelHeight: image.height,
            scale: scale,
            windowFrame: window.frame,
            captureMilliseconds: captureMilliseconds,
            encodeMilliseconds: encodeMilliseconds
        )
    }

    /// How far apart two window frames are, in points.
    ///
    /// Used to recognise the window the accessibility tree was read from among
    /// the app's windows. ScreenCaptureKit reports a window by identity, not by
    /// the AX window it corresponds to, so the frame is what ties the two
    /// together. Eight points is the tolerance: a window can shift by its own
    /// shadow or by a title bar the two APIs measure differently, but two
    /// distinct windows are never that close.
    static func distance(_ a: CGRect, _ b: CGRect) -> Double {
        let dx = abs(a.origin.x - b.origin.x)
        let dy = abs(a.origin.y - b.origin.y)
        let dw = abs(a.width - b.width)
        let dh = abs(a.height - b.height)
        return max(max(dx, dy), max(dw, dh))
    }

    static func fit(size: CGSize, longestEdge: Double) -> CGSize {
        let longest = max(size.width, size.height)
        guard longest > 0 else { return CGSize(width: 1, height: 1) }
        let factor = min(1.0, longestEdge / Double(longest))
        return CGSize(
            width: max(1, (Double(size.width) * factor).rounded()),
            height: max(1, (Double(size.height) * factor).rounded())
        )
    }

    static func encodePNG(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data as CFMutableData,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}

/// Coordinate conversion between three spaces that are easy to confuse:
///
/// * **AX space** — top-left origin, y grows downward, in screen points.
/// * **CG window space** — top-left origin, same units, origin at the window.
/// * **Image space** — pixels inside the downscaled screenshot.
public struct CoordinateMapper: Sendable {
    public let windowFrame: CGRect
    public let scale: Double

    public init(windowFrame: CGRect, scale: Double) {
        self.windowFrame = windowFrame
        self.scale = scale > 0 ? scale : 1
    }

    /// Converts a point the model reported in screenshot pixels into a global
    /// screen point suitable for `CGEvent`.
    public func screenPoint(fromImagePixel point: CGPoint) -> CGPoint {
        CGPoint(
            x: windowFrame.origin.x + point.x / scale,
            y: windowFrame.origin.y + point.y / scale
        )
    }

    /// Converts a screen point back into screenshot pixels.
    public func imagePixel(fromScreenPoint point: CGPoint) -> CGPoint {
        CGPoint(
            x: (point.x - windowFrame.origin.x) * scale,
            y: (point.y - windowFrame.origin.y) * scale
        )
    }
}
