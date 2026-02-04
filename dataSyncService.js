/**
 * Data Sync Service
 * Eye to Eye Careers - Candidate Placement Tracker
 * 
 * Updated: February 2026
 * 
 * This service handles synchronization between Loxo CRM and the local database.
 * It pulls candidates and their job submissions from Loxo and stores them locally
 * for monitoring purposes.
 * 
 * NEW: Integrates with NPI service to auto-discover NPI numbers for candidates
 */

const loxoService = require('./loxoService');
const npiService = require('./npiService');

class DataSyncService {
  constructor(database) {
    this.db = database;
    this.loxo = loxoService;
    this.npi = npiService;
    this.lastSyncTime = null;
    this.syncInProgress = false;
  }

  /**
   * Test connection to Loxo API
   */
  async testLoxoConnection() {
    return await this.loxo.testConnection();
  }

  /**
   * Full sync from Loxo - pulls all candidates and submissions
   * Now with automatic NPI discovery!
   */
  async fullSync() {
    if (this.syncInProgress) {
      return { 
        success: false, 
        message: 'Sync already in progress' 
      };
    }

    this.syncInProgress = true;
    const startTime = Date.now();
    
    const stats = {
      processed: 0,
      newCandidates: 0,
      updatedCandidates: 0,
      newSubmissions: 0,
      npiDiscovered: 0,
      errors: []
    };

    try {
      console.log('[DataSyncService] Starting full sync from Loxo...');

      // Use the new combined sync method
      const loxoData = await this.loxo.syncCandidatesAndSubmissions();
      
      if (loxoData.error) {
        throw new Error(loxoData.error);
      }

      console.log(`[DataSyncService] Processing ${loxoData.candidates.length} candidates...`);

      // Step 1: Process candidates
      for (const loxoCandidate of loxoData.candidates) {
        try {
          const candidate = {
            loxo_id: String(loxoCandidate.loxo_id),
            full_name: loxoCandidate.full_name,
            npi_number: loxoCandidate.npi_number || '',
            email: loxoCandidate.email || '',
            phone: loxoCandidate.phone || '',
            linkedin_url: loxoCandidate.linkedin_url || '',
            facebook_url: loxoCandidate.facebook_url || '',
            instagram_url: loxoCandidate.instagram_url || '',
            twitter_url: loxoCandidate.twitter_url || ''
          };
          
          // Check if candidate already exists
          const existingCandidate = this.findExistingCandidate(candidate);
          
          if (existingCandidate) {
            // Update existing candidate
            this.updateCandidate(existingCandidate.id, candidate);
            stats.updatedCandidates++;
            
            // If existing candidate has no NPI, try to find one
            if (!existingCandidate.npi_number && !candidate.npi_number) {
              const discoveredNPI = await this.discoverNPIForCandidate(candidate);
              if (discoveredNPI) {
                this.db.updateCandidate(existingCandidate.id, { npi_number: discoveredNPI });
                stats.npiDiscovered++;
              }
            }
          } else {
            // Try to discover NPI for new candidate if not provided
            if (!candidate.npi_number) {
              const discoveredNPI = await this.discoverNPIForCandidate(candidate);
              if (discoveredNPI) {
                candidate.npi_number = discoveredNPI;
                stats.npiDiscovered++;
              }
            }
            
            this.db.addCandidate(candidate);
            stats.newCandidates++;
          }
          
          stats.processed++;
        } catch (error) {
          console.error(`[DataSyncService] Error processing candidate:`, error.message);
          stats.errors.push({ type: 'candidate', data: loxoCandidate, error: error.message });
        }
      }

      // Step 2: Process submissions
      console.log(`[DataSyncService] Processing ${loxoData.submissions.length} submissions...`);

      for (const submission of loxoData.submissions) {
        try {
          // Find the candidate in our database
          const candidate = this.findCandidateByLoxoId(submission.loxo_candidate_id);
          
          if (!candidate) {
            console.log(`[DataSyncService] Candidate not found for submission: ${submission.loxo_candidate_id}`);
            continue;
          }

          // Check if this submission already exists
          const existingSubmission = this.findExistingSubmission(candidate.id, submission.client_name);
          
          if (!existingSubmission) {
            this.db.addSubmission({
              candidate_id: candidate.id,
              client_name: submission.client_name,
              job_title: submission.job_title,
              submitted_date: this.formatDate(submission.submitted_date),
              status: 'tracking'
            });
            stats.newSubmissions++;
          }
        } catch (error) {
          console.error(`[DataSyncService] Error processing submission:`, error.message);
          stats.errors.push({ type: 'submission', data: submission, error: error.message });
        }
      }

      this.lastSyncTime = new Date();
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      
      console.log(`[DataSyncService] Sync completed in ${duration}s`);
      console.log(`[DataSyncService] Stats: ${JSON.stringify(stats)}`);

      return {
        success: true,
        duration: `${duration}s`,
        ...stats
      };

    } catch (error) {
      console.error('[DataSyncService] Sync failed:', error.message);
      return {
        success: false,
        error: error.message,
        ...stats
      };
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Discover NPI number for a candidate by searching their name
   * Only returns high-confidence matches
   */
  async discoverNPIForCandidate(candidate) {
    if (!candidate.full_name) return null;

    try {
      console.log(`  [NPI Discovery] Searching for: ${candidate.full_name}`);
      const providers = await this.npi.searchByName(candidate.full_name);
      
      // Only use very high confidence matches to avoid false positives
      if (providers.length > 0 && providers[0].matchScore >= 0.9) {
        console.log(`    Found NPI: ${providers[0].npi} (confidence: ${providers[0].matchScore.toFixed(2)})`);
        return providers[0].npi;
      }
      
      return null;
    } catch (error) {
      console.warn(`  [NPI Discovery] Error for ${candidate.full_name}:`, error.message);
      return null;
    }
  }

  /**
   * Backfill NPI numbers for all candidates without one
   * Can be called manually via API endpoint
   */
  async backfillNPINumbers() {
    const candidates = this.db.getAllCandidates().filter(c => !c.npi_number);
    console.log(`[NPI Backfill] Processing ${candidates.length} candidates without NPI...`);
    
    let found = 0;
    let checked = 0;

    for (const candidate of candidates) {
      checked++;
      const npi = await this.discoverNPIForCandidate(candidate);
      
      if (npi) {
        this.db.updateCandidate(candidate.id, { npi_number: npi });
        found++;
      }
      
      // Progress indicator
      if (checked % 10 === 0) {
        console.log(`  Progress: ${checked}/${candidates.length} checked, ${found} found`);
      }
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 400));
    }

    console.log(`[NPI Backfill] Complete: ${found}/${checked} NPIs discovered`);
    return { checked, found };
  }

