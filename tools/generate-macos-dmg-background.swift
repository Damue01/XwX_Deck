import AppKit
import Foundation

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let arguments = CommandLine.arguments
let output = arguments.firstIndex(of: "--output-directory").map {
  URL(fileURLWithPath: arguments[$0 + 1], isDirectory: true)
} ?? root.appendingPathComponent("assets/macos")
let validation = arguments.contains("--validation")
let native = arguments.contains("--native")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let width = 680
let height = 380

func color(_ hex: UInt32, alpha: CGFloat = 1) -> NSColor {
  NSColor(calibratedRed: CGFloat((hex >> 16) & 0xff) / 255,
          green: CGFloat((hex >> 8) & 0xff) / 255,
          blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat,
          radius: CGFloat, fill: NSColor, stroke: NSColor? = nil) {
  let path = NSBezierPath(roundedRect: NSRect(x: x, y: y, width: w, height: h),
                          xRadius: radius, yRadius: radius)
  fill.setFill()
  path.fill()
  if let stroke {
    stroke.setStroke()
    path.lineWidth = 1
    path.stroke()
  }
}

func label(_ value: String, x: CGFloat, y: CGFloat, width: CGFloat,
           size: CGFloat, weight: NSFont.Weight, ink: NSColor,
           alignment: NSTextAlignment = .left) {
  let paragraph = NSMutableParagraphStyle()
  paragraph.alignment = alignment
  (value as NSString).draw(in: NSRect(x: x, y: y, width: width, height: size * 1.55),
                           withAttributes: [
                             .font: NSFont.systemFont(ofSize: size, weight: weight),
                             .foregroundColor: ink,
                             .paragraphStyle: paragraph
                           ])
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

  // AppKit uses a bottom-left origin. The palette and spacing mirror the
  // desktop's coss surfaces: paper, ink, muted text, hairlines and a small radius.
  rect(0, 0, 680, 380, radius: 0, fill: color(0xFCFCFB))
  rect(0, 260, 680, 1, radius: 0, fill: color(0xE6E6E4))
  label(validation ? "XwX Deck 验证版" : "XwX Deck", x: 364, y: 312, width: 220, size: 20,
        weight: .semibold, ink: color(0x17181A))
  label("macOS 安装", x: 364, y: 288, width: 190, size: 12,
        weight: .regular, ink: color(0x8B8D90))

  // Finder draws the real draggable icons here. The background stays quiet.
  rect(318, 168, 44, 44, radius: 9, fill: color(0xFFFFFF),
       stroke: color(0xE6E6E4))
  let arrow = NSBezierPath()
  arrow.move(to: NSPoint(x: 329, y: 190))
  arrow.line(to: NSPoint(x: 351, y: 190))
  arrow.move(to: NSPoint(x: 344, y: 197))
  arrow.line(to: NSPoint(x: 351, y: 190))
  arrow.line(to: NSPoint(x: 344, y: 183))
  arrow.lineWidth = 2
  arrow.lineCapStyle = .round
  arrow.lineJoinStyle = .round
  color(0x5A5C5F).setStroke()
  arrow.stroke()

  rect(42, 120, 596, 1, radius: 0, fill: color(0xE6E6E4))
  label(validation ? "将验证版拖到“应用程序”" : "先退出旧版，再拖到“应用程序”", x: 48, y: 86, width: 480, size: 17,
        weight: .semibold, ink: color(0x17181A))
  label(validation ? "本包仅用于隔离验收，启动方式见右上角“验证说明”。" : native ? "替换后从“应用程序”打开，安装完成可手动推出映像。" : "替换后从“应用程序”打开，新版会尝试推出映像。", x: 48, y: 62,
        width: 530, size: 12, weight: .regular, ink: color(0x5A5C5F))
  label(validation ? "正式新版仍在验收，请继续使用原来的 XwX Deck。" : "首次打开受阻时，双击右上角“首次打开说明”。", x: 48, y: 39,
        width: 530, size: 12, weight: .regular, ink: color(0x5A5C5F))
  NSGraphicsContext.restoreGraphicsState()
  let name = scale == 1 ? "dmg-background.png" : "dmg-background@2x.png"
  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Cannot encode DMG background")
  }
  try png.write(to: output.appendingPathComponent(name))
}
