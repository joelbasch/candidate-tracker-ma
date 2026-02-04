/**
 * Monitoring Scheduler
 * Checks candidates against NPI registry and creates alerts for matches
 * Matches based on: employer name, parent/subsidiary, AND location
 */

const CompanyResearchService = require('./companyResearchService');

class MonitoringScheduler {
  constructor(db, npiService, linkedinService, socialMediaService) {
    this.db = db;
    this.npi = npiService;
    this.linkedin = linkedinService;
    this.socialMedia = socialMediaService;
    this.companyResearch = new CompanyResearchService();
    this.isRunning = false;
  }

  /**
   * Extract city and state from a job title or location string
   * e.g., "Optometrist - Full Time - Rockford, IL" -> { city: "rockford", state: "il" }
   */
  extractLocation(text) {
    if (!text) return { city: null, state: null };
    
    const normalized = text.toLowerCase();
    
    // Common state abbreviations
    const states = {
      'al': 'alabama', 'ak': 'alaska', 'az': 'arizona', 'ar': 'arkansas', 'ca': 'california',
      'co': 'colorado', 'ct': 'connecticut', 'de': 'delaware', 'fl': 'florida', 'ga': 'georgia',
      'hi': 'hawaii', 'id': 'idaho', 'il': 'illinois', 'in': 'indiana', 'ia': 'iowa',
      'ks': 'kansas', 'ky': 'kentucky', 'la': 'louisiana', 'me': 'maine', 'md': 'maryland',
      'ma': 'massachusetts', 'mi': 'michigan', 'mn': 'minnesota', 'ms': 'mississippi', 'mo': 'missouri',
      'mt': 'montana', 'ne': 'nebraska', 'nv': 'nevada', 'nh': 'new hampshire', 'nj': 'new jersey',
      'nm': 'new mexico', 'ny': 'new york', 'nc': 'north carolina', 'nd': 'north dakota', 'oh': 'ohio',
      'ok': 'oklahoma', 'or': 'oregon', 'pa': 'pennsylvania', 'ri': 'rhode island', 'sc': 'south carolina',
      'sd': 'south dakota', 'tn': 'tennessee', 'tx': 'texas', 'ut': 'utah', 'vt': 'vermont',
      'va': 'virginia', 'wa': 'washington', 'wv': 'west virginia', 'wi': 'wisconsin', 'wy': 'wyoming',
      'dc': 'district of columbia'
    };

    let city = null;
    let state = null;

    // Try to find "City, ST" pattern
    const cityStatePattern = /([a-z\s]+),\s*([a-z]{2})\b/gi;
    const matches = [...normalized.matchAll(cityStatePattern)];
    
    if (matches.length > 0) {
      // Take the last match (usually the actual location, not part of company name)
      const lastMatch = matches[matches.length - 1];
      city = lastMatch[1].trim();
      state = lastMatch[2].trim();
    }

    // Also check for full state names
    for (const [abbrev, fullName] of Object.entries(states)) {
      if (normalized.includes(fullName)) {
        state = abbrev;
        break;
      }
    }

    return { city, state };
  }

  /**
   * Check if two locations match
   */
  locationsMatch(loc1, loc2) {
    if (!loc1 || !loc2) return { match: false };
    
    const city1 = (loc1.city || '').toLowerCase().trim();
    const state1 = (loc1.state || '').toLowerCase().trim();
    const city2 = (loc2.city || '').toLowerCase().trim();
    const state2 = (loc2.state || '').toLowerCase().trim();

    // Must have at least state to compare
    if (!state1 || !state2) return { match: false };

    // State must match
    if (state1 !== state2) return { match: false };

    // If we have cities, check if they match or are close
    if (city1 && city2) {
      // Exact city match
      if (city1 === city2) {
        return { match: true, reason: `Same city: ${city1}, ${state1.toUpperCase()}` };
      }
      
      // One contains the other (for cases like "Kansas City" vs "Kansas City Metro")
      if (city1.includes(city2) || city2.includes(city1)) {
        return { match: true, reason: `City match: ${city1} / ${city2}, ${state1.toUpperCase()}` };
      }
      
      // Cities are different but same state - lower confidence
      return { match: true, reason: `Same state (${state1.toUpperCase()}), different city: ${city1} vs ${city2}`, confidence: 'Medium' };
    }

    // Only state matches
    return { match: true, reason: `Same state: ${state1.toUpperCase()}`, confidence: 'Low' };
  }

