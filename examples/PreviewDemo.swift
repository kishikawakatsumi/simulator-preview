import SwiftUI

@main struct PreviewDemo: App {
  var body: some Scene { WindowGroup { DemoView() } }
}
struct DemoView: View {
  @State private var count = 0
  @State private var warm = false
  private let commit = Bundle.main.object(forInfoDictionaryKey: "BuildCommit") as? String ?? "local"
  private let pullRequest = Bundle.main.object(forInfoDictionaryKey: "BuildPR") as? String ?? "1"
  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 24) {
          Image(systemName: "iphone.gen3.radiowaves.left.and.right")
            .font(.system(size: 56)).foregroundStyle(warm ? .orange : .blue)
          VStack(spacing: 6) {
            Text("Your preview is connected").font(.title2.bold())
            Text("PR #\(pullRequest) · \(commit.prefix(7))").font(.system(.subheadline, design: .monospaced)).foregroundStyle(.secondary)
          }
          Text("\(count)").font(.system(size: 76, weight: .semibold, design: .rounded)).contentTransition(.numericText())
          Button {
            withAnimation { count += 1 }; save()
          } label: { Label("Try it · Add one", systemImage: "plus").frame(maxWidth: .infinity).padding(8) }
            .buttonStyle(.borderedProminent).accessibilityIdentifier("increment")
          Toggle("Warm accent", isOn: $warm).onChange(of: warm) { _, _ in save() }
          NavigationLink {
            VStack(spacing: 22) {
              Image(systemName: "checkmark.circle.fill").font(.system(size: 72)).foregroundStyle(.green)
              Text("Navigation works").font(.title.bold())
              Text("This screen is running on the remote iOS Simulator.")
                .multilineTextAlignment(.center).foregroundStyle(.secondary)
              Text("You tapped \(count) times.")
            }.padding(30).navigationTitle("Details")
          } label: { Label("Open details", systemImage: "arrow.right.circle").frame(maxWidth: .infinity).padding(8) }
            .buttonStyle(.bordered)
          Text("Built by GitHub Actions. Reviewed in your browser.")
            .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.padding(28)
      }.navigationTitle("Tunnel Preview Test").tint(warm ? .orange : .blue).onAppear { save() }
    }
  }
  private func save() {
    // Lets the integration check verify input inside the guest, not just browser events.
    guard let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
          let data = try? JSONSerialization.data(withJSONObject: ["count": count, "warm": warm, "commit": commit]) else { return }
    try? data.write(to: directory.appendingPathComponent("preview-state.json"), options: .atomic)
  }
}
