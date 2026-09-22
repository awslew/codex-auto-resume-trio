import js from "@eslint/js";
import tseslint from "typescript-eslint";

const browserGlobals = {
  window: "readonly",
  document: "readonly",
  fetch: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setTimeout: "readonly",
  console: "readonly",
  URL: "readonly"
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "vitest.config.ts",
      "**/tests/fixtures/*.js",
      // 状态页的前端资源（浏览器环境，不是 Node 模块）：由浏览器直接加载，
      // 语法正确性由 tests/host.test.mjs 的静态资源冒烟断言兜底。
      "apps/resume-host/ui/**",
      // 配额仪表盘的前端页面同样是浏览器脚本（由 Python 的 http.server 直接吐给浏览器）。
      "apps/quota-dashboard/dashboard_ui/*.js"
    ]
  },
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    // 宿主是 Node ESM（.mjs）：给它 Node 的全局，避免 no-undef 误报。
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        URL: "readonly",
        ...browserGlobals
      }
    }
  }
);