  async runMonitoring() {
    if (this.isRunning) {
      return { checked: 0, alertsCreated: 0, message: 'Already running' };
    }

    this.isRunning = true;
    const results = {
      checked: 0,
      npiUpdated: 0,
      alertsCreated: 0,
      pipelineAlerts: 0,
      npiAlerts: 0
    };

    try {
      const candidates = this.db.data.candidates || [];
      const submissions = this.db.data.submissions || [];

      console.log(`\n========== Starting Monitoring ==========`);
      console.log(`Total candidates: ${candidates.length}`);
      console.log(`Total submissions: ${submissions.length}`);

      // First, create alerts for Hired and Negotiation candidates (from CRM pipeline)
      console.log(`\n--- Checking Pipeline Stages for Alerts ---`);
      
      for (const submission of submissions) {
        const stage = (submission.pipeline_stage || '').toLowerCase();
        const candidate = candidates.find(c => c.id === submission.candidate_id);
        
        if (!candidate) continue;

        const isHired = stage.includes('hired') || stage.includes('placed') || stage.includes('started');
        const isNegotiation = stage.includes('negotiation') || stage.includes('offer');
        
        if (isHired || isNegotiation) {
          const existingAlert = (this.db.data.alerts || []).find(a => 
            a.candidate_id === candidate.id && 
            a.client_name === submission.client_name &&
            a.source?.includes('Pipeline')
          );

          if (!existingAlert) {
            const alertType = isHired ? 'HIRED' : 'NEGOTIATION';
            console.log(`  🚨 Creating ${alertType} alert: ${candidate.full_name} → ${submission.client_name}`);
            
            const alert = {
              id: Date.now() + Math.random(),
              candidate_id: candidate.id,
              candidate_name: candidate.full_name,
              client_name: submission.client_name,
              source: `Pipeline: ${submission.pipeline_stage}`,
              confidence: isHired ? 'Confirmed' : 'High',
              match_details: isHired 
                ? `${candidate.full_name} was HIRED at ${submission.client_name} - ${submission.job_title}`
                : `${candidate.full_name} is in NEGOTIATION with ${submission.client_name} - ${submission.job_title}`,
              status: 'pending',
              created_at: new Date().toISOString()
            };

            if (!this.db.data.alerts) this.db.data.alerts = [];
            this.db.data.alerts.push(alert);
            results.alertsCreated++;
            results.pipelineAlerts++;
          }
        }
      }

      if (results.pipelineAlerts > 0) {
        this.db.saveDatabase();
        console.log(`  Created ${results.pipelineAlerts} pipeline alerts`);
      }

      // Now check NPI registry for each candidate
      console.log(`\n--- Checking NPI Registry (Location + Employer Matching) ---`);
      
      for (const candidate of candidates) {
        results.checked++;
        
        const candidateSubmissions = submissions.filter(s => s.candidate_id === candidate.id);
        
        if (candidateSubmissions.length === 0) {
          continue;
        }

        try {
          const npiResults = await this.npi.searchByName(candidate.full_name);

          if (!npiResults || npiResults.length === 0) {
            continue;
          }

          // Look for optometrist/ophthalmologist matches first
          const relevantProvider = npiResults.find(r => {
            const desc = (r.taxonomy?.description || '').toLowerCase();
            return desc.includes('optometr') || desc.includes('ophthalm') || desc.includes('optic');
          }) || npiResults[0];

          if (relevantProvider) {
            // Update candidate's NPI if not set
            if (!candidate.npi_number && relevantProvider.npi) {
              candidate.npi_number = relevantProvider.npi;
              candidate.npi_last_checked = new Date().toISOString();
              results.npiUpdated++;
              this.db.saveDatabase();
            }

            // Get NPI location
            const npiAddress = relevantProvider.practiceAddress || {};
            const npiLocation = {
              city: (npiAddress.city || '').toLowerCase(),
              state: (npiAddress.state || '').toLowerCase()
            };
            const employerName = relevantProvider.organizationName || '';

            // Check each submission for matches
            for (const submission of candidateSubmissions) {
              const clientName = submission.client_name || '';
              const jobTitle = submission.job_title || '';
              
              // Extract location from job title
              const jobLocation = this.extractLocation(jobTitle);
              
              // Also try to extract from client name
              const clientLocation = this.extractLocation(clientName);
              
              // Check for employer name match
              const employerMatch = this.companyResearch.areCompaniesRelated(employerName, clientName);
              
              // Check for location match
              const locationMatchJob = this.locationsMatch(npiLocation, jobLocation);
              const locationMatchClient = this.locationsMatch(npiLocation, clientLocation);
              const locationMatch = locationMatchJob.match ? locationMatchJob : locationMatchClient;

              // Create alert if employer matches OR location matches
              if (employerMatch.match || locationMatch.match) {
                const existingAlert = (this.db.data.alerts || []).find(a =>
                  a.candidate_id === candidate.id &&
                  a.client_name === submission.client_name &&
                  a.source?.includes('NPI')
                );

                if (!existingAlert) {
                  let matchReason = '';
                  let confidence = 'Medium';
                  
                  if (employerMatch.match && locationMatch.match) {
                    matchReason = `Employer AND Location match! NPI shows ${relevantProvider.fullName} at "${employerName}" in ${npiLocation.city}, ${npiLocation.state.toUpperCase()}`;
                    confidence = 'High';
                  } else if (employerMatch.match) {
                    matchReason = `Employer match: ${employerMatch.reason}`;
                    confidence = 'High';
                  } else if (locationMatch.match) {
                    matchReason = `Location match: NPI shows practice in ${npiLocation.city}, ${npiLocation.state.toUpperCase()}. ${locationMatch.reason}`;
                    confidence = locationMatch.confidence || 'Medium';
                  }

                  console.log(`  🚨 NPI MATCH: ${candidate.full_name}`);
                  console.log(`      NPI: ${relevantProvider.npi} - ${npiLocation.city}, ${npiLocation.state.toUpperCase()}`);
                  console.log(`      Job: ${jobTitle}`);
                  console.log(`      Reason: ${matchReason}`);
                  
                  const alert = {
                    id: Date.now() + Math.random(),
                    candidate_id: candidate.id,
                    candidate_name: candidate.full_name,
                    client_name: submission.client_name,
                    source: 'NPI Registry',
                    confidence: confidence,
                    match_details: `NPI ${relevantProvider.npi} shows ${relevantProvider.fullName} practicing in ${npiLocation.city || 'Unknown'}, ${(npiLocation.state || 'Unknown').toUpperCase()}. ${matchReason}`,
                    npi_number: relevantProvider.npi,
                    npi_location: `${npiLocation.city}, ${npiLocation.state}`.toUpperCase(),
                    status: 'pending',
                    created_at: new Date().toISOString()
                  };

                  if (!this.db.data.alerts) this.db.data.alerts = [];
                  this.db.data.alerts.push(alert);
                  results.alertsCreated++;
                  results.npiAlerts++;
                  this.db.saveDatabase();
                }
              }
            }
          }
        } catch (error) {
          console.log(`  Error checking NPI for ${candidate.full_name}: ${error.message}`);
        }

        // Small delay to avoid overwhelming the NPI API
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log(`\n========== Monitoring Complete ==========`);
      console.log(`Candidates checked: ${results.checked}`);
      console.log(`NPI numbers updated: ${results.npiUpdated}`);
      console.log(`Pipeline alerts created: ${results.pipelineAlerts}`);
      console.log(`NPI location/employer alerts created: ${results.npiAlerts}`);
      console.log(`Total alerts created: ${results.alertsCreated}`);
      console.log(`=========================================\n`);

    } catch (error) {
      console.error('Monitoring error:', error);
    } finally {
      this.isRunning = false;
    }

    return results;
  }

  addCompanyRelationship(parentCompany, subsidiaryOrAlias) {
    this.companyResearch.addRelationship(parentCompany, subsidiaryOrAlias);
    console.log(`Added relationship: ${parentCompany} → ${subsidiaryOrAlias}`);
  }

  getCompanyRelationships() {
    return this.companyResearch.getAllRelationships();
  }

  startSchedule(intervalMinutes = 60) {
    console.log(`Starting monitoring schedule: every ${intervalMinutes} minutes`);
    this.scheduleInterval = setInterval(() => {
      this.runMonitoring();
    }, intervalMinutes * 60 * 1000);
  }

  stopSchedule() {
    if (this.scheduleInterval) {
      clearInterval(this.scheduleInterval);
      console.log('Monitoring schedule stopped');
    }
  }
}

module.exports = MonitoringScheduler;
