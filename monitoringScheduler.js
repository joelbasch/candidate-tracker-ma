/**
 * Monitoring Scheduler
 * Multi-phase monitoring: Pipeline → NPI → LinkedIn → Google Search
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
      
      // Cities are different but same state - lower confidence
      return { match: true, reason: `Same state (${state1.toUpperCase()}), different city: ${city1} vs ${city2}`, confidence: 'Medium' };
    }

    // Only state matches
    return { match: true, reason: `Same state: ${state1.toUpperCase()}`, confidence: 'Low' };
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
      console.log(`  PHASE 1: Pipeline Alerts`);
      console.log(`══════════════════════════════════════════════════════════════════\n`);

      for (const { candidate, submission, isHired } of hiredCandidates) {
        if (!this.alertExists(candidate.id, submission.client_name, 'Pipeline')) {
          const alertType = isHired ? 'HIRED' : 'NEGOTIATION';
          console.log(`  🚨 ${alertType}: ${candidate.full_name} → ${submission.client_name}`);

          this.createAlert({
            candidate_id: candidate.id,
            candidate_name: candidate.full_name,
            client_name: submission.client_name,
            source: `Pipeline: ${submission.pipeline_stage}`,
            confidence: isHired ? 'Confirmed' : 'High',
            match_details: isHired
              ? `${candidate.full_name} was HIRED at ${submission.client_name} - ${submission.job_title}`
              : `${candidate.full_name} is in NEGOTIATION with ${submission.client_name} - ${submission.job_title}`
          });
          results.alertsCreated++;
          results.pipelineAlerts++;
        }
      }

      console.log(`\n══════════════════════════════════════════════════════════════════`);
      console.log(`  PHASE 2: NPI Registry`);
      console.log(`══════════════════════════════════════════════════════════════════\n`);

      for (const { candidate, submission } of hiredCandidates) {
        results.checked++;
        const clientName = submission.client_name || '';
        const jobTitle = submission.job_title || '';

        try {
          console.log(`\n  📋 ${candidate.full_name}`);
          const npiResults = await this.npi.searchByName(candidate.full_name);

          if (!npiResults || npiResults.length === 0) {
            console.log(`    No NPI records found for ${candidate.full_name}`);
            continue;
          }

          const relevantProvider = npiResults.find(r => {
            const desc = (r.taxonomy?.description || '').toLowerCase();
            return desc.includes('optometr') || desc.includes('ophthalm') || desc.includes('optic');
          }) || npiResults[0];

          if (!relevantProvider) continue;

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

          // Check for employer name match
          const employerMatch = this.companyResearch.areCompaniesRelated(employerName, clientName);

          // Check for location match
          const jobLocation = this.extractLocation(jobTitle);
          const clientLocation = this.extractLocation(clientName);
          const locationMatchJob = this.locationsMatch(npiLocation, jobLocation);
          const locationMatchClient = this.locationsMatch(npiLocation, clientLocation);
          const locationMatch = locationMatchJob.match ? locationMatchJob : locationMatchClient;

          if (employerMatch.match || locationMatch.match) {
            if (!this.alertExists(candidate.id, clientName, 'NPI')) {
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
            }
          } else {
            console.log(`    No employer match found for ${candidate.full_name}`);
          }
        } catch (error) {
          console.log(`    Error checking NPI for ${candidate.full_name}: ${error.message}`);
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // PHASE 3: LinkedIn
      if (this.linkedin && this.linkedin.configured) {
        console.log(`\n══════════════════════════════════════════════════════════════════`);
        console.log(`  PHASE 3: LinkedIn`);
        console.log(`══════════════════════════════════════════════════════════════════\n`);

        for (const { candidate, submission } of hiredCandidates) {
          const clientName = submission.client_name || '';

          // Skip if LinkedIn alert already exists for this candidate+client
          if (this.alertExists(candidate.id, clientName, 'LinkedIn')) continue;

          try {
            console.log(`\n  💼 ${candidate.full_name}`);
            const profileData = await this.linkedin.findProfile(candidate.full_name);

            if (profileData && profileData.found) {
              // Update candidate's LinkedIn URL if not set
              if (!candidate.linkedin_url && profileData.profileUrl) {
                candidate.linkedin_url = profileData.profileUrl;
                this.db.saveDatabase();
              }

              // Check if profile mentions the client company
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
              }
            }
          } catch (error) {
            console.log(`    Error checking LinkedIn for ${candidate.full_name}: ${error.message}`);
          }

          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // PHASE 4: Google Search
      if (this.googleSearch && this.googleSearch.apiKey) {
        console.log(`\n══════════════════════════════════════════════════════════════════`);
        console.log(`  PHASE 4: Google Search`);
        console.log(`══════════════════════════════════════════════════════════════════\n`);

        for (const { candidate, submission } of hiredCandidates) {
          const clientName = submission.client_name || '';

          // Skip if Google Search alert already exists for this candidate+client
          if (this.alertExists(candidate.id, clientName, 'Google Search')) continue;

          try {
            console.log(`\n  🌐 ${candidate.full_name}`);
            const searchResults = await this.googleSearch.searchCandidate(candidate.full_name);

            if (searchResults && searchResults.allResults && searchResults.allResults.length > 0) {
              console.log(`     ✅ Found ${searchResults.allResults.length} search results`);

              const clientMatch = this.googleSearch.checkResultsForClient(searchResults, clientName, this.companyResearch);

              if (clientMatch && clientMatch.match) {
                console.log(`     🚨 GOOGLE MATCH: ${clientMatch.reason}`);

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
              }
            }
          } catch (error) {
            console.log(`    Error checking Google for ${candidate.full_name}: ${error.message}`);
          }

          await new Promise(resolve => setTimeout(resolve, 500));
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
