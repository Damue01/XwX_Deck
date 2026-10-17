import AppKit
import Foundation

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let arguments = CommandLine.arguments
let output = arguments.firstIndex(of: "--output-directory").map {
  URL(fileURLWithPath: arguments[$0 + 1], isDirectory: true)
} ?? root.appendingPathComponent("assets/macos")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let width = 680
let height = 340

func smoothstep(_ start: Double, _ end: Double, _ value: Double) -> Double {
  let x = max(0, min(1, (value - start) / (end - start)))
  return x * x * (3 - 2 * x)
}

func mix(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }

// Match ParticleField.tsx's native Canvas2D hash, including 32-bit wrapping.
func hash2(_ x: Int, _ y: Int) -> Double {
  var n = (UInt32(truncatingIfNeeded: x) &* 374761393)
    &+ (UInt32(truncatingIfNeeded: y) &* 668265263)
  n = (n ^ (n >> 13)) &* 1274126177
  return Double(n ^ (n >> 16)) / 4294967295
}

func noise(_ x: Double, _ y: Double) -> Double {
  let ix = Int(floor(x)), iy = Int(floor(y))
  let fx = x - Double(ix), fy = y - Double(iy)
  let ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
  return mix(mix(hash2(ix, iy), hash2(ix + 1, iy), ux),
             mix(hash2(ix, iy + 1), hash2(ix + 1, iy + 1), ux), uy)
}

func fbm(_ initialX: Double, _ initialY: Double) -> Double {
  var x = initialX, y = initialY, value = 0.0, weight = 0.5, total = 0.0
  for _ in 0..<4 {
    value += noise(x, y) * weight
    total += weight
    x = x * 2.03 + 17.1
    y = y * 2.03 + 9.2
    weight *= 0.5
  }
  return value / total
}

func iconQuiet(_ x: Double, _ y: Double) -> Double {
  let app = hypot((x - 170) / 75, (y - 152) / 83)
  let folder = hypot((x - 510) / 75, (y - 152) / 83)
  let appLabel = hypot((x - 170) / 64, (y - 202) / 19)
  let folderLabel = hypot((x - 510) / 70, (y - 202) / 19)
  return 0.16 + 0.84 * smoothstep(0.55, 1.4, min(app, folder, appLabel, folderLabel))
}

func dot(_ cg: CGContext, _ x: Double, _ y: Double, _ radius: Double) {
  cg.fillEllipse(in: CGRect(x: x - radius, y: y - radius,
                            width: radius * 2, height: radius * 2))
}

func drawTraceField(_ cg: CGContext) {
  // Freeze the approved native Trace frame: scale=96, dotSize=0.7, idle t=83.
  let step = 6.0, time = 83.0 * 0.4
  cg.setFillColor(CGColor(srgbRed: 11 / 255, green: 12 / 255, blue: 11 / 255, alpha: 1))
  for y in stride(from: -step, to: Double(height) + step, by: step) {
    for x in stride(from: -step, to: Double(width) + step, by: step) {
      let gx = x / step, gy = y / step
      let wx = fbm(gx * 0.038 + time * 0.22, gy * 0.038 + 4.1) - 0.5
      let wy = fbm(gx * 0.038 + 8.2, gy * 0.038 - time * 0.17) - 0.5
      let n1 = fbm(gx * 0.058 + wx * 0.92 + time * 0.52, gy * 0.058 + wy * 0.92 + time * 0.13)
      let n2 = fbm(gx * 0.030 - time * 0.10, gy * 0.030 + time * 0.18)
      let fine = fbm(gx * 0.115 - time * 0.14, gy * 0.115 + time * 0.10)
      let value = max(0, min(1, ((n1 * 0.76 + n2 * 0.18 - 0.008) - 0.5) * 1.04 + 0.5))
      let speckle = smoothstep(0.50, 0.82, fine) * 0.12 * (1 - smoothstep(0.42, 0.82, value))
      let growth = pow(smoothstep(0.31, 0.81, min(1, value + speckle)), 1.08)
      let radius = 0.7 * step * (0.028 + growth * 0.338)
      let arrowQuiet = 0.1 + 0.9 * smoothstep(0.6, 1.3, hypot((x - 340) / 60, (y - 140) / 31))
      guard radius > 0.05 else { continue }
      cg.setAlpha(0.78 * iconQuiet(x, y) * arrowQuiet)
      dot(cg, x, y, radius)
    }
  }
  cg.setAlpha(1)
}

func drawSingleFeatherArrow(_ cg: CGContext) {
  // Equal-size, equal-color dots. The three strokes share one tip.
  cg.setFillColor(CGColor(srgbRed: 85 / 255, green: 87 / 255, blue: 81 / 255, alpha: 1))
  let radius = 1.25, tipX = 379.6, centerY = 140.0
  for i in 0...12 { dot(cg, 300.4 + Double(i) * 6.6, centerY, radius) }
  for i in 1...5 {
    let offset = 23.33 * Double(i) / 5
    dot(cg, tipX - offset, centerY - offset, radius)
    dot(cg, tipX - offset, centerY + offset, radius)
  }
}

for scale in [1, 2] {
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: width * scale, pixelsHigh: height * scale,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
  ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Cannot create DMG background")
  }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = context
  context.imageInterpolation = .high
  let cg = context.cgContext
  cg.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
  // Use the same top-left coordinates as the approved preview and Finder.
  cg.translateBy(x: 0, y: CGFloat(height))
  cg.scaleBy(x: 1, y: -1)
  cg.setFillColor(CGColor(srgbRed: 252 / 255, green: 252 / 255, blue: 251 / 255, alpha: 1))
  cg.fill(CGRect(x: 0, y: 0, width: width, height: height))
  drawTraceField(cg)
  drawSingleFeatherArrow(cg)
  // Finder supplies the actual draggable icons and filenames; never bake them in.

  NSGraphicsContext.restoreGraphicsState()
  let name = scale == 1 ? "dmg-background.png" : "dmg-background@2x.png"
  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Cannot encode DMG background")
  }
  try png.write(to: output.appendingPathComponent(name))
}
