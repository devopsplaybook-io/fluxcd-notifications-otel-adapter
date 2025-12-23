const fs = require("fs");
let devEnv = {};
if (fs.existsSync("./env-dev.js")) {
  devEnv = require("./env-dev");
}

module.exports = {
  apps: [
    {
      name: "fluxcd-notifications-otel-adapter-proxy",
      cwd: "fluxcd-notifications-otel-adapter-proxy",
      script: "npm",
      args: "run start",
      autorestart: false,
      ignore_watch: ["node_modules"],
    },
    {
      name: "fluxcd-notifications-otel-adapter-server",
      cwd: "fluxcd-notifications-otel-adapter-server",
      script: "npm",
      args: "run dev",
      autorestart: false,
      env_development: {
        ...devEnv,
        DEV_MODE: "true",
        DATA_DIR: "../docs/dev/data",
      },
    },
    {
      name: "fluxcd-notifications-otel-adapter-web",
      cwd: "fluxcd-notifications-otel-adapter-web",
      script: "npm",
      args: "run dev",
      autorestart: false,
      env_development: {
        DEV_MODE: "true",
      },
    },
  ],
};
