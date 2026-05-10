import express, { type Express } from "express";
import path from "path";
import cors from "cors";
import { FieldValue } from "firebase-admin/firestore";
import { db, hasFirebaseAdminCredentials } from "./firebase-init.js";
import { runAppointmentReminders } from "./reminders.js";
import { attachGeminiRoutes } from "./gemini-routes.js";

/** Avoid Vercel 504 when Firestore hangs (wrong DB / network) — fail fast so the client can deduct. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

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

    const pickPoints = (v: unknown, fallback: number) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    const defaultCosts = {
      textPrompt: 1,
      imageGen: 5,
      voicePrompt: 2,
    };

    const firestoreBudgetMs = Math.min(
      Number(process.env.DEDUCT_FIRESTORE_TIMEOUT_MS) || 9_000,
      25_000
    );

    try {
      console.log(`[Deduct Credits] userId: ${userId}, type: ${type}`);

      await withTimeout(
        (async () => {
          const settingsSnap = await db.collection("settings").doc("app").get();
          const settingsData = settingsSnap.exists ? settingsSnap.data() : {};
          const costsLive = settingsData?.creditCosts || defaultCosts;
          let pts = pickPoints(costsLive.textPrompt, 1);
          if (type === "voice") pts = pickPoints(costsLive.voicePrompt, 2);
          if (type === "image" || type === "mixed" || type === "recommendation")
            pts = pickPoints(costsLive.imageGen, 5);
          const pointsFinal = pts < 1 ? 1 : pts;

          const userRef = db.collection("users").doc(userId);
          await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (!userDoc.exists) throw new Error("User not found");
            const rawBal = userDoc.data()?.creditBalance;
            const balance = Math.floor(Number(rawBal));
            const balOk = Number.isFinite(balance) ? balance : 0;
            if (balOk < pointsFinal) throw new Error("Insufficient credits");
            transaction.update(userRef, {
              creditBalance: balOk - pointsFinal,
              updatedAt: FieldValue.serverTimestamp(),
            });
          });
        })(),
        firestoreBudgetMs,
        "deduct_credits"
      );

      res.json({ success: true });
    } catch (e: unknown) {
      console.error("[Deduct Credits]", e);
      const msg = e instanceof Error ? e.message : "Deduction failed";
      if (msg.includes("timed out after")) {
        return res.status(503).json({
          success: false,
          code: "DEDUCT_TIMEOUT",
          error:
            "Server Firestore did not respond in time. The app will try client-side deduction.",
        });
      }
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