  /**
   * Find existing candidate by Loxo ID or email
   */
  findExistingCandidate(candidate) {
    const candidates = this.db.getAllCandidates();
    
    // First try to match by Loxo ID
    if (candidate.loxo_id) {
      const byLoxoId = candidates.find(c => c.loxo_id === candidate.loxo_id);
      if (byLoxoId) return byLoxoId;
    }
    
    // Then try to match by email
    if (candidate.email) {
      const byEmail = candidates.find(c => 
        c.email && c.email.toLowerCase() === candidate.email.toLowerCase()
      );
      if (byEmail) return byEmail;
    }
    
    // Finally try to match by name (fuzzy)
    if (candidate.full_name) {
      const byName = candidates.find(c => 
        this.normalizeString(c.full_name) === this.normalizeString(candidate.full_name)
      );
      if (byName) return byName;
    }
    
    return null;
  }

  /**
   * Find candidate by Loxo ID
   */
  findCandidateByLoxoId(loxoId) {
    if (!loxoId) return null;
    const candidates = this.db.getAllCandidates();
    return candidates.find(c => c.loxo_id === loxoId.toString());
  }

  /**
   * Find existing submission
   */
  findExistingSubmission(candidateId, clientName) {
    const submissions = this.db.getAllSubmissions();
    return submissions.find(s => 
      s.candidate_id === candidateId && 
      this.normalizeString(s.client_name) === this.normalizeString(clientName)
    );
  }

  /**
   * Update existing candidate
   */
  updateCandidate(candidateId, newData) {
    const candidate = this.db.getCandidate(candidateId);
    if (!candidate) return;

    const updated = { ...candidate };
    
    for (const [key, value] of Object.entries(newData)) {
      if (value && value !== '' && key !== 'id') {
        updated[key] = value;
      }
    }
    
    updated.updated_at = new Date().toISOString();
    
    if (this.db.updateCandidate) {
      this.db.updateCandidate(candidateId, updated);
    }
  }

  /**
   * Normalize string for comparison
   */
  normalizeString(str) {
    if (!str) return '';
    return str.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Format date to YYYY-MM-DD
   */
  formatDate(dateStr) {
    if (!dateStr) {
      return new Date().toISOString().split('T')[0];
    }
    
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        return new Date().toISOString().split('T')[0];
      }
      return date.toISOString().split('T')[0];
    } catch {
      return new Date().toISOString().split('T')[0];
    }
  }

  /**
   * Get sync status
   */
  getStatus() {
    return {
      inProgress: this.syncInProgress,
      lastSync: this.lastSyncTime ? this.lastSyncTime.toISOString() : null
    };
  }
}

module.exports = DataSyncService;
