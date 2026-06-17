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

// API endpoint to sync offline operations from IndexedDB to server
app.post('/api/sync', (req, res) => {
  const { operations } = req.body;
  if (!operations || !Array.isArray(operations)) {
    return res.status(400).json({ error: 'Invalid operations format' });
  }

  let synced = 0;
  let skipped = 0;
  let processedCreated = 0;
  let processedDeletes = 0;
  
  try {
    operations.forEach(op => {
      const { operation, table, data, recordId } = op;
      
      if (!table) {
        skipped++;
        return;
      }

      // Handle different operation types
      if (operation === 'DELETE') {
        if (!recordId) {
          console.warn(`Skipping DELETE operation without recordId for table ${table}`);
          skipped++;
          return;
        }
        
        const allowedTables = ['baseline_records', 'pyrocks_records', 'donutech_records', 'sg_records'];
        if (!allowedTables.includes(table)) {
          console.warn(`Skipping DELETE for invalid table ${table}`);
          skipped++;
          return;
        }
        
        db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(recordId);
        processedDeletes++;
        synced++;
      } 

      else if (operation === 'CREATE') {
        if (!data) {
          skipped++;
          return;
        }

        // Validate required fields
        if (!data.event_id || !data.operator_id || !data.subject_id) {
          console.warn(`Skipping incomplete record for table ${table}:`, data);
          skipped++;
          return;
        }

        // Insert based on table name
        if (table === 'baseline_records') {
          if (!data.height || !data.weight || !data.waist_circumference || !data.hip_circumference || !data.grip_strength) {
            skipped++;
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
          synced++;
          processedCreated++;
        } 
        else if (table === 'pyrocks_records') {
          if (!data.risk) {
            skipped++;
            return;
          }
          db.prepare(`
            INSERT INTO pyrocks_records (event_id, operator_id, subject_id, risk)
            VALUES (?, ?, ?, ?)
          `).run(data.event_id, data.operator_id, data.subject_id, data.risk);
          synced++;
          processedCreated++;
        } 
        else if (table === 'donutech_records') {
          if (!data.blood_pressure || !data.heart_rate || !data.blood_glucose || !data.time_since_last_meal) {
            skipped++;
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
          synced++;
          processedCreated++;
        } 
        else if (table === 'sg_records') {
          if (!data.serial_number || !data.hba1c || !data.total_cholesterol || !data.hdl || !data.trig || !data.ldl || !data.glucose_donutech || !data.hba1c_equip_no || !data.cholesterol_equip_no) {
            skipped++;
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
          synced++;
          processedCreated++;
        }
        else {
          console.warn(`Skipping create for unknown table ${table}`);
          skipped++;
        }
      } 

      else {
        console.warn(`Unknown operation type: ${operation}`);
        skipped++;
      }
    });

    console.log(`Synced ${synced} operations (${skipped} skipped): ${processedCreated} creates, ${processedDeletes} deletes`);
    res.json({ synced, skipped, processedDeletes, processedCreated });
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
