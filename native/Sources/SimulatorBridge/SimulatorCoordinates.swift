import Foundation

/// Aspect-fit mapping from an unflipped NSView to top-left normalized coordinates.
public func SimulatorNormalizePoint(
  _ point: CGPoint,
  _ bounds: CGRect,
  _ pixels: CGSize,
  _ clamp: Bool,
  _ result: inout CGPoint
) -> Bool {
  guard pixels.width > 0, pixels.height > 0, bounds.width > 0, bounds.height > 0,
        pixels.width.isFinite, pixels.height.isFinite, point.x.isFinite, point.y.isFinite else {
    return false
  }
  let scale = min(bounds.width / pixels.width, bounds.height / pixels.height)
  let size = CGSize(width: pixels.width * scale, height: pixels.height * scale)
  let image = CGRect(
    x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2,
    width: size.width, height: size.height
  )
  let x = (point.x - image.minX) / size.width
  let y = (image.maxY - point.y) / size.height
  if !clamp && (x < 0 || x > 1 || y < 0 || y > 1) { return false }
  result = CGPoint(x: min(1, max(0, x)), y: min(1, max(0, y)))
  return true
}

public func SimulatorUnrotatePoint(_ point: CGPoint, _ turns: Int) -> CGPoint {
  switch (turns % 4 + 4) % 4 {
  case 1: return CGPoint(x: point.y, y: 1 - point.x)
  case 2: return CGPoint(x: 1 - point.x, y: 1 - point.y)
  case 3: return CGPoint(x: 1 - point.y, y: point.x)
  default: return point
  }
}
