import Foundation

extension URLSession.AsyncBytes {
    /// Reads at most `limit` bytes of a response body.
    ///
    /// Used when the body is only going to become the text of an error, or when
    /// a stream request was answered with a plain JSON completion and the whole
    /// body is needed at once. A read that breaks must not replace the status the
    /// caller is about to report with a transport error, so the failure is
    /// swallowed and whatever arrived is returned.
    func prefixData(limit: Int) async -> Data {
        var data = Data()
        do {
            for try await byte in self {
                data.append(byte)
                if data.count >= limit { break }
            }
        } catch {
            // The body is diagnostic: a broken read must not mask the HTTP error.
        }
        return data
    }
}
