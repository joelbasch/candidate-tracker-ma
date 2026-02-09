/**
 * Monitoring Scheduler
 * Per-candidate monitoring: each candidate gets all sources checked before moving to next
 * Sources: Pipeline → NPI → LinkedIn → Google Search
 * Creates alerts with proper source labels for frontend categorization
 */

const CompanyResearchService = require('./companyResearchService');
const GoogleSearchService = require('./googleSearchService');

class MonitoringScheduler {
  constructor(db, npiService, linkedinService, socialMediaService) {
    this.db = db;
    this.npi = npiService;
    this.linkedin = linkedinService;
    this.socialMedia = socialMediaService;
    this.companyResearch = new CompanyResearchService();
    this.googleSearch = new GoogleSearchService();
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
      
      // Cities are different - NOT a match
      return { match: false };
    }

    // Only state, no city to compare - NOT a match
    return { match: false };
  }

  /**
   * Check if an alert already exists for this candidate + client + source
   */
  alertExists(candidateId, clientName, sourceKey) {
    return (this.db.data.alerts || []).find(a =>
      a.candidate_id === candidateId &&
      a.client_name === clientName &&
      a.source?.includes(sourceKey)
    );
  }

  /**
   * Create and save an alert
   */
  createAlert(alertData) {
    if (!this.db.data.alerts) this.db.data.alerts = [];
    const alert = {
      id: Date.now() + Math.random(),
      status: 'pending',
      created_at: new Date().toISOString(),
      ...alertData
    };
    this.db.data.alerts.push(alert);
    this.db.saveDatabase();
    return alert;
  }

  /**
   * Check a single candidate through all sources: Pipeline → NPI → LinkedIn → Google
   * Returns per-candidate results
   */
  async checkCandidate(candidate, submission, isHired, results) {
    const clientName = submission.client_name || '';
    const jobTitle = submission.job_title || '';
    const candidateResults = { pipeline: false, npi: false, linkedin: false, google: false };

    // --- Pipeline ---
    if (!this.alertExists(candidate.id, clientName, 'Pipeline')) {
      const alertType = isHired ? 'HIRED' : 'NEGOTIATION';
      console.log(`    📌 Pipeline: ${alertType}`);

      this.createAlert({
        candidate_id: candidate.id,
        candidate_name: candidate.full_name,
        client_name: clientName,
        source: `Pipeline: ${submission.pipeline_stage}`,
        confidence: isHired ? 'Confirmed' : 'High',
        match_details: isHired
          ? `${candidate.full_name} was HIRED at ${clientName} - ${jobTitle}`
          : `${candidate.full_name} is in NEGOTIATION with ${clientName} - ${jobTitle}`
      });
      results.alertsCreated++;
      results.pipelineAlerts++;
      candidateResults.pipeline = true;
    }

    // --- NPI Registry ---
    try {
      const npiResults = await this.npi.searchByName(candidate.full_name);

      if (npiResults && npiResults.length > 0) {
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

          const npiAddress = relevantProvider.practiceAddress || {};
          const npiLocation = {
            city: (npiAddress.city || '').toLowerCase(),
            state: (npiAddress.state || '').toLowerCase()
          };
          const employerName = relevantProvider.organizationName || '';

          const employerMatch = this.companyResearch.areCompaniesRelated(employerName, clientName);
          const jobLocation = this.extractLocation(jobTitle);
          const clientLocation = this.extractLocation(clientName);
          const locationMatchJob = this.locationsMatch(npiLocation, jobLocation);
          const locationMatchClient = this.locationsMatch(npiLocation, clientLocation);
          const locationMatch = locationMatchJob.match ? locationMatchJob : locationMatchClient;

          // Only alert if employer name matches (location alone is not enough)
          if (employerMatch.match && !this.alertExists(candidate.id, clientName, 'NPI')) {
            let matchReason = '';
            let confidence = 'Medium';

            if (employerMatch.match && locationMatch.match) {
              matchReason = `Employer AND Location match! NPI shows ${relevantProvider.fullName} at "${employerName}" in ${npiLocation.city}, ${npiLocation.state.toUpperCase()}`;
              confidence = 'High';
            } else {
              matchReason = `Employer match: ${employerMatch.reason}`;
              confidence = 'High';
            }

            console.log(`    🚨 NPI MATCH: ${employerName} → ${clientName}`);

            this.createAlert({
              candidate_id: candidate.id,
              candidate_name: candidate.full_name,
              client_name: clientName,
              source: 'NPI Registry',
              confidence: confidence,
              match_details: `NPI ${relevantProvider.npi} shows ${relevantProvider.fullName} practicing in ${npiLocation.city || 'Unknown'}, ${(npiLocation.state || 'Unknown').toUpperCase()}. ${matchReason}`,
              npi_number: relevantProvider.npi,
              npi_location: `${npiLocation.city}, ${npiLocation.state}`.toUpperCase()
            });
            results.alertsCreated++;
            results.npiAlerts++;
            candidateResults.npi = true;
          } else {
            console.log(`    ℹ️ NPI: No employer match`);
          }
        }
      } else {
        console.log(`    ℹ️ NPI: No records found`);
      }
    } catch (error) {
      console.log(`    ❌ NPI error: ${error.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 100));

    // --- LinkedIn ---
    if (this.linkedin && this.linkedin.configured && !this.alertExists(candidate.id, clientName, 'LinkedIn')) {
      try {
        const profileData = await this.linkedin.findProfile(candidate.full_name);

        if (profileData && profileData.found) {
          if (!candidate.linkedin_url && profileData.profileUrl) {
            candidate.linkedin_url = profileData.profileUrl;
            this.db.saveDatabase();
          }

          const clientMatch = this.linkedin.checkProfileForClient(profileData, clientName, this.companyResearch);

          if (clientMatch && clientMatch.match) {
            console.log(`    🚨 LINKEDIN MATCH: ${clientMatch.reason}`);

            this.createAlert({
              candidate_id: candidate.id,
              candidate_name: candidate.full_name,
              client_name: clientName,
              source: 'LinkedIn',
              confidence: clientMatch.confidence || 'Medium',
              match_details: clientMatch.reason,
              linkedin_url: profileData.profileUrl,
              linkedin_employer: clientMatch.employer || profileData.currentEmployer,
              linkedin_title: clientMatch.title || profileData.currentTitle
            });
            results.alertsCreated++;
            results.linkedinAlerts++;
            candidateResults.linkedin = true;
          } else {
            console.log(`    ℹ️ LinkedIn: ${profileData.found ? 'Profile found, no client match' : 'No profile found'}`);
          }
        } else {
          console.log(`    ℹ️ LinkedIn: ${profileData?.reason || 'No profile found'}`);
        }
      } catch (error) {
        console.log(`    ❌ LinkedIn error: ${error.message}`);
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // --- Google Search ---
    if (this.googleSearch && this.googleSearch.apiKey && !this.alertExists(candidate.id, clientName, 'Google Search')) {
      try {
        const searchResults = await this.googleSearch.searchCandidate(candidate.full_name);

        if (searchResults && searchResults.allResults && searchResults.allResults.length > 0) {
          const clientMatch = this.googleSearch.checkResultsForClient(searchResults, clientName, this.companyResearch);

          if (clientMatch && clientMatch.match) {
            console.log(`    🚨 GOOGLE MATCH: ${clientMatch.reason}`);

            this.createAlert({
              candidate_id: candidate.id,
              candidate_name: candidate.full_name,
              client_name: clientName,
              source: 'Google Search',
              confidence: 'Medium',
              match_details: clientMatch.reason,
              google_source_url: clientMatch.sourceUrl,
              google_matched_text: clientMatch.matchedText
            });
            results.alertsCreated++;
            results.googleAlerts++;
            candidateResults.google = true;
          } else {
            console.log(`    ℹ️ Google: No client match in results`);
          }
        } else {
          console.log(`    ℹ️ Google: No search results`);
        }
      } catch (error) {
        console.log(`    ❌ Google error: ${error.message}`);
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return candidateResults;
  }

  async runMonitoring() {
    if (this.isRunning) {
      return { checked: 0, alertsCreated: 0, skipped: true, message: 'Already running' };
    }

    this.isRunning = true;
    const results = {
      checked: 0,
      npiUpdated: 0,
      alertsCreated: 0,
      pipelineAlerts: 0,
      npiAlerts: 0,
      linkedinAlerts: 0,
      googleAlerts: 0
    };

    try {
      const candidates = this.db.data.candidates || [];
      const submissions = this.db.data.submissions || [];

      // Build list of HIRED/NEGOTIATION candidates with their submissions
      const hiredCandidates = [];
      for (const submission of submissions) {
        const stage = (submission.pipeline_stage || '').toLowerCase();
        const candidate = candidates.find(c => c.id === submission.candidate_id);
        if (!candidate) continue;

        const isHired = stage.includes('hired') || stage.includes('placed') || stage.includes('started');
        const isNegotiation = stage.includes('negotiation') || stage.includes('offer');

        if (isHired || isNegotiation) {
          hiredCandidates.push({ candidate, submission, isHired, isNegotiation });
        }
      }

      console.log(`\n══════════════════════════════════════════════════════════════════`);
      console.log(`  CANDIDATE MONITORING`);
      console.log(`  ${hiredCandidates.length} candidates to check (Pipeline → NPI → LinkedIn → Google)`);
      console.log(`══════════════════════════════════════════════════════════════════\n`);

      for (let i = 0; i < hiredCandidates.length; i++) {
        const { candidate, submission, isHired, isNegotiation } = hiredCandidates[i];
        results.checked++;

        console.log(`\n┌─────────────────────────────────────────────────────────────`);
        console.log(`│ [${i + 1}/${hiredCandidates.length}] ${candidate.full_name}`);
        console.log(`│ Client: ${submission.client_name} | Stage: ${submission.pipeline_stage}`);
        console.log(`└─────────────────────────────────────────────────────────────`);

        const candidateResults = await this.checkCandidate(candidate, submission, isHired, results);

        // Summary line for this candidate
        const sources = [];
        if (candidateResults.pipeline) sources.push('Pipeline');
        if (candidateResults.npi) sources.push('NPI');
        if (candidateResults.linkedin) sources.push('LinkedIn');
        if (candidateResults.google) sources.push('Google');

        if (sources.length > 0) {
          console.log(`    ✅ Alerts created: ${sources.join(', ')}`);
        } else {
          console.log(`    — No new alerts`);
        }
      }

      console.log(`\n══════════════════════════════════════════════════════════════════`);
      console.log(`  MONITORING COMPLETE`);
      console.log(`══════════════════════════════════════════════════════════════════`);
      console.log(`  Candidates checked: ${results.checked}`);
      console.log(`  Total alerts created: ${results.alertsCreated}`);
      console.log(`  By Source:`);
      console.log(`    - Pipeline: ${results.pipelineAlerts}`);
      console.log(`    - NPI: ${results.npiAlerts}`);
      console.log(`    - LinkedIn: ${results.linkedinAlerts}`);
      console.log(`    - Google: ${results.googleAlerts}`);
      console.log(`══════════════════════════════════════════════════════════════════\n`);

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
