const path = require("node:path");

module.exports = {
  apps: [
    {
      // Give each example repo its own folder name on the Pi.
      name: path.basename(__dirname),
      cwd: __dirname,
      script: "./dist/index.js",
      exec_mode: "fork",
      instances: 1,
      watch: false,
      autorestart: true,
      restart_delay: 10000,
      min_uptime: 10000,
      max_restarts: 10,
      kill_timeout: 20000,
      env: { NODE_ENV: "production" },
    },
  ],
};
