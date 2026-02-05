/**
 * Simple JSON Database Manager
 */
const fs = require('fs');
const path = require('path');

class DatabaseManager {
  constructor(dbPath = 'tracker-data.json') {
    this.dbPath = dbPath;
    this.data = {
      candidates: [],
      submissions: [],
      alerts: [],
      syncHistory: []
    };
    this.loadDatabase();
  }

  loadDatabase() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const rawData = fs.readFileSync(this.dbPath, 'utf8');
        this.data = JSON.parse(rawData);
        console.log(`Database loaded: ${this.data.candidates?.length || 0} candidates, ${this.data.submissions?.length || 0} submissions`);
      } else {
        this.saveDatabase();
        console.log('New database created');
      }
    } catch (error) {
      console.error('Error loading database:', error.message);
      this.saveDatabase();
    }
  }

  saveDatabase() {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('Error saving database:', error.message);
    }
  }

  close() {
    this.saveDatabase();
    console.log('Database closed');
  }

  // Get dashboard statistics
  getStats() {
    const candidates = this.data.candidates || [];
    const submissions = this.data.submissions || [];
    const alerts = this.data.alerts || [];

    return {
      totalCandidates: candidates.length,
      activeSubmissions: submissions.filter(s => s.status !== 'closed').length,
      pendingAlerts: alerts.filter(a => a.status === 'pending').length,
      confirmedAlerts: alerts.filter(a => a.status === 'confirmed').length
    };
  }

  // Get active submissions
  getActiveSubmissions() {
    return (this.data.submissions || []).filter(s => s.status !== 'closed');
  }

  // Insert a new candidate
  insertCandidate(candidateData) {
    // Check if candidate already exists by loxo_id or name
    const existing = this.data.candidates.find(c =>
      c.loxo_id === candidateData.loxo_id ||
      c.full_name?.toLowerCase() === candidateData.full_name?.toLowerCase()
    );

    if (existing) {
      // Update existing candidate
      Object.assign(existing, candidateData, { updated_at: new Date().toISOString() });
      this.saveDatabase();
      return { changes: 0, lastInsertRowid: existing.id };
    }

    // Create new candidate
    const newId = (this.data.candidates.length > 0)
      ? Math.max(...this.data.candidates.map(c => c.id || 0)) + 1
      : 1;

    const newCandidate = {
      id: newId,
      ...candidateData,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    this.data.candidates.push(newCandidate);
    this.saveDatabase();
    return { changes: 1, lastInsertRowid: newId };
  }

  // Get candidate by Loxo ID
  getCandidateByLoxoId(loxoId) {
    return this.data.candidates.find(c => c.loxo_id === loxoId);
  }

  // Get candidate by ID
  getCandidateById(id) {
    return this.data.candidates.find(c => c.id === id);
  }

  // Insert a new submission
  insertSubmission(submissionData) {
    // Check if submission already exists
    const existing = this.data.submissions.find(s =>
      s.candidate_id === submissionData.candidate_id &&
      s.client_name?.toLowerCase() === submissionData.client_name?.toLowerCase()
    );

    if (existing) {
      Object.assign(existing, submissionData, { updated_at: new Date().toISOString() });
      this.saveDatabase();
      return { changes: 0, lastInsertRowid: existing.id };
    }

    const newId = (this.data.submissions.length > 0)
      ? Math.max(...this.data.submissions.map(s => s.id || 0)) + 1
      : 1;

    const newSubmission = {
      id: newId,
      ...submissionData,
      status: submissionData.status || 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    this.data.submissions.push(newSubmission);
    this.saveDatabase();
    return { changes: 1, lastInsertRowid: newId };
  }

  // Insert a new alert
  insertAlert(alertData) {
    // Check for duplicate alert
    const existing = this.data.alerts.find(a =>
      a.candidate_id === alertData.candidate_id &&
      a.alert_type === alertData.alert_type &&
      a.business_found === alertData.business_found
    );

    if (existing) {
      return { changes: 0, lastInsertRowid: existing.id };
    }

    const newId = (this.data.alerts.length > 0)
      ? Math.max(...this.data.alerts.map(a => a.id || 0)) + 1
      : 1;

    const newAlert = {
      id: newId,
      ...alertData,
      status: alertData.status || 'pending',
      created_at: new Date().toISOString()
    };

    this.data.alerts.push(newAlert);
    this.saveDatabase();
    return { changes: 1, lastInsertRowid: newId };
  }

  // Get all candidates
  getAllCandidates() {
    return this.data.candidates || [];
  }

  // Get all submissions
  getAllSubmissions() {
    return this.data.submissions || [];
  }

  // Get all alerts
  getAllAlerts() {
    return this.data.alerts || [];
  }

  // Update candidate
  updateCandidate(id, updates) {
    const candidate = this.data.candidates.find(c => c.id === id);
    if (candidate) {
      Object.assign(candidate, updates, { updated_at: new Date().toISOString() });
      this.saveDatabase();
      return { changes: 1 };
    }
    return { changes: 0 };
  }

  // Update alert
  updateAlert(id, updates) {
    const alert = this.data.alerts.find(a => a.id === id);
    if (alert) {
      Object.assign(alert, updates);
      this.saveDatabase();
      return { changes: 1 };
    }
    return { changes: 0 };
  }
}

module.exports = DatabaseManager;
