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
}

module.exports = DatabaseManager;
