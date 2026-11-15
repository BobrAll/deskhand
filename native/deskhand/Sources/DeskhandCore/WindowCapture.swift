import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// Window capture.
///
/// ScreenCaptureKit gives us a window-only image including any sheet or popover
/// drawn on top of it, which is exactly what a "what does the app look like"
/// screenshot should show. The image is downscaled so that a 5K window does not
/// burn the whole context window, and the scale factor is reported back so
/// pixel coordinates from the model map onto real screen points.
public enum WindowCapture {
    /// Default longest edge of the returned image, in pixels. Coordinates the
    /// model reports against a screenshot are bounded by this.
    public static let defaultMaxDimension = 1280
    /// A window smaller than this on either side is a tooltip, a shadow or a
    /// stray panel, not something worth screenshotting.
    private static let minimumWindowSide: CGFloat = 40
    /// How far apart two reports of the same window may be, in points.
    private static let frameMatchTolerance: Double = 8

    public struct Result: Sendable {
        public let imageData: Data
        public let pixelWidth: Int
        public let pixelHeight: Int
        /// screen points -> pixels in the returned image
        public let scale: Double
        public let windowFrame: CGRect
        /// Wall time spent encoding the image.
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
            case .encodingFailed: return "could not encode the screenshot"
            }
        }
    }

    public struct Options: Sendable {
        /// Longest edge of the returned image, in pixels.
        public var maxDimension: Int
        public var showsCursor: Bool

        public init(maxDimension: Int = WindowCapture.defaultMaxDimension, showsCursor: Bool = false) {
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
        let usable = windows.filter {
            $0.windowLayer == 0
                && $0.frame.width > Self.minimumWindowSide
                && $0.frame.height > Self.minimumWindowSide
        }
        let matching = preferredFrame.flatMap { frame in
            usable.min {
                distance(from: $0.frame, to: frame) < distance(from: $1.frame, to: frame)
            }.flatMap { distance(from: $0.frame, to: frame) <= Self.frameMatchTolerance ? $0 : nil }
        }
        guard let window = matching ?? largestWindow(in: usable) ?? largestWindow(in: windows) else {
            throw CaptureError.windowNotFound
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let target = downscaledSize(
            of: window.frame.size,
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
        do {
            image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
        } catch {
            throw CaptureError.captureFailed(error.localizedDescription)
        }

        let encodeClock = TimingClock()
        guard let data = encodeJPEG(image) ?? encodePNG(image) else { throw CaptureError.encodingFailed }
        let encodeMilliseconds = encodeClock.milliseconds

        // The captured image is in device pixels; the window frame is in points.
        // Divide to obtain the factor the model should use to convert its
        // pixel-space clicks into screen coordinates.
        let scale = window.frame.width > 0 ? Double(image.width) / Double(window.frame.width) : 1

        return Result(
            imageData: data,
            pixelWidth: image.width,
            pixelHeight: image.height,
            scale: scale,
            windowFrame: window.frame,
            encodeMilliseconds: encodeMilliseconds
        )
    }

    /// The biggest window in a list, by area.
    ///
    /// The size heuristic is the fallback for a caller with no tree frame: the
    /// largest layer-0 window is usually, but not always, the app's main window.
    private static func largestWindow(in windows: [SCWindow]) -> SCWindow? {
        windows.max { lhs, rhs in
            lhs.frame.width * lhs.frame.height < rhs.frame.width * rhs.frame.height
        }
    }

    /// How far apart two window frames are, in points.
    ///
    /// Used to recognise the window the accessibility tree was read from among
    /// the app's windows. ScreenCaptureKit reports a window by identity, not by
    /// the AX window it corresponds to, so the frame is what ties the two
    /// together. The tolerance is `frameMatchTolerance`: a window can shift by
    /// its own shadow or by a title bar the two APIs measure differently, but
    /// two distinct windows are never that close.
    static func distance(from a: CGRect, to b: CGRect) -> Double {
        let dx = abs(a.origin.x - b.origin.x)
        let dy = abs(a.origin.y - b.origin.y)
        let dw = abs(a.width - b.width)
        let dh = abs(a.height - b.height)
        return max(max(dx, dy), max(dw, dh))
    }

    static func downscaledSize(of size: CGSize, longestEdge: Double) -> CGSize {
        let longest = max(size.width, size.height)
        guard longest > 0 else { return CGSize(width: 1, height: 1) }
        let factor = min(1.0, longestEdge / Double(longest))
        return CGSize(
            width: max(1, (Double(size.width) * factor).rounded()),
            height: max(1, (Double(size.height) * factor).rounded())
        )
    }

    static func encodePNG(_ image: CGImage) -> Data? {
        encode(image, type: UTType.png, properties: nil)
    }

    /// JPEG is what the model gets. A UI screenshot as lossless PNG is
    /// 200–450 kB and rides along in every later request until it is trimmed;
    /// at this quality it is a fraction of that, the text stays readable, and
    /// the request reaches the model sooner.
    static func encodeJPEG(_ image: CGImage, quality: Double = 0.7) -> Data? {
        encode(
            image, type: UTType.jpeg,
            properties: [
                kCGImageDestinationLossyCompressionQuality: quality
            ] as CFDictionary)
    }

    private static func encode(_ image: CGImage, type: UTType, properties: CFDictionary?) -> Data? {
        let data = NSMutableData()
        guard
            let destination = CGImageDestinationCreateWithData(
                data as CFMutableData,
                type.identifier as CFString,
                1,
                nil
            )
        else { return nil }
        CGImageDestinationAddImage(destination, image, properties)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    /// The MIME type of encoded image bytes, read from their signature.
    public static func mimeType(of data: Data) -> String {
        data.starts(with: [0xFF, 0xD8, 0xFF]) ? "image/jpeg" : "image/png"
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
