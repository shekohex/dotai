#version 300 es

layout(location = 0) in vec2 position;
layout(location = 1) in vec2 atlasCoordinate;
layout(location = 2) in vec4 foregroundColor;
layout(location = 3) in vec4 backgroundColor;

out vec2 atlasUv;
out vec4 textColor;
out vec3 cellBackgroundColor;

void main() {
    gl_Position = vec4(position, 0.0, 1.0);
    atlasUv = atlasCoordinate;
    textColor = foregroundColor;
    cellBackgroundColor = backgroundColor.rgb;
}
