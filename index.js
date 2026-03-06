const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK using environment variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://attendance-aura-default-rtdb.firebaseio.com',
});

// Secret key to protect this API (set in Render environment variables)
const API_SECRET = process.env.API_SECRET || 'change-this-secret';

// Middleware to verify secret
const verifySecret = (req, res, next) => {
  const secret = req.headers['x-api-secret'];
  if (secret !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ✅ DELETE USER FROM FIREBASE AUTH
app.delete('/delete-user/:uid', verifySecret, async (req, res) => {
  try {
    const { uid } = req.params;
    await admin.auth().deleteUser(uid);
    console.log(`✅ Deleted user ${uid} from Firebase Auth`);
    res.json({ success: true, message: `User ${uid} deleted from Firebase Auth` });
  } catch (error) {
    console.error('Delete error:', error.message);
    // If user not found, still return success (already deleted)
    if (error.code === 'auth/user-not-found') {
      return res.json({ success: true, message: 'User already deleted' });
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ DELETE MULTIPLE USERS (for batch delete)
app.post('/delete-users', verifySecret, async (req, res) => {
  try {
    const { uids } = req.body;
    if (!uids || !Array.isArray(uids)) {
      return res.status(400).json({ error: 'uids array required' });
    }
    const result = await admin.auth().deleteUsers(uids);
    console.log(`✅ Deleted ${result.successCount} users from Firebase Auth`);
    res.json({
      success: true,
      deleted: result.successCount,
      failed: result.failureCount,
    });
  } catch (error) {
    console.error('Batch delete error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Attendance Backend Running ✅' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
