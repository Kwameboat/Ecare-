import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import cors from "cors";
import { initializeApp, getApps, App } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import admin from "firebase-admin";
import cron from "node-cron";
import fs from "fs";

// Load Firebase Config securely
const firebaseConfig = JSON.parse(fs.readFileSync("./firebase-applet-config.json", "utf-8"));

const userProjectId = firebaseConfig.projectId;
const userDatabaseId = firebaseConfig.firestoreDatabaseId;

// Force environment variables for underlying gRPC/SDK layers
process.env.GOOGLE_CLOUD_PROJECT = userProjectId;
process.env.FIRESTORE_PROJECT_ID = userProjectId;

// Initialize Firebase Admin
let appInstance: App;

if (getApps().length === 0) {
  console.log(`[Admin] Initializing with Project ID: ${userProjectId}`);
  appInstance = initializeApp({
    projectId: userProjectId
  });
} else {
  appInstance = getApps()[0];
}

// Ensure we use the correct database ID
const db = getFirestore(appInstance, userDatabaseId || undefined);

// Debug: Print effective project ID from appInstance
console.log(`[Admin] Effective Project ID: ${appInstance.options.projectId || "UNKNOWN"}`);

async function testConnection() {
  try {
    const projectId = userProjectId || "auto-detected";
    const dbId = userDatabaseId || "(default)";
    
    console.log(`[Firestore] Connection Test: Project=${projectId}, Database=${dbId}`);
    
    // Check access to settings
    console.log("[Firestore] Attempting to read settings/app...");
    const settingsCheck = await db.collection("settings").doc("app").get();
    console.log(`[Firestore] Settings access: OK (Exists: ${settingsCheck.exists})`);
  } catch (error: any) {
    console.error(`[Firestore] Connection test FAILED`);
    console.error(`- Code: ${error.code}`);
    console.error(`- Message: ${error.message}`);
  }
}
// We run this in background to not block startup
testConnection().catch(err => console.error("[Firestore] Startup test check failed:", err));

