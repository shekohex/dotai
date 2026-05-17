#version 300 es

precision mediump float;

in vec2 atlasUv;
in vec4 textColor;

uniform sampler2D glyphAtlas;

out vec4 fragmentColor;

void main() {
    vec4 glyph = texture(glyphAtlas, atlasUv);
    if (textColor.a > 0.5) {
        if (glyph.a <= 0.01) discard;
        fragmentColor = glyph;
        return;
    }
    float coverage = glyph.a;
    if (coverage <= 0.01) discard;
    fragmentColor = vec4(textColor.rgb, coverage);
}
