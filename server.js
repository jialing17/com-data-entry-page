const express = require('express');
const methodOverride = require('method-override');
const path = require('path');
const { db, initialize } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.BIND_HOST || '0.0.0.0';

// Initialize database
initialize();

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Routes
app.use('/', require('./routes/events'));
app.use('/operators', require('./routes/operators'));
app.use('/events', require('./routes/records'));
app.use('/events', require('./routes/export'));

// API endpoint for service worker to get all event IDs
app.get('/api/events-list', (req, res) => {
  try {
    const events = db.prepare('SELECT id FROM events ORDER BY id').all();
    res.json(events);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Test counter for simulating fail-then-success
let syncAttemptCount = 0;

// API endpoint to sync offline operations from IndexedDB to server
app.post('/api/sync', (req, res) => {
  // test sync partial fail
  // return res.json({
  //   status: 'PARTIAL', 
  //   results: [
  //     { id: 1, success: false, error: 'FOREIGN_KEY_CONSTRAINT', message: 'Fake constraint error for testing' }
  //   ],
  //   synced: 1,
  //   failed: 1
  // });

  // test sync completely fail
  //  return res.status(500).json({ 
  //   error: 'Database connection failed - TEST MODE' 
  // });

  // test for fail -> success retry logic
  // syncAttemptCount++;
  
  // // TEST: Fail first 2 times, then succeed
  // if (syncAttemptCount <= 2) {
  //   console.log(`Sync attempt ${syncAttemptCount}: FAILED (test mode)`);
  //   return res.status(500).json({ 
  //     error: `Test failure #${syncAttemptCount} - will succeed on retry` 
  //   });
  // }
  
  console.log(`Sync attempt ${syncAttemptCount}: SUCCESS (test mode)`);
  
  const { operations } = req.body;
  if (!operations || !Array.isArray(operations)) {
    return res.status(400).json({ error: 'Invalid operations format' });
  }

  const results = [];
  
  try {
    operations.forEach(op => {
      const { id, operation, table, data, recordId } = op;
      
      if (!table) {
        results.push({ id, success: false, error: 'Missing table' });
        return;
      }

      try {
        // Handle different operation types
        if (operation === 'DELETE') {
          if (!recordId) {
            results.push({ id, success: false, error: 'Missing recordId for DELETE' });
            return;
          }
          
          const allowedTables = ['baseline_records', 'pyrocks_records', 'donutech_records', 'sg_records', 'operators'];
          if (!allowedTables.includes(table)) {
            results.push({ id, success: false, error: `Invalid table ${table}` });
            return;
          }
          
          db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(recordId);
          results.push({ id, success: true });
        }

        else if (operation === 'CREATE') {
          if (!data) {
            results.push({ id, success: false, error: 'Missing data for CREATE' });
            return;
          }

          // Handle operator creation (different field requirements)
          if (table === 'operators') {
            if (!data.name || !data.project) {
              results.push({ id, success: false, error: 'Incomplete operator data' });
              return;
            }
            db.prepare('INSERT INTO operators (name, project) VALUES (?, ?)').run(data.name, data.project);
            results.push({ id, success: true });
            return;
          }

          // skip if essential fields are missing for records
          if (!data.event_id || !data.operator_id || !data.subject_id) {
            results.push({ id, success: false, error: 'Missing essential fields' });
            return;
          }

          // Insert based on table name
          if (table === 'baseline_records') {
            if (!data.height || !data.weight || !data.waist_circumference || !data.hip_circumference || !data.grip_strength) {
              results.push({ id, success: false, error: 'Missing baseline fields' });
              return;
            }
            db.prepare(`
              INSERT INTO baseline_records
              (event_id, operator_id, subject_id, height, weight, waist_circumference, hip_circumference, grip_strength)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              data.event_id, data.operator_id, data.subject_id,
              data.height, data.weight, data.waist_circumference, data.hip_circumference, data.grip_strength
            );
            results.push({ id, success: true });
          } 
          else if (table === 'pyrocks_records') {
            if (!data.risk) {
              results.push({ id, success: false, error: 'Missing risk field' });
              return;
            }
            db.prepare(`
              INSERT INTO pyrocks_records (event_id, operator_id, subject_id, risk)
              VALUES (?, ?, ?, ?)
            `).run(data.event_id, data.operator_id, data.subject_id, data.risk);
            results.push({ id, success: true });
          } 
          else if (table === 'donutech_records') {
            if (!data.blood_pressure || !data.heart_rate || !data.blood_glucose || !data.time_since_last_meal) {
              results.push({ id, success: false, error: 'Missing donutech fields' });
              return;
            }
            db.prepare(`
              INSERT INTO donutech_records
              (event_id, operator_id, subject_id, blood_pressure, heart_rate, blood_glucose, time_since_last_meal, remarks)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              data.event_id, data.operator_id, data.subject_id,
              data.blood_pressure, data.heart_rate, data.blood_glucose, data.time_since_last_meal, data.remarks || ''
            );
            results.push({ id, success: true });
          } 
          else if (table === 'sg_records') {
            if (!data.serial_number || !data.hba1c || !data.total_cholesterol || !data.hdl || !data.trig || !data.ldl || !data.glucose_donutech || !data.hba1c_equip_no || !data.cholesterol_equip_no) {
              results.push({ id, success: false, error: 'Missing sg fields' });
              return;
            }
            db.prepare(`
              INSERT INTO sg_records
              (event_id, operator_id, serial_number, subject_id, hba1c, total_cholesterol, hdl, trig, ldl, glucose_donutech, hba1c_equip_no, cholesterol_equip_no, remarks)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              data.event_id, data.operator_id, data.serial_number, data.subject_id,
              data.hba1c, data.total_cholesterol, data.hdl, data.trig, data.ldl, data.glucose_donutech,
              data.hba1c_equip_no, data.cholesterol_equip_no, data.remarks || ''
            );
            results.push({ id, success: true });
          }
          else {
            results.push({ id, success: false, error: `Unknown table ${table}` });
          }
        } 

        else {
          results.push({ id, success: false, error: `Unknown operation type: ${operation}` });
        }
      } catch (opErr) {
        console.error(`Error processing operation ${id}:`, opErr);
        results.push({ id, success: false, error: opErr.message });
      }
    });

    const synced = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;
    console.log(`Sync complete: ${synced} succeeded, ${failed} failed`);
    res.json({ results, synced, failed });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Health check endpoint for K8s probes
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', db: err.message });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`📋 Data Entry App running at http://${HOST}:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
