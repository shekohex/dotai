#version 300 es

precision highp float;
precision highp sampler2D;

in vec2 atlasUv;
in vec4 textColor;
in vec4 cellBackgroundColor;

uniform sampler2D glyphAtlas;

out vec4 fragmentColor;

float linearize(float value) {
    return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4);
}

float unlinearize(float value) {
    return value <= 0.0031308 ? value * 12.92 : pow(value, 1.0 / 2.4) * 1.055 - 0.055;
}

float luminance(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

vec3 linearize(vec3 color) {
    return vec3(linearize(color.r), linearize(color.g), linearize(color.b));
}

void main() {
    vec4 glyph = texture(glyphAtlas, atlasUv);
    if (cellBackgroundColor.a > 0.5) {
        if (glyph.a <= 0.01) discard;
        fragmentColor = glyph * textColor.a;
        return;
    }
    float coverage = glyph.a;
    float foregroundLuminance = luminance(linearize(textColor.rgb));
    float backgroundLuminance = luminance(linearize(cellBackgroundColor.rgb));
    if (abs(foregroundLuminance - backgroundLuminance) > 0.001) {
        float blendedLuminance = linearize(unlinearize(foregroundLuminance) * coverage + unlinearize(backgroundLuminance) * (1.0 - coverage));
        coverage = clamp((blendedLuminance - backgroundLuminance) / (foregroundLuminance - backgroundLuminance), 0.0, 1.0);
    }
    if (coverage <= 0.01) discard;
    float alpha = coverage * textColor.a;
    fragmentColor = vec4(textColor.rgb * alpha, alpha);
}
