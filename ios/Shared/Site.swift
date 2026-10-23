// Site
// ====
// The server the app is a view of (Info.plist UniiSite), and a request to
// it. The answer is the server's JSON, or {error}, as the site's own
// post() reads it.

import Foundation

enum Site {

  static let url = URL(string: Bundle.main.object(forInfoDictionaryKey: "UniiSite") as! String)!
  // a GET (body nil) or POST of `body`
  static func call(_ path: String, _ body: Data?) async -> [String: Any] {
    var req = URLRequest(url: URL(string: path, relativeTo: url)!)
    req.httpMethod = body == nil ? "GET" : "POST"
    req.httpBody = body
    guard let (data, res) = try? await URLSession.shared.data(for: req) else {
      return ["error": "Can't reach UniiChat. Try again."]
    }
    let out = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    return out ?? ["error": "UniiChat gave no answer. Try again."]
  }

}
