const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors({
  origin: ['https://attendance-aura.web.app', 'https://attendance-aura.firebaseapp.com', 'http://localhost:5173', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-secret'],
  credentials: true
}));
app.options('*', cors()); // Handle preflight
app.use(express.json({ limit: '50mb' }));

// Firebase Admin init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://attendance-aura-default-rtdb.firebaseio.com',
});

const db = admin.firestore();
const API_SECRET = process.env.API_SECRET || 'attendance-aura-secret-2026';
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;

console.log('🚀 Backend starting...');
console.log('Gmail configured:', GMAIL_USER ? `Yes (${GMAIL_USER})` : 'NO - MISSING!');
console.log('API Secret configured:', API_SECRET ? 'Yes' : 'NO');

const verifySecret = (req, res, next) => {
  if (req.headers['x-api-secret'] !== API_SECRET) {
    console.error('❌ Unauthorized request from:', req.ip);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ✅ Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Attendance Backend Running ✅',
    gmail: GMAIL_USER ? 'configured' : 'MISSING',
    time: new Date().toISOString()
  });
});

// ✅ DELETE SINGLE USER FROM FIREBASE AUTH
app.delete('/delete-user/:uid', verifySecret, async (req, res) => {
  try {
    const uid = req.params.uid;
    console.log(`🗑️ Deleting user: ${uid}`);
    await admin.auth().deleteUser(uid);
    console.log(`✅ Deleted user ${uid} from Firebase Auth`);
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      console.log(`User ${req.params.uid} already deleted`);
      return res.json({ success: true });
    }
    console.error('❌ Delete error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ DELETE MULTIPLE USERS
app.post('/delete-users', verifySecret, async (req, res) => {
  try {
    const { uids } = req.body;
    if (!uids || !Array.isArray(uids)) return res.status(400).json({ error: 'uids array required' });
    console.log(`🗑️ Batch deleting ${uids.length} users`);
    const result = await admin.auth().deleteUsers(uids);
    console.log(`✅ Deleted ${result.successCount} users, failed: ${result.failureCount}`);
    res.json({ success: true, deleted: result.successCount, failed: result.failureCount });
  } catch (error) {
    console.error('❌ Batch delete error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ CREATE PARENT ACCOUNT
app.post('/create-parent', verifySecret, async (req, res) => {
  try {
    const { name, email, phone, password, childName, childUSN } = req.body;
    if (!email || !password || !childUSN) return res.status(400).json({ error: 'email, password, childUSN required' });
    const existingParents = await db.collection('users').where('role', '==', 'parent').where('childUSN', '==', childUSN).get();
    if (existingParents.size >= 2) return res.status(400).json({ error: 'Maximum 2 parent accounts already exist.' });
    const userRecord = await admin.auth().createUser({ email, password, displayName: name });
    await db.collection('users').doc(userRecord.uid).set({
      id: userRecord.uid, name, email, phone: phone || '',
      role: 'parent', isActive: true,
      childName: childName || '', childUSN,
      createdAt: new Date().toISOString(),
    });
    console.log(`✅ Parent created: ${email}`);
    res.json({ success: true, uid: userRecord.uid });
  } catch (error) {
    console.error('❌ Create parent error:', error.message);
    if (error.code === 'auth/email-already-exists') return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ SEND ATTENDANCE REPORTS TO PARENTS
app.post('/send-reports', verifySecret, async (req, res) => {
  try {
    const { emails } = req.body;
    console.log(`📧 Send reports request received. Count: ${emails?.length}`);
    
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'emails array required and must not be empty' });
    }
    
    if (!GMAIL_USER || !GMAIL_PASS) {
      console.error('❌ Gmail NOT configured!');
      return res.status(500).json({ error: 'Gmail credentials not configured on server. Check GMAIL_USER and GMAIL_APP_PASSWORD env vars.' });
    }

    console.log(`📧 Sending ${emails.length} reports via ${GMAIL_USER}`);

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });

    // Verify Gmail connection
    try {
      await transporter.verify();
      console.log('✅ Gmail connection verified');
    } catch (verifyErr) {
      console.error('❌ Gmail verification failed:', verifyErr.message);
      return res.status(500).json({ error: `Gmail auth failed: ${verifyErr.message}` });
    }

    let sent = 0, failed = 0;
    for (const email of emails) {
      try {
        const periodLabel = email.period === 'weekly' ? 'Weekly (Last 7 Days)' : 'Monthly (Last 30 Days)';
        const statusEmoji = email.percentage >= 75 ? '✅' : '⚠️';
        const subjectWiseRows = (email.subjectWise || []).map(s =>
          `<tr>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;">${s.subject}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${s.present}/${s.total}</td>
            <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;color:${s.percentage>=75?'#16a34a':'#dc2626'};font-weight:bold;">${s.percentage}%</td>
          </tr>`
        ).join('');

        const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#f8fafc;">
          <div style="background:linear-gradient(135deg,#3b82f6,#8b5cf6);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
            <h1 style="color:white;margin:0;font-size:22px;">Attendance Report ${statusEmoji}</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;">${periodLabel}</p>
          </div>
          <p style="color:#374151;">Dear <strong>${email.parentName || 'Parent'}</strong>,</p>
          <p style="color:#374151;">Attendance report for <strong>${email.studentName}</strong> (${email.usn}):</p>
          <div style="background:white;border-radius:12px;padding:20px;margin:16px 0;text-align:center;">
            <div style="font-size:48px;font-weight:bold;color:${email.percentage>=75?'#16a34a':'#dc2626'};">${email.percentage}%</div>
            <p style="color:#6b7280;margin:4px 0;">Overall Attendance</p>
            <div style="display:flex;justify-content:center;gap:24px;margin-top:12px;">
              <span style="color:#16a34a;">Present: ${email.present}</span>
              <span style="color:#dc2626;">Absent: ${email.absent}</span>
              <span style="color:#6b7280;">Total: ${email.total}</span>
            </div>
          </div>
          ${subjectWiseRows ? `
          <div style="background:white;border-radius:12px;padding:16px;margin:16px 0;">
            <h3 style="color:#374151;margin:0 0 12px;">Subject-wise Attendance</h3>
            <table style="width:100%;border-collapse:collapse;">
              <thead><tr style="background:#f3f4f6;">
                <th style="padding:8px 12px;text-align:left;">Subject</th>
                <th style="padding:8px 12px;text-align:center;">Classes</th>
                <th style="padding:8px 12px;text-align:center;">%</th>
              </tr></thead>
              <tbody>${subjectWiseRows}</tbody>
            </table>
          </div>` : ''}
          ${email.percentage < 75 ? '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;color:#dc2626;margin:16px 0;">⚠️ Attendance below 75%. Please ensure regular attendance.</div>' : ''}
          <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:24px;">Automated report from Attendance Aura System</p>
        </div>`;

        await transporter.sendMail({
          from: `"Attendance Aura" <${GMAIL_USER}>`,
          to: email.to,
          subject: `${periodLabel} Attendance - ${email.studentName} (${email.usn})`,
          html,
        });
        sent++;
        console.log(`✅ Sent to ${email.to}`);
      } catch (err) {
        console.error(`❌ Failed to send to ${email.to}:`, err.message);
        failed++;
      }
    }

    console.log(`📊 Done: ${sent} sent, ${failed} failed`);
    res.json({ success: true, sent, failed });
  } catch (error) {
    console.error('❌ Send reports error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