async function startServer() {
  try {
    const app = express();
    const PORT = 3000;

    app.use(cors());
    app.use(express.json({ limit: '50mb' }));

  // Automated Reminders Job (runs every 15 minutes)
  cron.schedule("*/15 * * * *", async () => {
    console.log("[Reminder Job] Checking for upcoming appointments...");
    const now = Date.now();
    const targetTime = now + 24 * 60 * 60 * 1000;
    const windowStart = targetTime - 15 * 60 * 1000;

    try {
      const snapshot = await db.collection("appointments")
        .where("status", "==", "confirmed")
        .get();

      console.log(`[Reminder Job] Found ${snapshot.size} confirmed appointments to screen.`);
      
      for (const doc of snapshot.docs) {
        const appt = doc.data();
        if (appt.reminded) continue;
        
        // Convert to Date object for robust comparison
        // We assume the stored string is in a recognizable format
        const apptDate = new Date(appt.dateTime).getTime();

        if (apptDate >= windowStart && apptDate <= targetTime) {
          console.log(`[Reminder Job] Sending reminder for appt: ${doc.id}`);
          
          const timeStr = new Date(appt.dateTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

          // Notify Patient
          await db.collection("notifications").add({
            userId: appt.userId,
            title: "Appointment Reminder",
            message: `Friendly reminder: Your session with Dr. ${appt.doctorName} is scheduled for tomorrow at ${timeStr}.`,
            type: "reminder",
            isRead: false,
            createdAt: FieldValue.serverTimestamp()
          });

          // Notify Doctor
          await db.collection("notifications").add({
            userId: appt.doctorId,
            title: "Consultation Reminder",
            message: `Upcoming consultation with ${appt.patientName} tomorrow at ${timeStr}.`,
            type: "reminder",
            isRead: false,
            createdAt: FieldValue.serverTimestamp()
          });

          await doc.ref.update({ reminded: true, updatedAt: FieldValue.serverTimestamp() });
        }
      }
    } catch (error) {
      console.error("[Reminder Job] Execution Error:", error);
    }
  });

  // Dynamic Manifest API
  app.get("/manifest.json", async (req, res) => {
    try {
      const settingsSnap = await db.collection("settings").doc("app").get();
      const settings = settingsSnap.exists ? settingsSnap.data() : {};
      const logoUrl = settings?.logoUrl || "https://cdn-icons-png.flaticon.com/512/2869/2869382.png";
      const appName = settings?.appName || "eCare GH AI";
      const tagline = settings?.tagline || "Your Intelligent Healthcare Companion";

      res.json({
        "name": appName,
        "short_name": appName.split(' ')[0],
        "description": tagline,
        "start_url": "/",
        "display": "standalone",
        "background_color": "#020203",
        "theme_color": "#2563eb",
        "icons": [
          {
            "src": logoUrl,
            "sizes": "192x192",
            "type": logoUrl.includes(".svg") ? "image/svg+xml" : "image/png"
          },
          {
            "src": logoUrl,
            "sizes": "512x512",
            "type": logoUrl.includes(".svg") ? "image/svg+xml" : "image/png"
          }
        ]
      });
    } catch (error) {
      console.error("Manifest generation error:", error);
      res.sendFile(path.resolve("public/manifest.json"));
    }
  });

  // Credit Deduction API
  app.post("/api/deduct-credits", async (req, res) => {
    const { userId, type } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: "userId is required" });

    // Get costs from settings
    const settingsSnap = await db.collection("settings").doc("app").get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const costs = settings?.creditCosts || { textPrompt: 1, imageGen: 5, voicePrompt: 2 };

    let points = costs.textPrompt;
    if (type === 'voice') points = costs.voicePrompt;
    if (type === 'image' || type === 'mixed' || type === 'recommendation') points = costs.imageGen;

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
          updatedAt: FieldValue.serverTimestamp()
        });

        // Log Transaction
        const transactionRef = userRef.collection("transactions").doc();
        transaction.set(transactionRef, {
          userId,
          type: 'usage',
          amount: -points,
          description: `Used ${points} credits for ${type} request`,
          createdAt: FieldValue.serverTimestamp()
        });

        return { success: true, deducted: points };
      });

      if (result.success) {
        res.json(result);
        
        // Handle Auto Top-up in background
        (async () => {
          try {
            const userSnap = await userRef.get();
            const userData = userSnap.data();
            const newBalance = userData?.creditBalance || 0;
            const autoTopUp = userData?.autoTopUp;
            const paystackAuth = userData?.paystackAuth;

            if (autoTopUp?.enabled && newBalance < autoTopUp.threshold && paystackAuth) {
              const paystackSnap = await db.collection("settings").doc("paystack").get();
              const secretKey = paystackSnap.exists ? paystackSnap.data()?.secretKey : null;

              if (secretKey) {
                const appSnap = await db.collection("settings").doc("app").get();
                const packages = appSnap.data()?.creditPackages || [];
                const pkg = packages.find((p: any) => p.id === autoTopUp.packageId) || packages[0];
                
                if (pkg) {
                  const chargeResp = await fetch('https://api.paystack.co/transaction/charge_authorization', {
                    method: 'POST',
                    headers: {
                      Authorization: `Bearer ${secretKey}`,
                      'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                      email: userData.email,
                      amount: pkg.amount * 100,
                      authorization_code: paystackAuth.authorization_code,
                      metadata: {
                        userId: userId,
                        credits: pkg.credits,
                        packageId: pkg.id,
                        isAutoTopUp: true
                      }
                    })
                  });
                  const chargeData: any = await chargeResp.json();
                  if (chargeData.status && chargeData.data.status === 'success') {
                    await db.runTransaction(async (t) => {
                       const uDoc = await t.get(userRef);
                       if (uDoc.exists) {
                         const b = uDoc.data()?.creditBalance || 0;
                         t.update(userRef, { creditBalance: b + pkg.credits });
                         const trRef = userRef.collection("transactions").doc();
                         t.set(trRef, {
                           userId,
                           type: 'purchase',
                           amount: pkg.credits,
                           cost: pkg.amount,
                           description: `Auto Top-up: ${pkg.credits} credits added`,
                           createdAt: FieldValue.serverTimestamp()
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
    } catch (e: any) {
      console.error("[Deduct Credits] Transaction failed:", e);
      res.status(500).json({ 
        success: false, 
        error: "Firestore operation failed", 
        message: e.message
      });
    }
  });

  // Paystack Verification API
  app.post("/api/verify-payment", async (req, res) => {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ success: false, error: "Reference is required" });

    try {
      const paystackSnap = await db.collection("settings").doc("paystack").get();
      const secretKey = paystackSnap.exists ? paystackSnap.data()?.secretKey : null;

      if (!secretKey) throw new Error("Paystack secret key is not configured.");

      const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${secretKey}` }
      });

      const data: any = await response.json();

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
                updatedAt: FieldValue.serverTimestamp()
              });

              const transRef = userRef.collection("transactions").doc();
              transaction.set(transRef, {
                userId,
                type: 'purchase',
                amount: creditsToAdd,
                cost: data.data.amount / 100,
                currency: data.data.currency,
                description: `Purchased ${creditsToAdd} credits`,
                reference: reference,
                createdAt: FieldValue.serverTimestamp()
              });

              const auth = data.data.authorization;
              if (auth && auth.reusable) {
                transaction.update(userRef, { paystackAuth: auth });
              }
            }
          });
        }
        res.json({ success: true, data: data.data });
      } else {
        res.status(400).json({ success: false, error: data.message || "Payment verification failed" });
      }
    } catch (e: any) {
      console.error("Paystack verify error:", e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ 
      status: "ok", 
      env: process.env.NODE_ENV,
      timestamp: new Date().toISOString()
    });
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
    const distPath = path.resolve("dist");
    console.log(`[Server] Production mode: Serving from ${distPath}`);
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Server] Listening on http://0.0.0.0:${PORT} (${process.env.NODE_ENV || 'dev'})`);
  });
  } catch (err) {
    console.error("Critical error starting server:", err);
  }
}

startServer();
