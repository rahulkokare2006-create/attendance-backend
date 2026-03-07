const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://attendance-aura-default-rtdb.firebaseio.com',
});

const API_SECRET = process.env.API_SECRET || 'change-this-secret';

// Gmail credentials (set in Render env vars)
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;

const verifySecret = (req, res, next) => {
  const secret = req.headers['x-api-secret'];
  if (secret !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

// ✅ DELETE USER FROM FIREBASE AUTH
app.delete('/delete-user/:uid', verifySecret, async (req, res) => {
  try {
    const { uid } = req.params;
    await admin.auth().deleteUser(uid);
    res.json({ success: true });
  } catch (error) {
    if (error.code === 'auth/user-not-found') return res.json({ success: true });
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ DELETE MULTIPLE USERS
app.post('/delete-users', verifySecret, async (req, res) => {
  try {
    const { uids } = req.body;
    if (!uids || !Array.isArray(uids)) return res.status(400).json({ error: 'uids array required' });
    const result = await admin.auth().deleteUsers(uids);
    res.json({ success: true, deleted: result.successCount, failed: result.failureCount });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ SEND ATTENDANCE REPORTS TO PARENTS VIA GMAIL
app.post('/send-reports', verifySecret, async (req, res) => {
  try {
    const { emails } = req.body;
    if (!emails || !Array.isArray(emails)) return res.status(400).json({ error: 'emails array required' });
    if (!GMAIL_USER || !GMAIL_PASS) return res.status(500).json({ error: 'Gmail not configured in server env vars' });

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_PASS },
    });

    let sent = 0;
    let failed = 0;

    for (const email of emails) {
      try {
        const periodLabel = email.period === 'weekly' ? 'Weekly (Last 7 Days)' : 'Monthly (Last 30 Days)';
        const statusEmoji = email.percentage >= 75 ? '✅' : '⚠️';
        const subjectWiseRows = (email.subjectWise || []).map(s =>
          `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;">${s.subject}</td>
           <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${s.present}/${s.total}</td>
           <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;color:${s.percentage>=75?'#16a34a':'#dc2626'};font-weight:bold;">${s.percentage}%</td></tr>`
        ).join('');

        const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#f8fafc;border-radius:12px;">
          <div style="background:linear-gradient(135deg,#3b82f6,#8b5cf6);padding:24px;border-radius:12px;text-align:center;margin-bottom:24px;">
            <h1 style="color:white;margin:0;font-size:22px;">Attendance Report ${statusEmoji}</h1>
            <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;">${periodLabel}</p>
          </div>
          <p style="color:#374151;">Dear <strong>${email.parentName}</strong>,</p>
          <p style="color:#374151;">Here is the attendance report for your child <strong>${email.studentName}</strong> (${email.usn}):</p>
          <div style="background:white;border-radius:12px;padding:20px;margin:16px 0;text-align:center;">
            <div style="font-size:48px;font-weight:bold;color:${email.percentage>=75?'#16a34a':'#dc2626'};">${email.percentage}%</div>
            <p style="color:#6b7280;margin:4px 0;">Overall Attendance</p>
            <div style="display:flex;justify-content:center;gap:24px;margin-top:12px;">
              <span style="color:#16a34a;">✓ Present: ${email.present}</span>
              <span style="color:#dc2626;">✗ Absent: ${email.absent}</span>
              <span style="color:#6b7280;">Total: ${email.total}</span>
            </div>
          </div>
          ${subjectWiseRows ? `
          <div style="background:white;border-radius:12px;padding:16px;margin:16px 0;">
            <h3 style="color:#374151;margin:0 0 12px;">Subject-wise Attendance</h3>
            <table style="width:100%;border-collapse:collapse;">
              <thead><tr style="background:#f3f4f6;">
                <th style="padding:8px 12px;text-align:left;color:#374151;">Subject</th>
                <th style="padding:8px 12px;text-align:center;color:#374151;">Classes</th>
                <th style="padding:8px 12px;text-align:center;color:#374151;">%</th>
              </tr></thead>
              <tbody>${subjectWiseRows}</tbody>
            </table>
          </div>` : ''}
          ${email.percentage < 75 ? '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;color:#dc2626;margin:16px 0;">⚠️ Attendance is below 75%. Please ensure regular attendance to avoid exam debarment.</div>' : ''}
          <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:24px;">This is an automated report from the Attendance Management System.</p>
        </div>`;

        await transporter.sendMail({
          from: `"Attendance System" <${GMAIL_USER}>`,
          to: email.to,
          subject: `${periodLabel} Attendance Report - ${email.studentName} (${email.usn})`,
          html,
        });
        sent++;
        console.log(`✅ Email sent to ${email.to}`);
      } catch (err) {
        console.error(`❌ Failed to send to ${email.to}:`, err.message);
        failed++;
      }
    }

    res.json({ success: true, sent, failed });
  } catch (error) {
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
