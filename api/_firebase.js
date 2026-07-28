const admin = require('firebase-admin');

if (!admin.apps.length) {
  const firebaseServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!firebaseServiceAccount) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT environment variable.');
  }

  const serviceAccount = JSON.parse(firebaseServiceAccount);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

module.exports = {
  admin,
  db,
};
