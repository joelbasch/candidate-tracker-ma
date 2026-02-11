const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

const DatabaseManager = require('./database');
const loxo = require('./loxoService');
const npi = require('./npiService');
const LinkedInService = require('./linkedinService');
const SocialMediaService = require('./socialMediaService');
const DataSyncService = require('./dataSyncService');
const MonitoringScheduler = require('./monitoringScheduler');

const app = express();
const PORT = process.env.PORT || 3001;

// Pipeline stages to track (candidates in these stages should be monitored)
// These are stages where candidate has been submitted to a client
const TRACKABLE_STAGES = [
  'name clear requested',
  'name clear',
  'name cleared',
  'submitted',
  'client phone interview',
  'phone interview',
  'client in-person interview',
  'in-person interview',
  'working interview',
  'negotiation',
  'offer',
  'offer extended',
  'offer accepted',
  'hired',
  'placed',
  'started'
];

// Configure multer for file uploads (use DATA_DIR if set for cloud persistence)
const uploadsDir = path.join(process.env.DATA_DIR || process.env.RENDER_DISK_PATH || '.', 'uploads');
const upload = multer({ dest: uploadsDir });
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize services
const db = new DatabaseManager();
const linkedin = new LinkedInService();
const socialMedia = new SocialMediaService();
const dataSync = new DataSyncService(db);
const scheduler = new MonitoringScheduler(db, npi, linkedin, socialMedia);

/**
 * Check if an event/stage name is trackable
 */
function isTrackableStage(eventName) {
  if (!eventName) return false;
  const normalized = eventName.toLowerCase()
    .replace('moved to ', '')
    .replace('move to ', '')
    .trim();
  
  return TRACKABLE_STAGES.some(stage => normalized.includes(stage));
}

/**
 * Extract the clean stage name from event name
 */
function extractStageName(eventName) {
  if (!eventName) return '';
  
  // Remove "Moved to " prefix
  let stage = eventName.replace(/^moved to /i, '').replace(/^move to /i, '').trim();
  
  // Capitalize first letter of each word
  return stage.split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Parse CSV that may have multi-line fields (like Loxo exports)
 */
function parseCSV(content) {
  const rows = [];
  let currentRow = [];
  let currentField = '';
  let insideQuotes = false;
  
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const nextChar = content[i + 1];
    
    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentField += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      currentRow.push(currentField.trim());
      currentField = '';
    } else if ((char === '\n' || char === '\r') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      if (currentField || currentRow.length > 0) {
        currentRow.push(currentField.trim());
        if (currentRow.some(f => f)) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = '';
      }
    } else {
      currentField += char;
    }
  }
  
  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some(f => f)) {
      rows.push(currentRow);
    }
  }
  
  return rows;
}

/**
 * Detect CSV format and return column mappings
 */
function detectCSVFormat(headers) {
  const headerLower = headers.map(h => (h || '').toLowerCase().trim());
  
  console.log('Detecting CSV format. Headers:', headerLower.slice(0, 10));
  
  // Loxo REPORTING Export Format
  if (headerLower.includes('candidate name') && headerLower.includes('company name') && headerLower.includes('event name')) {
    console.log('Detected: Loxo REPORTING format');
    return {
      format: 'loxo-reporting',
      id: headerLower.indexOf('id'),
      user: headerLower.indexOf('user'),
      companyName: headerLower.indexOf('company name'),
      jobTitle: headerLower.indexOf('job title'),
      candidateName: headerLower.indexOf('candidate name'),
      candidateOwner: headerLower.indexOf('candidate owner'),
      candidateSource: headerLower.indexOf('candidate source'),
      eventName: headerLower.indexOf('event name'),
      createdAt: headerLower.indexOf('created at'),
      notes: headerLower.indexOf('notes')
    };
  }
  
  // Loxo PEOPLE Export Format
  if (headerLower.includes('id') && headerLower.includes('name') && 
      (headerLower.includes('linkedin') || headerLower.includes('linkedln'))) {
    console.log('Detected: Loxo PEOPLE format');
    return {
      format: 'loxo-people',
      id: headerLower.indexOf('id'),
      name: headerLower.indexOf('name'),
      phone: headerLower.indexOf('phone'),
      email: headerLower.indexOf('email'),
      title: headerLower.indexOf('title'),
      company: headerLower.indexOf('company'),
      city: headerLower.indexOf('city'),
      state: headerLower.indexOf('state'),
      linkedin: headerLower.findIndex(h => h.includes('linkedin')),
      facebook: headerLower.indexOf('facebook'),
      twitter: headerLower.indexOf('twitter'),
      instagram: headerLower.indexOf('instagram'),
      globalStatus: headerLower.indexOf('global status'),
      jobStage: headerLower.indexOf('job stage')
    };
  }
  
  // Original Eye to Eye format
  if (headerLower.includes('full name') || headerLower.includes('npi number')) {
    console.log('Detected: Original Eye to Eye format');
    return {
      format: 'original',
      name: headerLower.indexOf('full name'),
      npi: headerLower.indexOf('npi number'),
      linkedin: headerLower.indexOf('linkedin url'),
      email: headerLower.indexOf('email'),
      phone: headerLower.indexOf('phone'),
      clientName: headerLower.indexOf('client name'),
      submittedDate: headerLower.indexOf('submitted date'),
      jobTitle: headerLower.indexOf('job title')
    };
  }
  
  // Fallback
  console.log('Detected: Simple/fallback format');
  return {
    format: 'simple',
    name: 0,
    npi: 1,
    linkedin: 2,
    email: 3,
    phone: 4,
    clientName: 5,
    submittedDate: 6,
    jobTitle: 7
  };
}

