#version 300 es

layout(location = 0) in vec2 position;
layout(location = 1) in vec2 atlasCoordinate;
layout(location = 2) in vec3 foregroundColor;

out vec2 atlasUv;
out vec4 textColor;

void main() {
    gl_Position = vec4(position, 0.0, 1.0);
    atlasUv = atlasCoordinate;
    textColor = vec4(foregroundColor, 1.0);
}
