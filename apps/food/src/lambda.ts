// Lambda entry for the food server. Configuration comes from environment
// variables set by Terraform (apps/food/infra).
//
// Bundled as an ES module so the top-level `await` below runs during the
// Lambda init phase: Lambda waits for it before sending the first request.

import { createMcpLambda } from "@mcp/shared";
import { createFoodServerFactory } from "./server";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const resource = env("RESOURCE"); // https://food.mcp.<env>.lab.michaelteplov.com/mcp
const readScope = `${resource}/food:read`;
const writeScope = `${resource}/food:write`;

const lambda = createMcpLambda(
  {
    region: env("AWS_REGION"),
    userPoolId: env("USER_POOL_ID"),
    clientIds: env("CLIENT_IDS").split(","),
    resource,
    scopes: [readScope, writeScope],
    resourceName: "Food tracker",
  },
  createFoodServerFactory({ readScope, writeScope }),
);

await lambda.prepare(); // Cognito's public keys, fetched during init

export const handler = lambda.handler;
