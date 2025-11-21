require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const db = require('./firebase');
const admin = require("firebase-admin");
const { checkMedicineTime } = require('./smsService');

const app = express();
const rtdb = admin.database();
app.use(cors());
app.use(express.json());

/* -----------------------------
   FIRESTORE HELPERS
----------------------------- */
const getDocs = async (collection, field, value) => {
  const snapshot = await db.collection(collection).where(field, "==", value).get();
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
};

const getDocById = async (collection, id) => { 
  const doc = await db.collection(collection).doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
};

const addDocWithId = async (collection, id, data) => {
  const ref = db.collection(collection).doc(id);
  await ref.set({ id, ...data });
  return id;
};

const deleteByQuery = async (collection, field, value) => {
  const snapshot = await db.collection(collection).where(field, "==", value).get();
  const batch = db.batch();
  snapshot.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
};

async function logActivity(doctorId, message) {
  try {
    await db.collection("activityLog").add({
      doctorId,
      message,
      timestamp: new Date()
    });
  } catch (err) {
    console.error("Failed to log activity:", err);
  }
}


/* -----------------------------
   DOCTORS
----------------------------- */

// Register doctor
app.post('/api/doctors/register', async (req, res) => {
  try {
    const { id, name, password } = req.body;
    const docRef = db.collection('doctors').doc(id);
    const doc = await docRef.get();
    if (doc.exists) return res.status(400).json({ message: 'Doctor already exists' });
    await docRef.set({ id, name, password });
    res.json({ message: 'Doctor registered' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Login doctor
app.post('/api/doctors/login', async (req, res) => {
  try {
    const { id, password } = req.body;
    const doctor = await getDocById("doctors", id);
    if (!doctor) return res.status(404).json({ message: "Doctor not found" });
    if (doctor.password !== password) return res.status(401).json({ message: "Invalid password" });
    res.json({ doctor });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get doctor info
app.get('/api/doctor/:id', async (req, res) => {
  try {
    const doctor = await getDocById("doctors", req.params.id);
    if (!doctor) return res.status(404).json({ message: "Doctor not found" });
    res.json(doctor);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Fetch recent activity logs for a doctor
app.get('/api/activity-log/:doctorId', async (req, res) => {
  try {
    const doctorId = req.params.doctorId;
    const logsSnapshot = await db.collection("activityLog")
      .orderBy("timestamp", "desc")
      .limit(20)
      .get();

    // Correct mapping for Firestore documents:
    const logs = logsSnapshot.docs
      .map(doc => doc.data())
      .filter(log => log.doctorId === doctorId)
      .map(log => ({
        message: log.message,
        timestamp: log.timestamp.toDate ? log.timestamp.toDate().toISOString() : log.timestamp
      }));
    res.json(logs);
  } catch (error) {
    console.error("Error fetching activity log:", error);
    res.status(500).json({ message: error.message || "Server error" });
  }
});



/* -----------------------------
   PATIENTS
----------------------------- */

// Add new patient (id comes from user input)
app.post('/api/patients/add', async (req, res) => {
  try {
    const { name, age, gender, phoneno, address, doctorId, username, password } = req.body;

    if (!name || !age || !gender || !phoneno || !address || !doctorId || !username || !password) {
      return res.status(400).json({ message: "All fields are required." });
    }

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const snapshot = await db.collection("patients")
      .where("id", ">=", `PAT${dateStr}`)
      .where("id", "<", `PAT${dateStr}z`)
      .get();

    const numToday = snapshot.size + 1;
    const id = `PAT${dateStr}-${String(numToday).padStart(3, '0')}`;

    const existing = await getDocById("patients", id);
    if (existing) {
      return res.status(400).json({ message: "Patient ID already exists" });
    }

    await addDocWithId("patients", id, { name, age, gender, phoneno, address, doctorId });

    await db.collection("slots").doc(id).set({
      patientId: id,
      S1: null,
      S2: null,
      S3: null
    });

    // RTDB sync
    await rtdb.ref(`mobileApp/patients/${id}`).set({
      login: {
        username,
        password
      },
      name,
      patientId: id,
      doctorId,
      slots: {
        S1: { medicine: null, count: 0 },
        S2: { medicine: null, count: 0 },
        S3: { medicine: null, count: 0 }
      }
    });

    await logActivity(doctorId, `Added patient ${name} (${id})`);

    res.json({ id, message: "Patient added successfully" });

  } catch (err) {
    console.error("❌ ERROR IN /api/patients/add:", err);
    res.status(500).json({ message: err.message });
  }
});


// Get patients by doctorId
app.get('/api/patients/:doctorId', async (req, res) => {
  try {
    res.json(await getDocs("patients", "doctorId", req.params.doctorId));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get single patient
app.get('/api/patient/:id', async (req, res) => {
  try {
    const patient = await getDocById("patients", req.params.id);
    if (!patient) return res.status(404).json({ message: "Patient not found" });
    res.json(patient);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete patient + medicines + slots
app.delete("/api/patient/:id", async (req, res) => {
  try {
    const patientId = req.params.id;
    const patient = await getDocById("patients", patientId);
    await deleteByQuery("medicines", "patientId", patientId);
    await db.collection("slots").doc(patientId).delete();
    await db.collection("patients").doc(patientId).delete();
    await rtdb.ref(`mobileApp/patients/${patientId}`).remove();
    await logActivity(patient.doctorId, `Deleted patient ${patient.name} (${patientId})`);
    res.json({ message: "Patient, slots, and medicines deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* -----------------------------
   MEDICINES
----------------------------- */

// Get all medicines for a specific patient
app.get("/api/medicines/:patientId", async (req, res) => {
  try {
    const patientId = req.params.patientId;
    const snapshot = await db
      .collection("medicines")
      .where("patientId", "==", patientId)
      .get();

    if (snapshot.empty) {
      return res.status(404).json([]); // no medicines found
    }

    const medicines = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.json(medicines);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// Add medicine with slot update
app.post("/api/medicines/add", async (req, res) => {
  try {
    const { name, scheduledTime, patientId } = req.body;
    const patient = await getDocById("patients", {patientId});
    const slotRef = db.collection("slots").doc(patientId);
    const slotDoc = await slotRef.get();
    if (!slotDoc.exists) return res.status(404).json({ message: "Slots not found" });

    let slots = slotDoc.data();
    let slotAssigned = null;

    // Check if medicine already in a slot
    for (let slot of ["S1", "S2", "S3"]) {
      if (slots[slot] === name) slotAssigned = slot;
    }

    // Assign new slot if needed
    if (!slotAssigned) {
      const free = ["S1", "S2", "S3"].filter((s) => !slots[s]);
      if (free.length === 0) return res.status(400).json({ message: "All slots are full" });

      slotAssigned = free[0];
      await slotRef.update({ [slotAssigned]: name });
    }

    // Save medicine in Firestore
    const id = await addDocWithId("medicines", Date.now().toString(), {
      name,
      scheduledTime,
      patientId
    });

    // Update RTDB slot
    const rtdb = admin.database();
    await rtdb.ref(`mobileApp/patients/${patientId}/slots/${slotAssigned}`).update({
      medicine: name,
      count: 0
    });
    await logActivity(doctorId, `Added medicine ${name} to (${patient.name})`);

    res.json({
      id,
      slot: slotAssigned,
      message: `Medicine scheduled in ${slotAssigned}`
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete medicine and clear slot
app.delete('/api/medicines/:id', async (req, res) => {
  try {
    const medicineId = req.params.id;
    const medDoc = await getDocById("medicines", medicineId);
    if (!medDoc) return res.status(404).json({ message: "Medicine not found" });

    const slotRef = db.collection("slots").doc(medDoc.patientId);
    const slotDoc = await slotRef.get();
    let slot = null;

    if (slotDoc.exists) {
      const slots = slotDoc.data();
      for (const s of ["S1", "S2", "S3"]) {
        if (slots[s] === medDoc.name) {
          slot = s;
          await slotRef.update({ [s]: null });
        }
      }
    }

    await db.collection("medicines").doc(medicineId).delete();

    // Reset RTDB slot
    if (slot) {
      const rtdb = admin.database();
      await rtdb.ref(`mobileApp/patients/${medDoc.patientId}/slots/${slot}`).update({
        medicine: null,
        count: 0
      });
    }

    res.json({ message: "Medicine deleted successfully" });
    await logActivity(doctorId, `Deleted medicine ${medDoc.name}`);

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



/* -----------------------------
   CRON JOB
----------------------------- */
cron.schedule('* * * * *', () => {
  try {
    checkMedicineTime();
  } catch (e) {
    console.error('Scheduler error', e.message);
  }
});

/* -----------------------------
   SERVER START
----------------------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log('Server running on port', PORT));
