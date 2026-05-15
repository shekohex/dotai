#version 300 es

precision mediump float;

in vec2 atlasUv;
in vec4 textColor;

uniform sampler2D glyphAtlas;

out vec4 fragmentColor;

void main() {
    float coverage = texture(glyphAtlas, atlasUv).r;
    if (coverage <= 0.01) discard;
    fragmentColor = vec4(textColor.rgb, textColor.a * coverage);
}
