import UIKit

final class ProbeView: UIView {
  var events: [[String: Any]] = []
  let label = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .systemIndigo
    label.text = "Touch Probe\nClick, hold, then drag"
    label.numberOfLines = 0
    label.textColor = .white
    label.textAlignment = .center
    addSubview(label)
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("events.json")
    try! Data("[]".utf8).write(to: url)
  }
  required init?(coder: NSCoder) { fatalError() }
  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = bounds.insetBy(dx: 20, dy: 100)
    label.isUserInteractionEnabled = false
  }
  func record(_ phase: String, _ touches: Set<UITouch>) {
    guard let touch = touches.first else { return }
    let p = touch.location(in: self)
    events.append(["phase": phase, "x": p.x / bounds.width, "y": p.y / bounds.height, "time": touch.timestamp, "width": bounds.width, "height": bounds.height, "orientation": (window?.windowScene?.interfaceOrientation.rawValue ?? 0)])
    label.text = "\(phase)\n\(Int(p.x)), \(Int(p.y))\n\(events.count) events"
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("events.json")
    try! JSONSerialization.data(withJSONObject: events, options: .prettyPrinted).write(to: url, options: .atomic)
  }
  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) { record("began", touches) }
  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) { record("moved", touches) }
  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { record("ended", touches) }
  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { record("cancelled", touches) }
}

final class ProbeController: UIViewController {
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .all }
  override var shouldAutorotate: Bool { true }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let controller = ProbeController()
    controller.view = ProbeView(frame: scene.coordinateSpace.bounds)
    let window = UIWindow(windowScene: scene)
    window.rootViewController = controller
    window.makeKeyAndVisible()
    self.window = window
  }
  func sceneDidBecomeActive(_ scene: UIScene) { recordState("active") }
  func sceneDidEnterBackground(_ scene: UIScene) { recordState("background") }
  private func recordState(_ state: String) {
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("home-state.json")
    try! JSONSerialization.data(withJSONObject: ["state": state]).write(to: url, options: .atomic)
  }
}

final class Delegate: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                   options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Probe", sessionRole: session.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}
UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(Delegate.self))
