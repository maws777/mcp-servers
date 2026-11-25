import { defineConfig } from "vitest/config";
import { storeTestEnv } from "./apps/food/test/store/env";

// Two kinds of tests:
//   unit   pure logic (domain/), no network, milliseconds:   npm test
//   store  the DynamoDB code against DynamoDB Local:          npm run test:store
//          (docker run --rm -p 8000:8000 amazon/dynamodb-local:3.3.2)
//   eval   the daily summary against real models on Bedrock:  npm run eval:summary
//          (costs a little; by hand or weekly, never on pull requests)
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
          exclude: ["**/node_modules/**", "apps/*/test/store/**"],
        },
      },
      {
        test: {
          name: "store",
          include: ["apps/food/test/store/**/*.test.ts"],
          globalSetup: ["apps/food/test/store/global-setup.ts"],
          env: storeTestEnv,
        },
      },
      {
        test: {
          name: "eval",
          include: ["apps/food/eval/**/*.eval.ts"],
        },
      },
    ],
  },
});
