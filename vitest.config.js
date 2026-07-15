import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const webpEncodeStub = path.resolve(rootDir, "test/mocks/webpEncodeBundled.stub.js");
const imageBufferStub = path.resolve(rootDir, "test/mocks/imageBufferToWebp.stub.js");
const partnerApiStub = path.resolve(rootDir, "test/mocks/partner-api.stub.js");

/** Redirect worker image utils that import bundled .wasm (Vitest cannot load them). */
function stubWasmImageUtilsForVitest() {
  return {
    name: "stub-wasm-image-utils-for-vitest",
    enforce: "pre",
    resolveId(source) {
      const s = String(source || "").replace(/\\/g, "/");
      if (s.endsWith("/webpEncodeBundled.js") || s.endsWith("webpEncodeBundled.js")) {
        return webpEncodeStub;
      }
      if (s.endsWith("/imageBufferToWebp.js") || s.endsWith("imageBufferToWebp.js")) {
        return imageBufferStub;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [stubWasmImageUtilsForVitest()],
  resolve: {
    alias: {
      "/partner/shared/js/partner-api.js": partnerApiStub,
    },
  },
  test: {
    testTimeout: 15000,
    include: ["test/**/*.test.{js,ts,mjs,cjs}"],
    exclude: [
      "e2e/**",
      "eazpire-app/**",
      "node_modules/**",
      "dist/**",
      ".cursor/**",
      "theme/**",
      "scripts/**",
      "debug/**",
      "test/admin-design-stubs.test.js",
    ],
  },
});
