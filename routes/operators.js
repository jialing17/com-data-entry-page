const express = require('express');
const router = express.Router();
const { db } = require('../db');

// Operator management page
router.get('/', (req, res) => {
  const operators = db.prepare('SELECT * FROM operators ORDER BY project, name').all();
  const events = db.prepare('SELECT id, name FROM events ORDER BY created_at DESC').all();
  
  // Check which operators have associated records
  const operatorsWithRecords = db.prepare(`
    SELECT DISTINCT operator_id FROM (
      SELECT operator_id FROM baseline_records
      UNION ALL
      SELECT operator_id FROM pyrocks_records
      UNION ALL
      SELECT operator_id FROM donutech_records
      UNION ALL
      SELECT operator_id FROM sg_records
    )
  `).all().map(r => r.operator_id);
  
  res.render('operators/manage', { operators, events, operatorsWithRecords });
});

// Create operator
router.post('/', (req, res) => {
  const { name, project } = req.body;
  db.prepare('INSERT INTO operators (name, project) VALUES (?, ?)').run(name, project);
  res.redirect('/operators');
});

// Update operator
router.put('/:id', (req, res) => {
  const { name, project } = req.body;
  db.prepare('UPDATE operators SET name = ?, project = ? WHERE id = ?').run(name, project, req.params.id);
  res.redirect('/operators');
});

// Delete operator
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM operators WHERE id = ?').run(req.params.id);
  res.redirect('/operators');
});

module.exports = router;
