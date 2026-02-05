/**
 * Monitoring Scheduler - COMPREHENSIVE VERSION
 * Eye to Eye Careers - Candidate Placement Tracker
 *
 * INDEPENDENT ALERT SOURCES:
 * 1. NPI Registry (NPPES + CMS Medicare) - Primary source for practice locations
 * 2. LinkedIn - Professional profiles (US + Optometrist filtered)
 * 3. Doximity - Medical professional network
 * 4. Healthgrades - Healthcare provider directory
 * 5. Google Search - General web presence
 *
 * Each source generates INDEPENDENT alerts that appear in separate tabs in the UI
 */

const CompanyResearchService = require('./companyResearchService');
const GoogleSearchService = require('./googleSearchService');
const DoximityService = require('./doximityService');
const HealthgradesService = require('./healthgradesService');

class MonitoringScheduler {
  constructor(db, npiService, linkedinService, socialMediaService) {
    this.db = db;
    this.npi = npiService;
    this.linkedin = linkedinService;
    this.socialMedia = socialMediaService;
    this.companyResearch = new CompanyResearchService();
    this.googleSearch = new GoogleSearchService();
    this.doximity = new DoximityService();
    this.healthgrades = new HealthgradesService();
    this.isRunning = false;
  }

  /**
   * Extract city and state from a job title or location string
   */
  extractLocation(text) {
    if (!text) return { city: null, state: null };

    const normalized = text.toLowerCase();

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

    const cityStatePattern = /([a-z\s]+),\s*([a-z]{2})\b/gi;
    const matches = [...normalized.matchAll(cityStatePattern)];

    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      city = lastMatch[1].trim();
      state = lastMatch[2].trim();
    }

    for (const [abbrev, fullName] of Object.entries(states)) {
      if (normalized.includes(fullName)) {
        state = abbrev;
        break;
      }
    }

