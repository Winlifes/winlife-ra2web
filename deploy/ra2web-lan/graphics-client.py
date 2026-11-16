"""Observe the real renderer; leave GPU hints, rendering and simulation unchanged."""

def patch_client(text):
    context_hook = 'window.winlifeGraphics?.attach(t.getContext(),t.domElement),'
    if context_hook not in text:
        before = 't.localClippingEnabled=!0,t.toneMapping=GA.NoToneMapping,t}setViewportSize'
        after = 't.localClippingEnabled=!0,t.toneMapping=GA.NoToneMapping,' + context_hook + 't}setViewportSize'
        assert text.count(before) == 1, 'Native WebGL renderer changed'
        text = text.replace(before, after, 1)
    frame_hook = ',window.winlifeGraphics?.frame(performance.now())'
    if frame_hook not in text:
        before = 'this.renderer.render(e.scene,e.camera)}))}flush()'
        assert text.count(before) == 1, 'Native renderer draw changed'
        text = text.replace(before, 'this.renderer.render(e.scene,e.camera)})' + frame_hook + ')}flush()', 1)
    assert text.count(context_hook) == 1 and text.count(frame_hook) == 1
    assert text.count('preserveDrawingBuffer:!0,powerPreference:"high-performance"') == 1
    return text
