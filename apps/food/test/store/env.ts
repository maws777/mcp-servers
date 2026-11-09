// Environment for the store tests. The app's DynamoDB client is created with
// defaults (src/store/db.ts), and the AWS SDK reads AWS_ENDPOINT_URL_DYNAMODB
// on its own, so the tests point the real code at DynamoDB Local without any
// test-only branch in it. Fake credentials: DynamoDB Local accepts anything,
// and environment credentials win over any AWS profile set on the machine.
export const storeTestEnv = {
  AWS_ENDPOINT_URL_DYNAMODB: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  AWS_REGION: "eu-west-3",
  AWS_ACCESS_KEY_ID: "local",
  AWS_SECRET_ACCESS_KEY: "local",
  TABLE_NAME: "mcp-food-test",
};
