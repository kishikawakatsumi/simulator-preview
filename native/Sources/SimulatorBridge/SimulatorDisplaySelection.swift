import Foundation

public func SimulatorActiveDisplayID(_ value: Any?) -> String? {
  guard let records = value as? [[String: Any]] else {
    return nil
  }
  var integrated: [[String: Any]] = []
  var active: [[String: Any]] = []
  for record in records {
    guard let type = record["type"] as? [String: Any], type["integrated"] != nil else {
      continue
    }
    guard let identity = record["uniqueId"] as? String, !identity.isEmpty else {
      return nil
    }
    integrated.append(record)
    if record["active"] != nil && !(record["active"] is NSNumber) {
      return nil
    }
    let activity = record["active"] as? NSNumber
    let lit = ["activeOn", "activeDimmed"].contains(record["backlightState"] as? String ?? "")
    if let activity, !activity.boolValue && lit {
      return nil
    }
    if activity?.boolValue ?? lit {
      active.append(record)
    }
  }
  if active.count == 1 {
    return active[0]["uniqueId"] as? String
  }
  if active.isEmpty && integrated.count == 1 {
    let only = integrated[0]
    if only["active"] == nil && (only["backlightState"] == nil || only["backlightState"] as? String == "unknown") {
      return only["uniqueId"] as? String
    }
  }

  return nil
}
