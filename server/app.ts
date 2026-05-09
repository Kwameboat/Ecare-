import express, { type Express } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import cors from "cors";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase-init";
import { runAppointmentReminders } from "./reminders";

export async function createHttpApp(): Promise<Express> {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "50mb" }));

  app.get("/manifest.json", async (req, res) => {
    try {
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
    const { userId, type } = req.body;
    if (!userId)
      return res.status(400).json({ success: false, error: "userId is required" });

    const settingsSnap = await db.collection("settings").doc("app").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const costs = settings?.creditCosts || {
      textPrompt: 1,
      imageGen: 5,
      voicePrompt: 2,
    };

    let points = costs.textPrompt;
    if (type === "voice") points = costs.voicePrompt;
    if (type === "image" || type === "mixed" || type === "recommendation")
      points = costs.imageGen;

    try {
      console.log(`[Deduct Credits] userId: ${userId}, type: ${type}`);

      const userRef = db.collection("users").doc(userId);

      const result = await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);

        if (!userDoc.exists) {
          return { success: false, error: "User document not initialized yet." };
        }

        const userData = userDoc.data();
        const currentCredits = userData?.creditBalance || 0;
        if (currentCredits < points) {
          return { success: false, error: "Insufficient credits" };
        }

        const newBalance = currentCredits - points;
        transaction.update(userRef, {
          creditBalance: newBalance,
          updatedAt: FieldValue.serverTimestamp(),
        });

        const transactionRef = userRef.collection("transactions").doc();
        transaction.set(transactionRef, {
          userId,
          type: "usage",
          amount: -points,
          description: `Used ${points} credits for ${type} request`,
          createdAt: FieldValue.serverTimestamp(),
        });

        return { success: true, deducted: points };
      });

      if (result.success) {
        res.json(result);

        (async () => {
          try {
            const userSnap = await userRef.get();
            const userData = userSnap.data();
            const newBalance = userData?.creditBalance || 0;
            const autoTopUp = userData?.autoTopUp;
            const paystackAuth = userData?.paystackAuth;

            if (
              autoTopUp?.enabled &&
              newBalance < autoTopUp.threshold &&
              paystackAuth
            ) {
              const paystackSnap = await db.collection("settings").doc("paystack").get();
              const secretKey = paystackSnap.exists
                ? paystackSnap.data()?.secretKey
                : null;

              if (secretKey) {
                const appSnap = await db.collection("settings").doc("app").get();
                const packages = appSnap.data()?.creditPackages || [];
                const pkg =
                  packages.find((p: { id: string }) => p.id === autoTopUp.packageId) ||
                  packages[0];

                if (pkg) {
                  const chargeResp = await fetch(
                    "https://api.paystack.co/transaction/charge_authorization",
                    {
                      method: "POST",
                      headers: {
                        Authorization: `Bearer ${secretKey}`,
                        "Content-Type": "application/json",
                      },
                      body: JSON.stringify({
                        email: userData.email,
                        amount: pkg.amount * 100,
                        authorization_code: paystackAuth.authorization_code,
                        metadata: {
                          userId: userId,
                          credits: pkg.credits,
                          packageId: pkg.id,
                          isAutoTopUp: true,
                        },
                      }),
                    }
                  );
                  const chargeData: { status?: boolean; data?: { status?: string } } =
                    await chargeResp.json();
                  if (chargeData.status && chargeData.data?.status === "success") {
                    await db.runTransaction(async (t) => {
                      const uDoc = await t.get(userRef);
                      if (uDoc.exists) {
                        const b = uDoc.data()?.creditBalance || 0;
                        t.update(userRef, { creditBalance: b + pkg.credits });
                        const trRef = userRef.collection("transactions").doc();
                        t.set(trRef, {
                          userId,
                          type: "purchase",
                          amount: pkg.credits,
                          cost: pkg.amount,
                          description: `Auto Top-up: ${pkg.credits} credits added`,
                          createdAt: FieldValue.serverTimestamp(),
                        });
                      }
                    });
                  }
                }
              }
            }
          } catch (err) {
            console.error("[Auto Top-up] Error:", err);
          }
        })();
      } else {
        res.status(400).json(result);
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      console.error("[Deduct Credits] Transaction failed:", e);
      res.status(500).json({
        success: false,
        error: "Firestore operation failed",
        message: err.message,
      });
    }
  });

  app.post("/api/verify-payment", async (req, res) => {
    const { reference } = req.body;
    if (!reference)
      return res.status(400).json({ success: false, error: "Reference is required" });

    try {
      const paystackSnap = await db.collection("settings").doc("paystack").get();
      const secretKey = paystackSnap.exists ? paystackSnap.data()?.secretKey : null;

      if (!secretKey) throw new Error("Paystack secret key is not configured.");

      const response = await fetch(
        `https://api.paystack.co/transaction/verify/${reference}`,
        { headers: { Authorization: `Bearer ${secretKey}` } }
      );

      const data: {
        status?: boolean;
        message?: string;
        data?: {
          status?: string;
          metadata?: { userId?: string; credits?: number };
          amount?: number;
          currency?: string;
          authorization?: { reusable?: boolean };
        };
      } = await response.json();

      if (data.status && data.data && data.data.status === "success") {
        const metadata = data.data.metadata || {};
        const userId = metadata.userId;
        const creditsToAdd = metadata.credits;

        if (userId && creditsToAdd) {
          const userRef = db.collection("users").doc(userId);
          await db.runTransaction(async (transaction) => {
            const userDoc = await transaction.get(userRef);
            if (userDoc.exists) {
              const currentBalance = userDoc.data()?.creditBalance || 0;
              transaction.update(userRef, {
                creditBalance: currentBalance + creditsToAdd,
                updatedAt: FieldValue.serverTimestamp(),
              });

              const transRef = userRef.collection("transactions").doc();
              transaction.set(transRef, {
                userId,
                type: "purchase",
                amount: creditsToAdd,
                cost: (data.data!.amount || 0) / 100,
                currency: data.data!.currency,
                description: `Purchased ${creditsToAdd} credits`,
                reference: reference,
                createdAt: FieldValue.serverTimestamp(),
              });

              const auth = data.data!.authorization;
              if (auth && auth.reusable) {
                transaction.update(userRef, { paystackAuth: auth });
              }
            }
          });
        }
        res.json({ success: true, data: data.data });
      } else {
        res.status(400).json({
          success: false,
          error: data.message || "Payment verification failed",
        });
      }
    } catch (e: unknown) {
      const err = e as { message?: string };
      console.error("Paystack verify error:", e);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      env: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/cron/reminders", async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = req.get("authorization");
      if (auth !== `Bearer ${secret}`) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }
    try {
      await runAppointmentReminders(db);
      res.status(200).json({ ok: true });
    } catch (e: unknown) {
      console.error("[Cron reminders]", e);
      res.status(500).json({
        error: e instanceof Error ? e.message : "failed",
      });
    }
  });

  const isProd = process.env.NODE_ENV === "production";

  if (!isProd) {
    console.log("[Server] Initializing Vite in dev mode...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    console.log(`[Server] Production mode: Serving from ${distPath}`);
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  return app;
}
