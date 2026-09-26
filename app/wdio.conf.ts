/** macOS 原生测试专用：只连接显式启用 wdio-test 特性的本机调试二进制。 */
export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./native-e2e/**/*.spec.ts"],
  maxInstances: 1,
  services: [["tauri", {
    appBinaryPath: "./src-tauri/target/debug/ebbinghaus-v2",
    driverProvider: "embedded",
  }]],
  capabilities: [{
    browserName: "tauri",
    "tauri:options": { application: "./src-tauri/target/debug/ebbinghaus-v2" },
  }],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 15000,
  connectionRetryTimeout: 30000,
  connectionRetryCount: 1,
  mochaOpts: { ui: "bdd", timeout: 60000 },
};
