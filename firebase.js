// backend/firebase.js
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountkey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://meditrack-8e9be-default-rtdb.firebaseio.com"
});

const db = admin.firestore();
module.exports = db;
