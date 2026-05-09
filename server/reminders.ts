import { FieldValue } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";

export async function runAppointmentReminders(db: Firestore) {
  console.log("[Reminder Job] Checking for upcoming appointments...");
  const now = Date.now();
  const targetTime = now + 24 * 60 * 60 * 1000;
  const windowStart = targetTime - 15 * 60 * 1000;

  const snapshot = await db
    .collection("appointments")
    .where("status", "==", "confirmed")
    .get();

  console.log(`[Reminder Job] Found ${snapshot.size} confirmed appointments to screen.`);

  for (const doc of snapshot.docs) {
    const appt = doc.data();
    if (appt.reminded) continue;

    const apptDate = new Date(appt.dateTime).getTime();

    if (apptDate >= windowStart && apptDate <= targetTime) {
      console.log(`[Reminder Job] Sending reminder for appt: ${doc.id}`);

      const timeStr = new Date(appt.dateTime).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      await db.collection("notifications").add({
        userId: appt.userId,
        title: "Appointment Reminder",
        message: `Friendly reminder: Your session with Dr. ${appt.doctorName} is scheduled for tomorrow at ${timeStr}.`,
        type: "reminder",
        isRead: false,
        createdAt: FieldValue.serverTimestamp(),
      });

      await db.collection("notifications").add({
        userId: appt.doctorId,
        title: "Consultation Reminder",
        message: `Upcoming consultation with ${appt.patientName} tomorrow at ${timeStr}.`,
        type: "reminder",
        isRead: false,
        createdAt: FieldValue.serverTimestamp(),
      });

      await doc.ref.update({
        reminded: true,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }
}
