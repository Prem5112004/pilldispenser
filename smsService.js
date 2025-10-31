// backend/smsService.js
require("dotenv").config();
const admin = require("firebase-admin");
const db = require("./firebase"); // your Firestore instance from firebase.js
const twilio = require("twilio");

// Initialize Realtime Database
const rtdb = admin.database();

// Twilio setup
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
console.log(process.env.TWILIO_SID , process.env.TWILIO_AUTH_TOKEN , process.env.TWILIO_PHONE)
// Helper for time formatting
const padZero = (num) => (num < 10 ? `0${num}` : `${num}`);

const checkMedicineTime = async () => {
  const now = new Date();
  const timeNow = `${padZero(now.getHours())}:${padZero(now.getMinutes())}`;
  console.log(`⏰ [Cron] Checking medicines at: ${timeNow}`);

  try {
    const snapshot = await db.collection("medicines").get();

    for (const doc of snapshot.docs) {
      const medicine = doc.data();

      // Validate record
      if (!medicine || !medicine.patientId || !medicine.scheduledTime) continue;

      // Check if time matches current minute
      if (medicine.scheduledTime === timeNow) {
        console.log(`🕒 Medicine due: ${medicine.name} for patient ${medicine.patientId}`);

        // Fetch patient details
        const patientDoc = await db.collection("patients").doc(medicine.patientId).get();
        const slotsDoc = await db.collection("slots").doc(medicine.patientId).get();
        if (!patientDoc.exists) {
          console.log(`❗ Patient ${medicine.patientId} not found`);
          continue;
        }

        const patient = patientDoc.data();
        const slots= slotsDoc.data();
        const phone = patient.phoneno;
        const pname = patientDoc.data().name;
        const slotAssigned = Object.keys(slots).find((s) => slots[s] === medicine.name) || "Unknown";

        /* ------------------------------------------
           1️⃣  Send SMS reminder to patient
        ------------------------------------------ */
        try {
          await client.messages.create({
            body: `Reminder: Heyy ${pname}!! Take your medicine: ${medicine.name}`,
            from: process.env.TWILIO_PHONE,
            to: phone.startsWith('+') ? phone : `+91${phone}`
          });
          console.log('Sent SMS to', phone);
        } catch (err) {
          console.error('Failed to send SMS to', phone, err.message);
        }

        /* ------------------------------------------
           2️⃣  Push dispense command to RTDB
        ------------------------------------------ */
        try {
          const slotRef = rtdb.ref(`commands/${medicine.patientId}/${slotAssigned}`);

          const commandData = {
            medicine: medicine.name,
            slot: slotAssigned,
            time: medicine.scheduledTime,
            executed: false,
            timestamp: new Date().toISOString(),
          };
          await slotRef.set(commandData);
          console.log(`🚀 RTDB command added for ${medicine.name} (${slotAssigned})`);
        } catch (err) {
          console.error("🔥 Error writing to Realtime Database:", err.message);
        }
      }
    }
  } catch (err) {
    console.error("🔥 Error in checkMedicineTime:", err.message);
  }
};

module.exports = { checkMedicineTime };


