import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["../tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgres://blinxot:blinxot_dev@localhost:5432/blinxot_test",
      JWT_ACCESS_SECRET: "test-secret-test-secret-test-secret-123456",
      UPLOAD_DIR: "./.test-uploads",
      CLIENT_DIST: "../client",
    },
  },
});
