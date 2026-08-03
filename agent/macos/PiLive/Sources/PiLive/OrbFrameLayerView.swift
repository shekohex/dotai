import AppKit
import SwiftUI

struct OrbFrameLayerRepresentable: NSViewRepresentable {
    let image: NSImage?
    let mirroredHorizontally: Bool

    func makeNSView(context: Context) -> OrbFrameLayerView {
        OrbFrameLayerView()
    }

    func updateNSView(_ view: OrbFrameLayerView, context: Context) {
        view.update(image: image, mirroredHorizontally: mirroredHorizontally)
    }
}

final class OrbFrameLayerView: NSView {
    private let imageLayer = CALayer()
    private(set) var renderedImage: NSImage?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        imageLayer.contentsGravity = .resizeAspect
        imageLayer.magnificationFilter = .linear
        imageLayer.minificationFilter = .linear
        layer?.addSublayer(imageLayer)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        imageLayer.frame = bounds
        CATransaction.commit()
    }

    func update(image: NSImage?, mirroredHorizontally: Bool) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if renderedImage !== image {
            var proposedRect = NSRect(origin: .zero, size: image?.size ?? .zero)
            imageLayer.contents = image?.cgImage(
                forProposedRect: &proposedRect,
                context: nil,
                hints: nil
            )
            renderedImage = image
        }
        imageLayer.setAffineTransform(CGAffineTransform(
            scaleX: mirroredHorizontally ? -1 : 1,
            y: 1
        ))
        CATransaction.commit()
    }

    var imageLayerCount: Int {
        layer?.sublayers?.filter { $0 === imageLayer }.count ?? 0
    }
}
