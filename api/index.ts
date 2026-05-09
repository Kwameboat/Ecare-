import "dotenv/config";
import serverless from "serverless-http";
import { createHttpApp } from "../server/app";

const handlerPromise = (async () => {
  const app = await createHttpApp();
  return serverless(app);
})();

export default async function handler(req: unknown, res: unknown) {
  const handle = await handlerPromise;
  return handle(req, res);
}