    return { city, state };
  }

  /**
   * Main monitoring workflow - runs all independent checks
   */
  async runMonitoring() {
    if (this.isRunning) {
      return { checked: 0, alertsCreated: 0, message: 'Already running' };
    }

    this.isRunning = true;
    const results = {
      checked: 0,
      alertsCreated: 0,
      bySource: {
        pipeline: 0,
        npi: 0,
        linkedin: 0,
        doximity: 0,
        healthgrades: 0,
        google: 0
      }
    };

    try {
      const candidates = this.db.data.candidates || [];
      const submissions = this.db.data.submissions || [];

      console.log(`\n${'='.repeat(70)}`);
      console.log(`  COMPREHENSIVE MONITORING - ${new Date().toLocaleString()}`);
      console.log(`${'='.repeat(70)}`);
      console.log(`Total candidates: ${candidates.length}`);
      console.log(`Total submissions: ${submissions.length}`);

      // =========================================
      // PHASE 1: Pipeline Stage Alerts
      // =========================================
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`  PHASE 1: Pipeline Stage Alerts`);
      console.log(`${'─'.repeat(70)}`);

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
            a.source === 'Pipeline'
          );

          if (!existingAlert) {
            const alertType = isHired ? 'HIRED' : 'NEGOTIATION';
            console.log(`  🚨 ${alertType}: ${candidate.full_name} → ${submission.client_name}`);

            this.createAlert({
              candidate_id: candidate.id,
              candidate_name: candidate.full_name,
              client_name: submission.client_name,
              source: 'Pipeline',
              confidence: isHired ? 'Confirmed' : 'High',
              match_details: isHired
                ? `${candidate.full_name} was HIRED at ${submission.client_name} - ${submission.job_title}`
                : `${candidate.full_name} is in NEGOTIATION with ${submission.client_name} - ${submission.job_title}`
            });

            results.alertsCreated++;
            results.bySource.pipeline++;
          }
        }
      }

      // =========================================
      // PHASE 2: NPI Registry (NPPES + CMS Medicare)
      // =========================================
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`  PHASE 2: NPI Registry (NPPES + CMS Medicare)`);
      console.log(`${'─'.repeat(70)}`);

      for (const candidate of candidates) {
        results.checked++;
        const candidateSubmissions = submissions.filter(s => s.candidate_id === candidate.id);

        if (candidateSubmissions.length === 0) continue;

        console.log(`\n  📋 ${candidate.full_name}`);

        for (const submission of candidateSubmissions) {
          const clientName = submission.client_name || '';

          // Check for existing NPI alert
          const existingAlert = (this.db.data.alerts || []).find(a =>
            a.candidate_id === candidate.id &&
            a.client_name === clientName &&
            a.source === 'NPI'
          );

          if (existingAlert) continue;

          try {
            const npiAlert = await this.npi.checkCandidateAtClient(candidate, submission, this.companyResearch);

            if (npiAlert) {
              console.log(`     🚨 NPI MATCH: ${npiAlert.employerFound} → ${clientName}`);

              this.createAlert({
                candidate_id: candidate.id,
                candidate_name: candidate.full_name,
                client_name: clientName,
                source: 'NPI',
                confidence: npiAlert.confidence,
                match_details: npiAlert.matchDetails,
                npi_number: npiAlert.npiNumber,
                npi_employer: npiAlert.employerFound,
                npi_address: npiAlert.address,
                npi_registry_url: npiAlert.links?.npiRegistry,
                cms_lookup_url: npiAlert.links?.cmsLookup,
                data_source: npiAlert.dataSource
              });

              results.alertsCreated++;
              results.bySource.npi++;

              // Update candidate NPI if found
              if (npiAlert.npiNumber && !candidate.npi_number) {
                candidate.npi_number = npiAlert.npiNumber;
                this.db.saveDatabase();
              }
            }
          } catch (error) {
            console.log(`     ⚠️ NPI error: ${error.message}`);
          }
        }

        await new Promise(resolve => setTimeout(resolve, 200));
      }

      // =========================================
      // PHASE 3: LinkedIn (US + Optometrist filtered)
      // =========================================
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`  PHASE 3: LinkedIn (US + Optometrist filtered)`);
      console.log(`${'─'.repeat(70)}`);

      if (this.linkedin && this.linkedin.configured) {
        for (const candidate of candidates) {
          const candidateSubmissions = submissions.filter(s => s.candidate_id === candidate.id);

          if (candidateSubmissions.length === 0) continue;

          console.log(`\n  💼 ${candidate.full_name}`);

          try {
            const linkedinProfile = await this.linkedin.findProfile(candidate.full_name);

            if (linkedinProfile && linkedinProfile.found) {
              console.log(`     ✅ Found: ${linkedinProfile.profileUrl}`);
              if (linkedinProfile.currentEmployer) {
                console.log(`     🏢 Employer: ${linkedinProfile.currentEmployer}`);
              }

              for (const submission of candidateSubmissions) {
                const clientName = submission.client_name || '';

                const existingAlert = (this.db.data.alerts || []).find(a =>
                  a.candidate_id === candidate.id &&
                  a.client_name === clientName &&
                  a.source === 'LinkedIn'
                );

                if (existingAlert) continue;

                const linkedinMatch = this.linkedin.checkProfileForClient(linkedinProfile, clientName, this.companyResearch);

                if (linkedinMatch && linkedinMatch.match) {
                  console.log(`     🚨 LINKEDIN MATCH: ${linkedinMatch.reason}`);

                  this.createAlert({
                    candidate_id: candidate.id,
                    candidate_name: candidate.full_name,
                    client_name: clientName,
                    source: 'LinkedIn',
                    confidence: linkedinMatch.confidence || 'Medium',
                    match_details: linkedinMatch.reason,
                    linkedin_url: linkedinProfile.profileUrl,
                    linkedin_employer: linkedinMatch.employer,
                    linkedin_title: linkedinMatch.title,
                    linkedin_location: linkedinProfile.usLocation
                  });

                  results.alertsCreated++;
                  results.bySource.linkedin++;
                }
              }
            }
          } catch (error) {
            console.log(`     ⚠️ LinkedIn error: ${error.message}`);
          }

          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } else {
        console.log(`  ⚠️ LinkedIn Service not configured (missing SERPER_API_KEY)`);
      }

      // =========================================
      // PHASE 4: Doximity
      // =========================================
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`  PHASE 4: Doximity`);
      console.log(`${'─'.repeat(70)}`);

      if (this.doximity && this.doximity.configured) {
        for (const candidate of candidates) {
          const candidateSubmissions = submissions.filter(s => s.candidate_id === candidate.id);

          if (candidateSubmissions.length === 0) continue;

          console.log(`\n  🏥 ${candidate.full_name}`);

          try {
            const doximityProfile = await this.doximity.findProfile(candidate.full_name);

            if (doximityProfile && doximityProfile.found) {
              console.log(`     ✅ Found: ${doximityProfile.profileUrl}`);

              for (const submission of candidateSubmissions) {
                const clientName = submission.client_name || '';

                const existingAlert = (this.db.data.alerts || []).find(a =>
                  a.candidate_id === candidate.id &&
                  a.client_name === clientName &&
                  a.source === 'Doximity'
                );

                if (existingAlert) continue;

                const doximityMatch = this.doximity.checkProfileForClient(doximityProfile, clientName, this.companyResearch);

                if (doximityMatch && doximityMatch.match) {
                  console.log(`     🚨 DOXIMITY MATCH: ${doximityMatch.reason}`);

                  this.createAlert({
                    candidate_id: candidate.id,
                    candidate_name: candidate.full_name,
                    client_name: clientName,
                    source: 'Doximity',
                    confidence: doximityMatch.confidence || 'Medium',
                    match_details: doximityMatch.reason,
                    doximity_url: doximityProfile.profileUrl,
                    doximity_employer: doximityMatch.employer
                  });

                  results.alertsCreated++;
                  results.bySource.doximity++;
                }
              }
            }
          } catch (error) {
            console.log(`     ⚠️ Doximity error: ${error.message}`);
          }

          await new Promise(resolve => setTimeout(resolve, 400));
        }
      } else {
        console.log(`  ⚠️ Doximity Service not configured (missing SERPER_API_KEY)`);
      }

      // =========================================
      // PHASE 5: Healthgrades
      // =========================================
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`  PHASE 5: Healthgrades`);
      console.log(`${'─'.repeat(70)}`);

      if (this.healthgrades && this.healthgrades.configured) {
        for (const candidate of candidates) {
          const candidateSubmissions = submissions.filter(s => s.candidate_id === candidate.id);

          if (candidateSubmissions.length === 0) continue;

          console.log(`\n  🩺 ${candidate.full_name}`);

          try {
            const healthgradesProfile = await this.healthgrades.findProfile(candidate.full_name);

            if (healthgradesProfile && healthgradesProfile.found) {
              console.log(`     ✅ Found: ${healthgradesProfile.profileUrl}`);

              for (const submission of candidateSubmissions) {
                const clientName = submission.client_name || '';

                const existingAlert = (this.db.data.alerts || []).find(a =>
                  a.candidate_id === candidate.id &&
                  a.client_name === clientName &&
                  a.source === 'Healthgrades'
                );

                if (existingAlert) continue;

                const healthgradesMatch = this.healthgrades.checkProfileForClient(healthgradesProfile, clientName, this.companyResearch);

                if (healthgradesMatch && healthgradesMatch.match) {
                  console.log(`     🚨 HEALTHGRADES MATCH: ${healthgradesMatch.reason}`);

                  this.createAlert({
                    candidate_id: candidate.id,
                    candidate_name: candidate.full_name,
                    client_name: clientName,
                    source: 'Healthgrades',
                    confidence: healthgradesMatch.confidence || 'Medium',
                    match_details: healthgradesMatch.reason,
                    healthgrades_url: healthgradesProfile.profileUrl,
                    healthgrades_practice: healthgradesMatch.practice
                  });

                  results.alertsCreated++;
                  results.bySource.healthgrades++;
                }
              }
            }
          } catch (error) {
            console.log(`     ⚠️ Healthgrades error: ${error.message}`);
          }

          await new Promise(resolve => setTimeout(resolve, 400));
        }
      } else {
        console.log(`  ⚠️ Healthgrades Service not configured (missing SERPER_API_KEY)`);
      }

      // =========================================
      // PHASE 6: Google Search
      // =========================================
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`  PHASE 6: Google Search`);
      console.log(`${'─'.repeat(70)}`);

      if (this.googleSearch && this.googleSearch.apiKey) {
        for (const candidate of candidates) {
          const candidateSubmissions = submissions.filter(s => s.candidate_id === candidate.id);

          if (candidateSubmissions.length === 0) continue;

          console.log(`\n  🌐 ${candidate.full_name}`);

          try {
            const searchResults = await this.googleSearch.searchCandidate(candidate.full_name);

            if (searchResults && searchResults.allResults && searchResults.allResults.length > 0) {
              console.log(`     ✅ Found ${searchResults.allResults.length} search results`);

              for (const submission of candidateSubmissions) {
                const clientName = submission.client_name || '';

                const existingAlert = (this.db.data.alerts || []).find(a =>
                  a.candidate_id === candidate.id &&
                  a.client_name === clientName &&
                  a.source === 'Google'
                );

                if (existingAlert) continue;

                const googleMatch = this.googleSearch.checkResultsForClient(searchResults, clientName, this.companyResearch);

                if (googleMatch && googleMatch.match) {
                  console.log(`     🚨 GOOGLE MATCH: ${googleMatch.reason}`);

                  this.createAlert({
                    candidate_id: candidate.id,
                    candidate_name: candidate.full_name,
                    client_name: clientName,
                    source: 'Google',
                    confidence: 'Medium',
                    match_details: googleMatch.reason,
                    google_source_url: googleMatch.sourceUrl
                  });

                  results.alertsCreated++;
                  results.bySource.google++;
                }
              }
            }
          } catch (error) {
            console.log(`     ⚠️ Google error: ${error.message}`);
          }

          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } else {
        console.log(`  ⚠️ Google Search Service not configured (missing SERPER_API_KEY)`);
      }

      // =========================================
      // Summary
      // =========================================
      console.log(`\n${'='.repeat(70)}`);
      console.log(`  MONITORING COMPLETE`);
      console.log(`${'='.repeat(70)}`);
      console.log(`  Candidates checked: ${results.checked}`);
      console.log(`  Total alerts created: ${results.alertsCreated}`);
      console.log(`  By Source:`);
      console.log(`    - Pipeline: ${results.bySource.pipeline}`);
      console.log(`    - NPI: ${results.bySource.npi}`);
      console.log(`    - LinkedIn: ${results.bySource.linkedin}`);
      console.log(`    - Doximity: ${results.bySource.doximity}`);
      console.log(`    - Healthgrades: ${results.bySource.healthgrades}`);
      console.log(`    - Google: ${results.bySource.google}`);
      console.log(`${'='.repeat(70)}\n`);

    } catch (error) {
      console.error('Monitoring error:', error);
    } finally {
      this.isRunning = false;
    }

    return results;
  }

  /**
   * Create and save an alert
   */
  createAlert(alertData) {
    const alert = {
      id: Date.now() + Math.random(),
      ...alertData,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    if (!this.db.data.alerts) this.db.data.alerts = [];
    this.db.data.alerts.push(alert);
    this.db.saveDatabase();

    return alert;
  }

  /**
   * Get alerts grouped by source
   */
  getAlertsBySource() {
    const alerts = this.db.data.alerts || [];
    const grouped = {
      all: alerts,
      pipeline: alerts.filter(a => a.source === 'Pipeline'),
      npi: alerts.filter(a => a.source === 'NPI'),
      linkedin: alerts.filter(a => a.source === 'LinkedIn'),
      doximity: alerts.filter(a => a.source === 'Doximity'),
      healthgrades: alerts.filter(a => a.source === 'Healthgrades'),
      google: alerts.filter(a => a.source === 'Google')
    };
    return grouped;
  }

  /**
   * Add a company relationship
   */
  addCompanyRelationship(parentCompany, subsidiaryOrAlias) {
    this.companyResearch.addRelationship(parentCompany, subsidiaryOrAlias);
    console.log(`Added relationship: ${parentCompany} → ${subsidiaryOrAlias}`);
  }

  /**
   * Get all company relationships
   */
  getCompanyRelationships() {
    return this.companyResearch.getAllRelationships();
  }

  /**
   * Start scheduled monitoring
   */
  startSchedule(intervalMinutes = 60) {
    console.log(`Starting monitoring schedule: every ${intervalMinutes} minutes`);
    this.scheduleInterval = setInterval(() => {
      this.runMonitoring();
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Stop scheduled monitoring
   */
  stopSchedule() {
    if (this.scheduleInterval) {
      clearInterval(this.scheduleInterval);
      console.log('Monitoring schedule stopped');
    }
  }
}

module.exports = MonitoringScheduler;
