const baseRules = {
  "no-const-assign": "error",
  "no-dupe-args": "error",
  "no-dupe-keys": "error",
  "no-redeclare": "error",
  "no-undef": "error",
  "no-unreachable": "error",
  "no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
      varsIgnorePattern: "^_"
    }
  ]
};

const browserGlobals = {
  AbortController: "readonly",
  DOMException: "readonly",
  HashChangeEvent: "readonly",
  HTMLCanvasElement: "readonly",
  HTMLVideoElement: "readonly",
  Image: "readonly",
  IntersectionObserver: "readonly",
  KeyboardEvent: "readonly",
  PublicKeyCredential: "readonly",
  Response: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  WebAssembly: "readonly",
  URLSearchParams: "readonly",
  cancelAnimationFrame: "readonly",
  caches: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  clients: "readonly",
  CustomEvent: "readonly",
  Event: "readonly",
  console: "readonly",
  crypto: "readonly",
  document: "readonly",
  fetch: "readonly",
  indexedDB: "readonly",
  localStorage: "readonly",
  location: "readonly",
  navigator: "readonly",
  performance: "readonly",
  registration: "readonly",
  requestAnimationFrame: "readonly",
  self: "readonly",
  sessionStorage: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  skipWaiting: "readonly",
  screen: "readonly",
  turnstile: "readonly",
  window: "readonly"
};

const testGlobals = {
  afterAll: "readonly",
  afterEach: "readonly",
  beforeAll: "readonly",
  beforeEach: "readonly",
  describe: "readonly",
  expect: "readonly",
  global: "readonly",
  globalThis: "readonly",
  it: "readonly",
  test: "readonly",
  vi: "readonly"
};

export default [
  {
    ignores: ["coverage/**", "node_modules/**", "dist/**"]
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: browserGlobals,
      sourceType: "module"
    },
    rules: baseRules
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...browserGlobals,
        ...testGlobals
      },
      sourceType: "module"
    },
    rules: baseRules
  }
];
