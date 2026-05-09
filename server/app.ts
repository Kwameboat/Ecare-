import express, { type Express } from "express";
import path from "path";
import cors from "cors";
import { FieldValue } from "firebase-admin/firestore";
import { db, hasFirebaseAdminCredentials } from "./firebase-init.js";
import { runAppointmentReminders } from "./reminders.js";
import { attachGeminiRoutes } from "./gemini-routes.js";

export async function createHttpApp(): Promise<Express> {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "50mb" }));

  attachGeminiRoutes(app);

  app.get("/manifest.json", async (req, res) => {
    try {
      if (process.env.VERCEL === "1" && !hasFirebaseAdminCredentials()) {
        res.sendFile(path.resolve("public/manifest.json"));
        return;
      }
      const settingsSnap = await db.collection("settings").doc("app").get();
      const settings = settingsSnap.exists ? settingsSnap.data() : {};
      const logoUrl =
        settings?.logoUrl ||
        "https://cdn-icons-png.flaticon.com/512/2869/2869382.png";
      const appName = settings?.appName || "eCare GH AI";
      const tagline =
        settings?.tagline || "Your Intelligent Healthcare Companion";

      res.json({
        name: appName,
        short_name: appName.split(" ")[0],
        description: tagline,
        start_url: "/",
        display: "standalone",
        background_color: "#020203",
        theme_color: "#2563eb",
        icons: [
          {
            src: logoUrl,
            sizes: "192x192",
            type: logoUrl.includes(".svg") ? "image/svg+xml" : "image/png",
          },
          {
            src: logoUrl,
            sizes: "512x512",
            type: logoUrl.includes(".svg") ? "image/svg+xml" : "image/png",
          },
        ],
      });
    } catch (error) {
      console.error("Manifest generation error:", error);
      res.sendFile(path.resolve("public/manifest.json"));
    }
  });

  app.post("/api/deduct-credits", async (req, res) => {
    const { userId, type } = req.body as { userId?: string; type?: string };
    if (!userId)
      return res.status(400).json({ success: false, error: "userId is required" });

    if (process.env.VERCEL === "1" && !hasFirebaseAdminCredentials()) {
      return res.status(503).json({
        success: false,
        code: "MISSING_FIREBASE_ADMIN",
        error:
          "Server missing FIREBASE_SERVICE_ACCOUNT_JSON. In Firebase Console → Project settings → Service accounts → Generate new private key, then add the full JSON as one line in Vercel → Environment Variables and redeploy.",
      });
    }

    const settingsSnap = await db.collection("settings").doc("app").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const costs = settings?.creditCosts || {
      textPrompt: 1,
      imageGen: 5,
      voicePrompt: 2,
    };

    let points = costs.textPrompt as number;
    if (type === "voice") points = costs.voicePrompt as number;
    if (type === "image" || type === "mixed" || type === "recommendation")
      points = costs.imageGen as number;

    try {
      console.log(`[Deduct Credits] userId: ${userId}, type: ${type}`);

      const userRef = db.collection("users").doc(userId);

      await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) throw new Error("User not found");
        const balance = (userDoc.data()?.creditBalance as number) ?? 0;
        if (balance < points) throw new Error("Insufficient credits");
        transaction.update(userRef, {
          creditBalance: balance - points,
          updatedAt: FieldValue.serverTimestamp(),
        });
      });

      res.json({ success: true });
    } catch (e: unknown) {
      console.error("[Deduct Credits]", e);
      const msg = e instanceof Error ? e.message : "Deduction failed";
      res.status(400).json({ success: false, error: msg });
    }
  });

  app.post("/api/verify-payment", async (req, res) => {
    try {
      const { reference } = req.body as { reference?: string };
      if (!reference?.trim()) {
        return res.status(400).json({ success: false, error: "reference required" });
      }

      if (process.env.VERCEL === "1" && !hasFirebaseAdminCredentials()) {
        return res.status(503).json({
          success: false,
          code: "MISSING_FIREBASE_ADMIN",
          error:
            "Add FIREBASE_SERVICE_ACCOUNT_JSON on Vercel for Paystack verification (Firebase Console → Service accounts → Generate key).",
        });
      }

      const secretSnap = await db.collection("settings").doc("paystack").get();
      const secretKey = secretSnap.data()?.secretKey as string | undefined;
      if (!secretKey?.trim()) {
        return res.status(500).json({
          success: false,
          error: "Paystack secret not configured (settings/paystack)",
        });
      }

      const verifyRes = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference.trim())}`,
        { headers: { Authorization: `Bearer ${secretKey.trim()}` } }
      );
      const verifyJson = (await verifyRes.json()) as {
        status?: boolean;
        message?: string;
        data?: {
          status?: string;
          metadata?: Record<string, unknown>;
        };
      };

      if (!verifyJson.status || verifyJson.data?.status !== "success") {
        return res.json({
          success: false,
          error: verifyJson.message || "Verification failed",
        });
      }

      const meta = verifyJson.data?.metadata || {};
      const userId = meta.userId as string | undefined;
      const credits = meta.credits != null ? Number(meta.credits) : NaN;

      if (userId && Number.isFinite(credits) && credits > 0) {
        const userRef = db.collection("users").doc(userId);
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(userRef);
          if (!snap.exists) throw new Error("User not found for credit grant");
          const balance = (snap.data()?.creditBalance as number) ?? 0;
          tx.update(userRef, {
            creditBalance: balance + credits,
            updatedAt: FieldValue.serverTimestamp(),
          });
          const txRef = userRef.collection("transactions").doc();
          tx.set(txRef, {
            type: "credit_purchase",
            credits,
            reference: reference.trim(),
            packageId: (meta.packageId as string) || null,
            createdAt: FieldValue.serverTimestamp(),
          });
        });
      }

      return res.json({ success: true });
    } catch (e: unknown) {
      console.error("[Verify Payment]", e);
      const msg = e instanceof Error ? e.message : "Verification error";
      return res.status(500).json({ success: false, error: msg });
    }
  });

  app.get("/api/cron/reminders", async (_req, res) => {
    if (process.env.VERCEL === "1" && !hasFirebaseAdminCredentials()) {
      return res.status(503).json({
        ok: false,
        code: "MISSING_FIREBASE_ADMIN",
        error: "Set FIREBASE_SERVICE_ACCOUNT_JSON on Vercel for cron / Firestore.",
      });
    }
    try {
      await runAppointmentReminders(db);
      res.json({ ok: true });
    } catch (e: unknown) {
      console.error("[Cron reminders]", e);
      res.status(500).json({ ok: false });
    }
  });

  const onVercel = process.env.VERCEL === "1";
  const isProd = process.env.NODE_ENV === "production";

  if (isProd && onVercel) {
    const distDir = path.join(process.cwd(), "dist");
    app.use(express.static(distDir));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      res.sendFile(path.join(distDir, "index.html"), (err) => {
        if (err) next(err);
      });
    });
    app.use((req, res) => {
      if (req.path.startsWith("/api")) {
        return res.status(404).json({ error: "Not found" });
      }
      res.status(404).send("Not found");
    });
  } else if (!onVercel) {
    // Dynamic import only for local dev — never load Vite/Rollup on Vercel (native optional deps break Linux lambdas).
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: process.cwd(),
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  return app;
}
