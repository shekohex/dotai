#version 300 es

precision mediump float;

in vec4 fillColor;
out vec4 fragmentColor;

void main() {
    fragmentColor = fillColor;
}