/**
 * Parse date from various formats
 */
function parseDate(dateStr) {
  if (!dateStr) return new Date().toISOString().split('T')[0];
  if (dateStr.includes(' ')) {
    return dateStr.split(' ')[0];
  }
  return dateStr;
}

// Routes

// Get dashboard stats
app.get('/api/stats', (req, res) => {
  try {
    const stats = db.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all candidates
app.get('/api/candidates', (req, res) => {
  try {
    res.json(db.data.candidates || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get alerts
app.get('/api/alerts', (req, res) => {
  try {
    const { status } = req.query;
    let alerts = db.data.alerts || [];

    if (status) {
      alerts = alerts.filter(a => a.status === status);
    }

    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get submissions
app.get('/api/submissions', (req, res) => {
  try {
    const submissions = db.getActiveSubmissions();
    res.json(submissions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update alert status
app.put('/api/alerts/:id', (req, res) => {
  try {
    const alertId = parseInt(req.params.id);
    if (isNaN(alertId)) {
      return res.status(400).json({ error: 'Invalid alert ID' });
    }

    const { status, reviewedBy, notes } = req.body;
    const validStatuses = ['pending', 'confirmed', 'dismissed', 'reviewing'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const alert = db.data.alerts.find(a => a.id === alertId);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }

    alert.status = status;
    alert.reviewed_by = reviewedBy;
    alert.review_notes = notes;
    alert.reviewed_at = new Date().toISOString();

    db.saveDatabase();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// CSV Upload endpoint
app.post('/api/upload/csv', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const cleanContent = fileContent.replace(/^\uFEFF/, '');
    const rows = parseCSV(cleanContent);
    
    if (rows.length < 2) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'CSV file is empty or has no data rows' });
    }

    const headers = rows[0];
    const mapping = detectCSVFormat(headers);
    
    console.log(`CSV Format: ${mapping.format}`);
    console.log(`Total rows: ${rows.length - 1}`);

    let candidatesImported = 0;
    let submissionsImported = 0;
    let skipped = 0;
    let skippedNonTrackable = 0;

    const seenCandidates = new Map();

    for (let i = 1; i < rows.length; i++) {
      const values = rows[i];
      
      if (mapping.format === 'loxo-reporting') {
        const candidateName = values[mapping.candidateName] || '';
        const companyName = values[mapping.companyName] || '';
        const eventName = values[mapping.eventName] || '';
        
        if (!candidateName || candidateName.length < 2) {
          skipped++;
          continue;
        }

        // Only import candidates in trackable pipeline stages
        if (!isTrackableStage(eventName)) {
          console.log(`  Skipping "${candidateName}" - stage "${eventName}" not tracked`);
          skippedNonTrackable++;
          continue;
        }

        console.log(`  Importing "${candidateName}" at "${companyName}" - stage: "${eventName}"`);

        const candidateKey = candidateName.toLowerCase().trim();
        let existingCandidate = seenCandidates.get(candidateKey);
        
        if (!existingCandidate) {
          existingCandidate = db.data.candidates.find(c => 
            c.full_name.toLowerCase().trim() === candidateKey
          );
        }

        if (!existingCandidate) {
          const candidateData = {
            loxo_id: values[mapping.id] || `csv-${Date.now()}-${i}`,
            full_name: candidateName,
            npi_number: '',
            linkedin_url: '',
            email: '',
            phone: '',
            facebook_url: '',
            twitter_url: '',
            instagram_url: '',
            title: values[mapping.jobTitle] || '',
            current_company: '',
            city: '',
            state: ''
          };

          const result = db.insertCandidate(candidateData);
          if (result.changes > 0) {
            candidatesImported++;
            existingCandidate = db.getCandidateByLoxoId(candidateData.loxo_id);
            seenCandidates.set(candidateKey, existingCandidate);
          }
        } else {
          seenCandidates.set(candidateKey, existingCandidate);
        }

        // Create/update submission with pipeline stage
        if (companyName && companyName.length > 2 && existingCandidate) {
          const existingSubmission = (db.data.submissions || []).find(s =>
            s.candidate_id === existingCandidate.id &&
            s.client_name.toLowerCase() === companyName.toLowerCase()
          );

          const pipelineStage = extractStageName(eventName);
          const submissionDate = parseDate(values[mapping.createdAt]);

          if (!existingSubmission) {
            const submissionData = {
              candidate_id: existingCandidate.id,
              client_name: companyName,
              submitted_date: submissionDate,
              job_title: values[mapping.jobTitle] || '',
              pipeline_stage: pipelineStage,
              recruiter: values[mapping.user] || '',
              source: values[mapping.candidateSource] || '',
              notes: values[mapping.notes] || ''
            };

            db.insertSubmission(submissionData);
            submissionsImported++;
          } else {
            // Update existing submission with latest stage if it's further in pipeline
            const stageOrder = [
              'Name Clear Requested', 
              'Name Cleared', 
              'Submitted', 
              'Client Phone Interview', 
              'Client In-Person Interview', 
              'Working Interview',
              'Negotiation', 
              'Offer',
              'Offer Extended',
              'Offer Accepted',
              'Hired',
              'Placed',
              'Started'
            ];
            const currentIndex = stageOrder.findIndex(s => 
              existingSubmission.pipeline_stage && existingSubmission.pipeline_stage.toLowerCase().includes(s.toLowerCase())
            );
            const newIndex = stageOrder.findIndex(s => 
              pipelineStage.toLowerCase().includes(s.toLowerCase())
            );
            
            if (newIndex > currentIndex) {
              existingSubmission.pipeline_stage = pipelineStage;
              existingSubmission.updated_at = new Date().toISOString();
              db.saveDatabase();
            }
          }
        }

      } else if (mapping.format === 'loxo-people') {
        const name = values[mapping.name] || '';
        if (!name || name.length < 2) {
          skipped++;
          continue;
        }

        const candidateData = {
          loxo_id: values[mapping.id] || `csv-${Date.now()}-${i}`,
          full_name: name,
          npi_number: '',
          linkedin_url: values[mapping.linkedin] || '',
          email: values[mapping.email] || '',
          phone: values[mapping.phone] || '',
          facebook_url: mapping.facebook >= 0 ? (values[mapping.facebook] || '') : '',
          twitter_url: mapping.twitter >= 0 ? (values[mapping.twitter] || '') : '',
          instagram_url: mapping.instagram >= 0 ? (values[mapping.instagram] || '') : '',
          title: values[mapping.title] || '',
          current_company: values[mapping.company] || '',
          city: values[mapping.city] || '',
          state: values[mapping.state] || ''
        };

        const result = db.insertCandidate(candidateData);
        if (result.changes > 0) {
          candidatesImported++;
        }

        const candidate = db.getCandidateByLoxoId(candidateData.loxo_id);
        const company = values[mapping.company];
        if (company && company.length > 2 && candidate) {
          db.insertSubmission({
            candidate_id: candidate.id,
            client_name: company,
            submitted_date: new Date().toISOString().split('T')[0],
            job_title: values[mapping.title] || 'Optometrist',
            pipeline_stage: 'Imported'
          });
          submissionsImported++;
        }

      } else {
        const name = values[mapping.name] || '';
        if (!name || name.length < 2) {
          skipped++;
          continue;
        }

        const candidateData = {
          loxo_id: `csv-${Date.now()}-${i}`,
          full_name: name,
          npi_number: values[mapping.npi] || '',
          linkedin_url: values[mapping.linkedin] || '',
          email: values[mapping.email] || '',
          phone: values[mapping.phone] || ''
        };

        const result = db.insertCandidate(candidateData);
        if (result.changes > 0) candidatesImported++;

        const candidate = db.getCandidateByLoxoId(candidateData.loxo_id);
        const clientName = values[mapping.clientName];
        if (clientName && clientName.length > 2 && candidate) {
          db.insertSubmission({
            candidate_id: candidate.id,
            client_name: clientName,
            submitted_date: values[mapping.submittedDate] || new Date().toISOString().split('T')[0],
            job_title: values[mapping.jobTitle] || '',
            pipeline_stage: 'Submitted'
          });
          submissionsImported++;
        }
      }
    }

    fs.unlinkSync(filePath);
    
    console.log(`\n========== CSV Import Summary ==========`);
    console.log(`Format: ${mapping.format}`);
    console.log(`New candidates: ${candidatesImported}`);
    console.log(`Submissions: ${submissionsImported}`);
    console.log(`Skipped (invalid): ${skipped}`);
    console.log(`Skipped (not in trackable stage): ${skippedNonTrackable}`);
    console.log(`=========================================\n`);
    
    res.json({ 
      success: true, 
      format: mapping.format,
      candidates: candidatesImported, 
      submissions: submissionsImported,
      skipped: skipped,
      skippedNonTrackable: skippedNonTrackable
    });
  } catch (error) {
    console.error('CSV upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete candidate
app.delete('/api/candidates/:id', (req, res) => {
  try {
    const candidateId = parseInt(req.params.id);
    if (isNaN(candidateId)) {
      return res.status(400).json({ error: 'Invalid candidate ID' });
    }

    const candidate = db.data.candidates.find(c => c.id === candidateId);
    if (!candidate) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    db.data.submissions = db.data.submissions.filter(s => s.candidate_id !== candidateId);
    db.data.alerts = db.data.alerts.filter(a => a.candidate_id !== candidateId);
    db.data.candidates = db.data.candidates.filter(c => c.id !== candidateId);

    db.saveDatabase();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Trigger Loxo sync
app.post('/api/sync/loxo', async (req, res) => {
  try {
    console.log('Manual Loxo sync triggered');
    const result = await dataSync.fullSync();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual monitoring trigger
app.post('/api/monitoring/run', async (req, res) => {
  try {
    console.log('Manual monitoring check triggered');
    const result = await scheduler.runMonitoring();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test Loxo connection
app.get('/api/loxo/test', async (req, res) => {
  try {
    const status = await loxo.testConnection();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// NPI backfill endpoint
app.post('/api/npi/backfill', async (req, res) => {
  try {
    console.log('NPI backfill triggered');
    const result = await dataSync.backfillNPINumbers();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Search NPI by name
app.get('/api/npi/search/:name', async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name).trim();
    if (!name || name.length < 2) {
      return res.status(400).json({ error: 'Name must be at least 2 characters' });
    }
    const results = await npi.searchByName(name);
    res.json(results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all company relationships
app.get('/api/companies/relationships', (req, res) => {
  try {
    const relationships = scheduler.getCompanyRelationships();
    res.json(relationships);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add a company relationship
app.post('/api/companies/relationships', (req, res) => {
  try {
    const { parentCompany, subsidiary } = req.body;
    if (!parentCompany || !subsidiary) {
      return res.status(400).json({ error: 'parentCompany and subsidiary are required' });
    }
    scheduler.addCompanyRelationship(parentCompany, subsidiary);
    res.json({ success: true, message: `Added relationship: ${parentCompany} → ${subsidiary}` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, async () => {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║  Eye to Eye Careers - Candidate Tracker                        ║
║  Server running on: http://localhost:${PORT}                      ║
╚════════════════════════════════════════════════════════════════╝
  `);
  console.log('Services initialized:');
  console.log('✓ Database');
  
  try {
    const loxoStatus = await loxo.testConnection();
    if (loxoStatus.connected) {
      console.log('✓ Loxo API connection verified');
    } else {
      console.log('⚠ Loxo API not connected:', loxoStatus.error || 'Check credentials');
    }
  } catch (e) {
    console.log('⚠ Loxo API Integration (not configured)');
  }
  
  await npi.initialize();
  
  console.log('✓ LinkedIn Monitoring');
  console.log('✓ Social Media Monitoring');
  console.log('✓ Company Research Service (parent/subsidiary matching)');
  console.log('');
  console.log('Pipeline stages tracked:');
  console.log('  • Name Clear Requested');
  console.log('  • Name Cleared');
  console.log('  • Submitted');
  console.log('  • Client Phone Interview');
  console.log('  • Client In-Person Interview');
  console.log('  • Working Interview');
  console.log('  • Negotiation');
  console.log('  • Offer / Offer Extended / Offer Accepted');
  console.log('  • Hired / Placed / Started');
  console.log('');
  console.log(process.env.NODE_ENV === 'production' ? '✓ Scheduled monitoring enabled' : '⚠ Scheduled monitoring disabled in development');
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, closing database...');
  db.close();
  process.exit(0);
});
