const path = require('path');
const express = require('express');
const cors = require('cors');
const pool = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

let pendingRegistration = null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

function normalizeUid(uid) {
  return String(uid || '').trim().toUpperCase().replace(/\s+/g, '');
}

function toBool(value) {
  return String(value).toLowerCase() === 'true';
}

async function getBiometricsEnabled() {
  const result = await pool.query(
    "SELECT value FROM settings WHERE key = 'biometrics_enabled'"
  );
  return result.rows.length ? toBool(result.rows[0].value) : true;
}

async function getNextFingerprintId() {
  const idResult = await pool.query(
    'SELECT COALESCE(MAX(fingerprint_id), 0) + 1 AS next_id FROM users'
  );
  return Number(idResult.rows[0].next_id);
}

async function addAttendanceLog({ user, rfidUid, fingerprintId, status, message }) {
  await pool.query(
    `INSERT INTO attendance_logs
       (user_id, user_name, rfid_uid, fingerprint_id, status, message)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      user ? user.id : null,
      user ? user.name : null,
      rfidUid || null,
      fingerprintId || null,
      status,
      message
    ]
  );
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Attendance server is running' });
});

app.get('/api/users', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, fingerprint_id, rfid_uid, created_at FROM users ORDER BY id DESC'
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/registration/start', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();

    if (!name) {
      return res.status(400).json({ error: 'User name is required' });
    }

    const nextFingerprintId = await getNextFingerprintId();

    pendingRegistration = {
      name,
      status: 'waiting_for_esp32',
      nextFingerprintId,
      createdAt: new Date().toISOString()
    };

    res.json({
      message: 'Registration started. Use the ESP32 to scan fingerprint and RFID.',
      registration: pendingRegistration
    });
  } catch (error) {
    res.status(500).json({
      error: `Cannot start registration: ${error.message}`
    });
  }
});

app.get('/api/registration/status', (req, res) => {
  res.json({
    active: Boolean(pendingRegistration),
    registration: pendingRegistration
  });
});

app.get('/api/esp32/registration-task', async (req, res) => {
  if (!pendingRegistration) {
    return res.json({ active: false });
  }

  pendingRegistration.status = 'esp32_registration_mode';

  res.json({
    active: true,
    name: pendingRegistration.name,
    fingerprint_id: pendingRegistration.nextFingerprintId
  });
});

app.post('/api/esp32/registration-complete', async (req, res) => {
  try {
    if (!pendingRegistration) {
      return res.status(400).json({ error: 'No registration is active' });
    }

    const fingerprintId = Number(req.body.fingerprint_id);
    const rfidUid = normalizeUid(req.body.rfid_uid);

    if (!fingerprintId || !rfidUid) {
      return res.status(400).json({ error: 'fingerprint_id and rfid_uid are required' });
    }

    const result = await pool.query(
      `INSERT INTO users (name, fingerprint_id, rfid_uid)
       VALUES ($1, $2, $3)
       RETURNING id, name, fingerprint_id, rfid_uid, created_at`,
      [pendingRegistration.name, fingerprintId, rfidUid]
    );

    pendingRegistration = {
      ...pendingRegistration,
      status: 'completed',
      user: result.rows[0]
    };

    const completed = pendingRegistration;
    pendingRegistration = null;

    res.json({
      message: 'User registered successfully',
      registration: completed,
      user: result.rows[0]
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'This RFID card or fingerprint ID is already assigned to another user'
      });
    }

    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING id',
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ message: 'User deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/settings/biometrics', async (req, res) => {
  try {
    res.json({ enabled: await getBiometricsEnabled() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/settings/biometrics', async (req, res) => {
  try {
    const enabled = Boolean(req.body.enabled);

    await pool.query(
      `INSERT INTO settings (key, value)
       VALUES ('biometrics_enabled', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(enabled)]
    );

    res.json({ enabled });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/attendance/verify', async (req, res) => {
  try {
    const rfidUid = normalizeUid(req.body.rfid_uid);
    const fingerprintId = req.body.fingerprint_id ? Number(req.body.fingerprint_id) : null;
    const biometricsEnabled = await getBiometricsEnabled();

    if (!rfidUid) {
      return res.status(400).json({ error: 'rfid_uid is required' });
    }

    const userResult = await pool.query(
      'SELECT id, name, fingerprint_id, rfid_uid FROM users WHERE rfid_uid = $1',
      [rfidUid]
    );

    if (!userResult.rows.length) {
      await addAttendanceLog({
        rfidUid,
        fingerprintId,
        status: 'DENIED',
        message: 'RFID card is not registered'
      });

      return res.status(403).json({
        success: false,
        status: 'DENIED',
        message: 'RFID card is not registered'
      });
    }

    const user = userResult.rows[0];

    if (biometricsEnabled && user.fingerprint_id !== fingerprintId) {
      await addAttendanceLog({
        user,
        rfidUid,
        fingerprintId,
        status: 'DENIED',
        message: 'Fingerprint does not match this RFID card'
      });

      return res.status(403).json({
        success: false,
        status: 'DENIED',
        message: 'Fingerprint does not match this RFID card'
      });
    }

    await addAttendanceLog({
      user,
      rfidUid,
      fingerprintId: biometricsEnabled ? fingerprintId : null,
      status: 'RECORDED',
      message: biometricsEnabled
        ? 'RFID and fingerprint matched'
        : 'RFID matched. Biometrics disabled.'
    });

    res.json({
      success: true,
      status: 'RECORDED',
      message: 'Attendance recorded',
      user
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/attendance/logs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, user_name, rfid_uid, fingerprint_id, status, message, created_at
       FROM attendance_logs
       ORDER BY created_at DESC
       LIMIT 200`
    );

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/attendance/export', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT user_name, rfid_uid, fingerprint_id, status, message, created_at
       FROM attendance_logs
       ORDER BY created_at DESC`
    );

    const headers = ['user_name', 'rfid_uid', 'fingerprint_id', 'status', 'message', 'created_at'];
    const rows = result.rows.map((row) =>
      headers.map((header) => `"${String(row[header] ?? '').replace(/"/g, '""')}"`).join(',')
    );

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance_logs.csv"');
    res.send([headers.join(','), ...rows].join('\n'));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Attendance server running on http://localhost:${PORT}`);
});
