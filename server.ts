import "dotenv/config";
import cron from "node-cron";
import { createHttpApp } from "./server/app";
import { runAppointmentReminders } from "./server/reminders";
import { db } from "./server/firebase-init";

async function main() {
  try {
    const app = await createHttpApp();

    if (process.env.VERCEL !== "1") {
      cron.schedule("*/15 * * * *", async () => {
        try {
          await runAppointmentReminders(db);
        } catch (error) {
          console.error("[Reminder Job] Execution Error:", error);
        }
      });
    }

    const PORT = Number(process.env.PORT) || 3000;
    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `[Server] Listening on http://0.0.0.0:${PORT} (${process.env.NODE_ENV || "dev"})`
      );
    });
  } catch (err) {
    console.error("Critical error starting server:", err);
  }
}

main();
