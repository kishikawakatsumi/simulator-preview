import CoreImage
import VideoToolbox

struct EncodedFrame {
  let data: Data
  let revision: Int
  let timestampMicroseconds: UInt64
  let isKeyframe: Bool
  let width: Int
  let height: Int
}

/// Mutable state is confined to the capture queue. Only one frame is outstanding;
/// its callback reads the sample buffer and never mutates encoder configuration.
final class H264Encoder: @unchecked Sendable {
  private var session: VTCompressionSession?
  private var pool: CVPixelBufferPool?
  private var size = CGSize.zero
  private var activeBitrate = 0
  private let context = CIContext(options: [.cacheIntermediates: false])
  let fps: Int
  let maxEdge: Int

  init(fps: Int, maxEdge: Int) {
    self.fps = fps
    self.maxEdge = maxEdge
  }

  deinit { if let session { VTCompressionSessionInvalidate(session) } }

  func encode(
    image original: CIImage, revision: Int, bitrate: Int, forceKeyframe: Bool,
    completion: @escaping (Result<EncodedFrame, Error>) -> Void
  ) {
    do {
      let scale = min(1, Double(maxEdge) / max(original.extent.width, original.extent.height))
      var width = max(2, Int(original.extent.width * scale) / 2 * 2)
      var height = max(2, Int(original.extent.height * scale) / 2 * 2)
      // Match the negotiated level 3.1: 3,600 macroblocks per frame and
      // 108,000 per second. Wider iPads or higher fps may need extra scaling.
      let macroblocks = min(3600, 108_000 / fps)
      while ((width + 15) / 16) * ((height + 15) / 16) > macroblocks {
        if width >= height {
          width -= 2
          height = max(
            2, Int(Double(width) * original.extent.height / original.extent.width) / 2 * 2)
        } else {
          height -= 2
          width = max(
            2, Int(Double(height) * original.extent.width / original.extent.height) / 2 * 2)
        }
      }
      let changed = size != CGSize(width: width, height: height)
      if changed { try configure(width: width, height: height, bitrate: bitrate) }
      guard let session, let pool else { throw EncoderError("Encoder is unavailable") }
      if activeBitrate != bitrate {
        try check(
          VTSessionSetProperty(
            session, key: kVTCompressionPropertyKey_AverageBitRate,
            value: bitrate as CFNumber), "Set bitrate")
        activeBitrate = bitrate
      }
      var buffer: CVPixelBuffer?
      try check(CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer), "Allocate frame")
      guard let buffer else { throw EncoderError("Empty pixel buffer") }
      let image = original.transformed(
        by: CGAffineTransform(
          translationX: -original.extent.minX,
          y: -original.extent.minY)
      )
      .transformed(
        by: CGAffineTransform(
          scaleX: Double(width) / original.extent.width,
          y: Double(height) / original.extent.height))
      context.render(
        image, to: buffer, bounds: CGRect(x: 0, y: 0, width: width, height: height),
        colorSpace: CGColorSpaceCreateDeviceRGB())
      let timestamp = UInt64(ProcessInfo.processInfo.systemUptime * 1_000_000)
      let properties: CFDictionary? =
        (changed || forceKeyframe)
        ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
      let status = VTCompressionSessionEncodeFrame(
        session, imageBuffer: buffer,
        presentationTimeStamp: CMTime(value: Int64(timestamp), timescale: 1_000_000),
        duration: CMTime(value: 1, timescale: Int32(fps)), frameProperties: properties,
        infoFlagsOut: nil
      ) { status, _, sample in
        do {
          try self.check(status, "Encode H.264")
          guard let sample else { throw EncoderError("Encoder dropped a frame") }
          let (data, keyframe) = try Self.annexB(sample)
          completion(
            .success(
              EncodedFrame(
                data: data, revision: revision,
                timestampMicroseconds: timestamp, isKeyframe: keyframe, width: width, height: height
              )))
        } catch { completion(.failure(error)) }
      }
      try check(status, "Submit frame")
    } catch { completion(.failure(error)) }
  }

  private func configure(width: Int, height: Int, bitrate: Int) throws {
    if let session { VTCompressionSessionInvalidate(session) }
    session = nil
    pool = nil
    size = .zero
    let attributes: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferWidthKey: width, kCVPixelBufferHeightKey: height,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as [String: Any],
    ]
    try check(
      VTCompressionSessionCreate(
        allocator: nil, width: Int32(width), height: Int32(height),
        codecType: kCMVideoCodecType_H264,
        encoderSpecification: [
          kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true
        ] as CFDictionary,
        imageBufferAttributes: attributes as CFDictionary, compressedDataAllocator: nil,
        outputCallback: nil, refcon: nil, compressionSessionOut: &session),
      "Create hardware encoder")
    guard let session else { throw EncoderError("Hardware H.264 encoder unavailable") }
    let properties: [CFString: Any] = [
      kVTCompressionPropertyKey_RealTime: true,
      kVTCompressionPropertyKey_AllowFrameReordering: false,
      kVTCompressionPropertyKey_ProfileLevel: kVTProfileLevel_H264_Baseline_3_1,
      kVTCompressionPropertyKey_ExpectedFrameRate: fps,
      kVTCompressionPropertyKey_MaxKeyFrameInterval: fps * 2,
      kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration: 2,
      kVTCompressionPropertyKey_AverageBitRate: bitrate,
    ]
    try check(
      VTSessionSetProperties(session, propertyDictionary: properties as CFDictionary),
      "Configure encoder")
    try check(VTCompressionSessionPrepareToEncodeFrames(session), "Prepare encoder")
    pool = VTCompressionSessionGetPixelBufferPool(session)
    size = CGSize(width: width, height: height)
    activeBitrate = bitrate
  }

  /// AVCC length-prefixed NALs become Annex B. Include SPS/PPS with every IDR
  /// so late joiners and recovering receivers can decode independently.
  private static func annexB(_ sample: CMSampleBuffer) throws -> (Data, Bool) {
    guard let format = CMSampleBufferGetFormatDescription(sample),
      let block = CMSampleBufferGetDataBuffer(sample)
    else { throw EncoderError("Invalid H.264 output") }
    let attachments =
      CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
      as? [[CFString: Any]]
    let keyframe = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool != true
    var output = Data()
    let start = Data([0, 0, 0, 1])
    var nalLength: Int32 = 0
    var count = 0
    let parameterStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
      format, parameterSetIndex: 0,
      parameterSetPointerOut: nil, parameterSetSizeOut: nil, parameterSetCountOut: &count,
      nalUnitHeaderLengthOut: &nalLength)
    guard parameterStatus == noErr, nalLength == 4 else {
      throw EncoderError("Unsupported NAL format")
    }
    if keyframe {
      for index in 0..<count {
        var pointer: UnsafePointer<UInt8>?
        var length = 0
        guard
          CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: index,
            parameterSetPointerOut: &pointer, parameterSetSizeOut: &length,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr,
          let pointer
        else { throw EncoderError("Missing H.264 parameter set") }
        output.append(start)
        output.append(pointer, count: length)
      }
    }
    var bytes = Data(count: CMBlockBufferGetDataLength(block))
    let copyStatus = bytes.withUnsafeMutableBytes {
      CMBlockBufferCopyDataBytes(
        block, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!)
    }
    guard copyStatus == noErr else { throw EncoderError("Cannot read H.264 frame") }
    var offset = 0
    while offset + 4 <= bytes.count {
      let length = bytes[offset..<offset + 4].reduce(0) { ($0 << 8) | Int($1) }
      offset += 4
      guard length > 0, offset + length <= bytes.count else {
        throw EncoderError("Truncated H.264 NAL")
      }
      output.append(start)
      output.append(bytes[offset..<offset + length])
      offset += length
    }
    guard offset == bytes.count else { throw EncoderError("Trailing H.264 data") }
    return (output, keyframe)
  }

  private func check(_ status: OSStatus, _ operation: String) throws {
    if status != noErr { throw EncoderError("\(operation) failed (\(status))") }
  }
}

struct EncoderError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
