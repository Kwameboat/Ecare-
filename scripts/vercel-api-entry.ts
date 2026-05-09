/**
 * Bundled by esbuild into api/index.js during `npm run build`.
 * Keeps all Express + Firebase + Gemini code in one serverless file on Vercel.
 */
import "dotenv/config";
import serverless from "serverless-http";
import { createHttpApp } from "../server/app.js";

const handlerPromise = (async () => {
  const app = await createHttpApp();
  return serverless(app);
})();

export default async function handler(req: unknown, res: unknown) {
  const handle = await handlerPromise;
  return handle(req, res);
}
