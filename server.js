require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const db = require('./firebase');
const { checkMedicineTime } = require('./smsService');

const app = express();
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

/* -----------------------------
   PATIENTS
----------------------------- */

// Add new patient (id comes from user input)
app.post('/api/patients/add', async (req, res) => {
  try {
    const { id, name, age, phoneno, doctorId } = req.body;
    const existing = await getDocById("patients", id);
    if (existing) return res.status(400).json({ message: "Patient ID already exists" });

    await addDocWithId("patients", id, { name, age, phoneno, doctorId });

    // create empty slots doc
    await db.collection("slots").doc(id).set({
      patientId: id,
      S1: null,
      S2: null,
      S3: null,
    });

    res.json({ id, message: "Patient added with empty slots" });
  } catch (err) {
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
    await deleteByQuery("medicines", "patientId", patientId);
    await db.collection("slots").doc(patientId).delete();
    await db.collection("patients").doc(patientId).delete();
    res.json({ message: "Patient, slots, and medicines deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* -----------------------------
   MEDICINES
----------------------------- */

// Add medicine with 3-slot enforcement
app.post("/api/medicines/add", async (req, res) => {
  try {
    const { name, scheduledTime, patientId } = req.body;
    const slotRef = db.collection("slots").doc(patientId);
    const slotDoc = await slotRef.get();

    if (!slotDoc.exists) return res.status(404).json({ message: "Slots not found" });

    let slots = slotDoc.data();
    let slotAssigned = null;

    // check if medicine already assigned
    for (let slot of ["S1", "S2", "S3"]) {
      if (slots[slot] === name) {
        slotAssigned = slot;
        break;
      }
    }

    // if not, assign to free slot
    if (!slotAssigned) {
      const available = ["S1", "S2", "S3"].filter((s) => !slots[s]);
      if (available.length === 0) {
        return res.status(400).json({ message: "All slots are full" });
      }
      slotAssigned = available[0];
      slots[slotAssigned] = name;
      await slotRef.update({ [slotAssigned]: name });
    }

    // save medicine schedule
    const id = await addDocWithId("medicines", Date.now().toString(), { name, scheduledTime, patientId });

    res.json({
      id,
      slot: slotAssigned,
      message: `Medicine scheduled in ${slotAssigned}`,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get medicines by patientId
app.get('/api/medicines/:patientId', async (req, res) => {
  try {
    res.json(await getDocs("medicines", "patientId", req.params.patientId));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete a single medicine
app.delete("/api/medicines/:id", async (req, res) => {
  try {
    const med = await getDocById("medicines", req.params.id);
    if (!med) return res.status(404).json({ message: "Medicine not found" });

    await db.collection("medicines").doc(req.params.id).delete();

    // free slot if this was last schedule of that medicine
    const otherMeds = await getDocs("medicines", "patientId", med.patientId);
    const stillExists = otherMeds.some(m => m.name === med.name);

    if (!stillExists) {
      const slotRef = db.collection("slots").doc(med.patientId);
      const slotDoc = await slotRef.get();
      if (slotDoc.exists) {
        let slots = slotDoc.data();
        for (let s of ["S1", "S2", "S3"]) {
          if (slots[s] === med.name) slots[s] = null;
        }
        await slotRef.update(slots);
      }
    }

    res.json({ message: "Medicine deleted successfully" });
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
