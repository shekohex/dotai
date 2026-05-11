// Vite globals injected at build time
declare const __APP_VERSION__: string;

// declare webp

declare module "*.webp" {
  const content: string;
  export default content;
}

declare module "*.png" {
  const content: string;
  export default content;
}
