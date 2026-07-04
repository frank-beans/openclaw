import SwiftUI
import WebKit

/// Control-hub Terminal destination: embeds the gateway-served terminal page
/// (`/?view=terminal`, the ghostty-web surface shared with the Control UI) in a
/// WKWebView, authenticated with the stored gateway token.
struct TerminalHubScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let usesNativeNavigationChrome: Bool
    let gatewayAction: (() -> Void)?

    init(
        headerLeadingAction: OpenClawSidebarHeaderAction? = nil,
        usesNativeNavigationChrome: Bool = false,
        gatewayAction: (() -> Void)? = nil)
    {
        self.headerLeadingAction = headerLeadingAction
        self.usesNativeNavigationChrome = usesNativeNavigationChrome
        self.gatewayAction = gatewayAction
    }

    var body: some View {
        ZStack {
            OpenClawProBackground()
            if let url = Self.terminalURL(config: self.appModel.activeGatewayConnectConfig) {
                TerminalWebView(url: url)
                    .ignoresSafeArea(.container, edges: .bottom)
            } else {
                self.unavailableCard
            }
        }
        .navigationTitle("Terminal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(self.usesNativeNavigationChrome ? .visible : .hidden, for: .navigationBar)
        .toolbar {
            if self.usesNativeNavigationChrome, let gatewayAction {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: gatewayAction) {
                        Image(systemName: "antenna.radiowaves.left.and.right")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    .accessibilityLabel("Gateway settings")
                }
            }
        }
    }

    private var unavailableCard: some View {
        VStack(spacing: 12) {
            ProIconBadge(systemName: "terminal", color: OpenClawBrand.accent)
            Text("Terminal needs a connected gateway")
                .font(OpenClawType.subheadSemiBold)
            Text("Connect to your gateway to open a shell in the agent workspace.")
                .font(OpenClawType.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if let gatewayAction {
                Button(action: gatewayAction) {
                    Text("Open Gateway Settings")
                        .font(OpenClawType.subheadSemiBold)
                }
                .buttonStyle(.borderedProminent)
                .tint(OpenClawBrand.accent)
            }
        }
        .padding(24)
    }

    /// Derives the terminal page URL from the active gateway connection: the
    /// WS endpoint flips to HTTP(S), and the stored gateway token (or password)
    /// rides along as the same `token` query parameter the Control UI accepts.
    static func terminalURL(config: GatewayConnectConfig?) -> URL? {
        guard let config,
              var components = URLComponents(url: config.url, resolvingAgainstBaseURL: false)
        else {
            return nil
        }
        switch components.scheme?.lowercased() {
        case "wss", "https":
            components.scheme = "https"
        default:
            components.scheme = "http"
        }
        components.path = "/"
        var query = [URLQueryItem(name: "view", value: "terminal")]
        let secret = [config.token, config.password]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        if let secret {
            query.append(URLQueryItem(name: "token", value: secret))
        }
        components.queryItems = query
        return components.url
    }
}

/// Minimal WKWebView host for the terminal page. Unlike the canvas WebView it
/// needs no script bridges or deep-link routing — the page is self-contained.
private struct TerminalWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context _: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Ephemeral store: the token travels in the URL per load; nothing to persist.
        config.websiteDataStore = .nonPersistent()

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = true
        webView.backgroundColor = .black

        let scrollView = webView.scrollView
        scrollView.backgroundColor = .black
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.contentInset = .zero
        scrollView.verticalScrollIndicatorInsets = .zero
        scrollView.horizontalScrollIndicatorInsets = .zero
        scrollView.automaticallyAdjustsScrollIndicatorInsets = false

        webView.load(URLRequest(url: self.url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context _: Context) {
        // Reload only when the gateway (and thus the URL) actually changed, so
        // SwiftUI update passes don't restart live shell sessions.
        if webView.url?.host != self.url.host || webView.url?.port != self.url.port {
            webView.load(URLRequest(url: self.url))
        }
    }
}
