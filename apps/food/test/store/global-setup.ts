// Runs once before the store tests: a fresh test table in DynamoDB Local,
// with the same keys as the real one (infra/main.tf).
//
// Refuses any endpoint that isn't on this machine: these tests write and
// delete freely, and must never be able to reach a real table.

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { storeTestEnv as env } from "./env";

export default async function setup() {
  const endpoint = new URL(env.AWS_ENDPOINT_URL_DYNAMODB);
  if (!["localhost", "127.0.0.1"].includes(endpoint.hostname)) {
    throw new Error(`store tests only run against DynamoDB Local, not ${endpoint.host}`);
  }

  const client = new DynamoDBClient({
    endpoint: endpoint.toString(),
    region: env.AWS_REGION,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
  });
  const TableName = env.TABLE_NAME;

  try {
    await client.send(new DeleteTableCommand({ TableName }));
  } catch (e) {
    if (e instanceof ResourceNotFoundException) {
      // first run: nothing to delete
    } else if ((e as NodeJS.ErrnoException).code === "ECONNREFUSED" || (e as Error).name === "TimeoutError") {
      throw new Error(
        `DynamoDB Local isn't answering on ${endpoint.host}. Start it with:\n  docker run --rm -p 8000:8000 amazon/dynamodb-local:3.3.2`,
      );
    } else {
      throw e;
    }
  }

  await client.send(
    new CreateTableCommand({
      TableName,
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "PK", AttributeType: "S" },
        { AttributeName: "SK", AttributeType: "S" },
      ],
    }),
  );
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName });
  client.destroy();
}
