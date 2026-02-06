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
   *
   * LOGIC:
   * - Pipeline Stage "Hired"/"Placed"/"Started" → Create CONFIRMED alert
   * - All other stages → Search to detect if candidate went to client behind our back
   * - Combine multiple source matches into ONE alert per candidate+client
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

    // Track matches per candidate+client to avoid duplicates
    // Key: "candidateId-clientName" → { sources: [], matches: [] }
    const matchTracker = new Map();

    try {
      const candidates = this.db.data.candidates || [];
      const submissions = this.db.data.submissions || [];

      console.log(`\n${'='.repeat(70)}`);
      console.log(`  COMPREHENSIVE MONITORING - ${new Date().toLocaleString()}`);
      console.log(`${'='.repeat(70)}`);
      console.log(`Total candidates: ${candidates.length}`);
      console.log(`Total submissions: ${submissions.length}`);

      // =========================================
      // PHASE 0: Pre-Research Client Companies
      // =========================================
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`  PHASE 0: Pre-Researching Client Companies for Parent/Subsidiary Info`);
      console.log(`${'─'.repeat(70)}`);

      const clientNames = [...new Set(submissions.map(s => s.client_name).filter(Boolean))];
      console.log(`  Found ${clientNames.length} unique clients to research`);

      for (const clientName of clientNames) {
        try {
          // METHOD 1 (BEST): NPI Registry Authorized Official Lookup
          // Find all organizations with the same authorized official as the client
          // This is the most reliable way because it's official government data
          if (typeof this.npi.findAllClientPractices === 'function') {
            console.log(`\n  📋 Method 1: NPI Authorized Official Lookup for "${clientName}"`);
            const npiPractices = await this.npi.findAllClientPractices(clientName);

            // Add discovered practices to company relationships
            for (const practice of npiPractices) {
              this.companyResearch.addRelationship(clientName, practice.name);
            }
          }

          // METHOD 2: Research company for known web relationships
          console.log(`  📋 Method 2: Web Research for "${clientName}"`);
          await this.companyResearch.researchCompany(clientName);

          // METHOD 3: Scrape client's website for their location pages
          if (typeof this.companyResearch.scrapeClientLocations === 'function') {
            console.log(`  📋 Method 3: Location Page Scraping for "${clientName}"`);
            await this.companyResearch.scrapeClientLocations(clientName);
          }
        } catch (e) {
          console.log(`  Could not research ${clientName}: ${e.message}`);
        }
      }

      console.log(`\n  ✓ Client company research complete`);

      // =========================================
      // PHASE 1: Pipeline Stage Alerts (HIRED ONLY)
      // =========================================
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`  PHASE 1: Pipeline Stage Alerts (Confirmed Placements Only)`);
      console.log(`${'─'.repeat(70)}`);

      for (const submission of submissions) {
        const stage = (submission.pipeline_stage || '').toLowerCase();
        const candidate = candidates.find(c => c.id === submission.candidate_id);

        if (!candidate) continue;

        // ONLY create Pipeline alert for CONFIRMED placements
        const isHired = stage.includes('hired') || stage.includes('placed') || stage.includes('started');

        if (isHired) {
          const existingAlert = (this.db.data.alerts || []).find(a =>
            a.candidate_id === candidate.id &&
            a.client_name === submission.client_name &&
            a.sources && a.sources.includes('Pipeline')
          );

          if (!existingAlert) {
            console.log(`  🚨 CONFIRMED HIRED: ${candidate.full_name} → ${submission.client_name}`);

            this.createAlert({
              candidate_id: candidate.id,
              candidate_name: candidate.full_name,
              client_name: submission.client_name,
              sources: ['Pipeline'],
              source: 'Pipeline', // Keep for backwards compatibility
              confidence: 'Confirmed',
              match_details: `CONFIRMED: ${candidate.full_name} was HIRED at ${submission.client_name} - ${submission.job_title}`,
              pipeline_stage: submission.pipeline_stage
            });

            results.alertsCreated++;
            results.bySource.pipeline++;
          }
        } else {
          // For Negotiation, Offer, and earlier stages - just log that we'll search
          const isNegotiation = stage.includes('negotiation') || stage.includes('offer');
          if (isNegotiation) {
            console.log(`  🔍 ${candidate.full_name} in ${submission.pipeline_stage} → Will search to verify`);
          }
        }
      }

      // =========================================
      // PHASE 2: NPI Registry (NPPES + CMS + Third-Party)
      // =========================================
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`  PHASE 2: NPI Registry (All Sources)`);
      console.log(`${'─'.repeat(70)}`);

      for (const candidate of candidates) {
        results.checked++;
        const candidateSubmissions = submissions.filter(s => s.candidate_id === candidate.id);

        if (candidateSubmissions.length === 0) continue;

        console.log(`\n  📋 ${candidate.full_name}`);

        for (const submission of candidateSubmissions) {
          const clientName = submission.client_name || '';
          const matchKey = `${candidate.id}-${clientName.toLowerCase()}`;

          try {
            const npiAlert = await this.npi.checkCandidateAtClient(candidate, submission, this.companyResearch);

            if (npiAlert) {
              console.log(`     🚨 NPI MATCH: ${npiAlert.employerFound} → ${clientName}`);

              // Track this match
              if (!matchTracker.has(matchKey)) {
                matchTracker.set(matchKey, {
                  candidate_id: candidate.id,
                  candidate_name: candidate.full_name,
                  client_name: clientName,
                  sources: [],
                  matches: [],
                  confidence: 'Low'
                });
              }

              const tracked = matchTracker.get(matchKey);
              if (!tracked.sources.includes('NPI')) {
                tracked.sources.push('NPI');
                tracked.matches.push({
                  source: 'NPI',
                  details: npiAlert.matchDetails,
                  npi_number: npiAlert.npiNumber,
                  npi_employer: npiAlert.employerFound,
                  npi_address: npiAlert.address,
                  npi_registry_url: npiAlert.links?.npiRegistry,
                  cms_lookup_url: npiAlert.links?.cmsLookup,
                  data_source: npiAlert.dataSource
                });
                // Upgrade confidence
                if (npiAlert.confidence === 'high' || npiAlert.confidence === 'High') {
                  tracked.confidence = 'High';
                } else if (tracked.confidence === 'Low') {
                  tracked.confidence = 'Medium';
                }
              }

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
      // PHASE 3: LinkedIn
      // =========================================
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`  PHASE 3: LinkedIn`);
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
                const matchKey = `${candidate.id}-${clientName.toLowerCase()}`;

                const linkedinMatch = this.linkedin.checkProfileForClient(linkedinProfile, clientName, this.companyResearch);

                if (linkedinMatch && linkedinMatch.match) {
                  console.log(`     🚨 LINKEDIN MATCH: ${linkedinMatch.reason}`);

                  // Track this match
                  if (!matchTracker.has(matchKey)) {
                    matchTracker.set(matchKey, {
                      candidate_id: candidate.id,
                      candidate_name: candidate.full_name,
                      client_name: clientName,
                      sources: [],
                      matches: [],
                      confidence: 'Low'
                    });
                  }

                  const tracked = matchTracker.get(matchKey);
                  if (!tracked.sources.includes('LinkedIn')) {
                    tracked.sources.push('LinkedIn');
                    tracked.matches.push({
                      source: 'LinkedIn',
                      details: linkedinMatch.reason,
                      linkedin_url: linkedinProfile.profileUrl,
                      linkedin_employer: linkedinMatch.employer,
                      linkedin_title: linkedinMatch.title,
                      linkedin_location: linkedinProfile.usLocation
                    });
                    if (linkedinMatch.confidence === 'High') {
                      tracked.confidence = 'High';
                    } else if (tracked.confidence === 'Low') {
                      tracked.confidence = 'Medium';
                    }
                  }

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
                const matchKey = `${candidate.id}-${clientName.toLowerCase()}`;

                const doximityMatch = this.doximity.checkProfileForClient(doximityProfile, clientName, this.companyResearch);

                if (doximityMatch && doximityMatch.match) {
                  console.log(`     🚨 DOXIMITY MATCH: ${doximityMatch.reason}`);

                  // Track this match
                  if (!matchTracker.has(matchKey)) {
                    matchTracker.set(matchKey, {
                      candidate_id: candidate.id,
                      candidate_name: candidate.full_name,
                      client_name: clientName,
                      sources: [],
                      matches: [],
                      confidence: 'Low'
                    });
                  }

                  const tracked = matchTracker.get(matchKey);
                  if (!tracked.sources.includes('Doximity')) {
                    tracked.sources.push('Doximity');
                    tracked.matches.push({
                      source: 'Doximity',
                      details: doximityMatch.reason,
                      doximity_url: doximityProfile.profileUrl,
                      doximity_employer: doximityMatch.employer
                    });
                    if (doximityMatch.confidence === 'High') {
                      tracked.confidence = 'High';
                    } else if (tracked.confidence === 'Low') {
                      tracked.confidence = 'Medium';
                    }
                  }

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
                const matchKey = `${candidate.id}-${clientName.toLowerCase()}`;

                const healthgradesMatch = this.healthgrades.checkProfileForClient(healthgradesProfile, clientName, this.companyResearch);

                if (healthgradesMatch && healthgradesMatch.match) {
                  console.log(`     🚨 HEALTHGRADES MATCH: ${healthgradesMatch.reason}`);

                  // Track this match
                  if (!matchTracker.has(matchKey)) {
                    matchTracker.set(matchKey, {
                      candidate_id: candidate.id,
                      candidate_name: candidate.full_name,
                      client_name: clientName,
                      sources: [],
                      matches: [],
                      confidence: 'Low'
                    });
                  }

                  const tracked = matchTracker.get(matchKey);
                  if (!tracked.sources.includes('Healthgrades')) {
                    tracked.sources.push('Healthgrades');
                    tracked.matches.push({
                      source: 'Healthgrades',
                      details: healthgradesMatch.reason,
                      healthgrades_url: healthgradesProfile.profileUrl,
                      healthgrades_practice: healthgradesMatch.practice
                    });
                    if (healthgradesMatch.confidence === 'High') {
                      tracked.confidence = 'High';
                    } else if (tracked.confidence === 'Low') {
                      tracked.confidence = 'Medium';
                    }
                  }

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
                const matchKey = `${candidate.id}-${clientName.toLowerCase()}`;

                const googleMatch = this.googleSearch.checkResultsForClient(searchResults, clientName, this.companyResearch);

                if (googleMatch && googleMatch.match) {
                  console.log(`     🚨 GOOGLE MATCH: ${googleMatch.reason}`);

                  // Track this match
                  if (!matchTracker.has(matchKey)) {
                    matchTracker.set(matchKey, {
                      candidate_id: candidate.id,
                      candidate_name: candidate.full_name,
                      client_name: clientName,
                      sources: [],
                      matches: [],
                      confidence: 'Low'
                    });
                  }

                  const tracked = matchTracker.get(matchKey);
                  if (!tracked.sources.includes('Google')) {
                    tracked.sources.push('Google');
                    tracked.matches.push({
                      source: 'Google',
                      details: googleMatch.reason,
                      google_source_url: googleMatch.sourceUrl
                    });
                    // Google alone is medium confidence
                    if (tracked.confidence === 'Low') {
                      tracked.confidence = 'Medium';
                    }
                  }

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
      // PHASE 7: Create Consolidated Alerts
      // =========================================
      console.log(`\n${'─'.repeat(70)}`);
      console.log(`  PHASE 7: Creating Consolidated Alerts`);
      console.log(`${'─'.repeat(70)}`);

      for (const [matchKey, tracked] of matchTracker) {
        // Check if alert already exists for this candidate+client
        const existingAlert = (this.db.data.alerts || []).find(a =>
          a.candidate_id === tracked.candidate_id &&
          a.client_name.toLowerCase() === tracked.client_name.toLowerCase()
        );

        if (existingAlert) {
          // Update existing alert with new sources
          let updated = false;
          for (const source of tracked.sources) {
            if (!existingAlert.sources || !existingAlert.sources.includes(source)) {
              if (!existingAlert.sources) existingAlert.sources = [existingAlert.source];
              existingAlert.sources.push(source);
              updated = true;
            }
          }
          if (updated) {
            existingAlert.matches = [...(existingAlert.matches || []), ...tracked.matches];
            existingAlert.updated_at = new Date().toISOString();
            this.db.saveDatabase();
            console.log(`  📝 Updated: ${tracked.candidate_name} → ${tracked.client_name} (${existingAlert.sources.join(', ')})`);
          }
          continue;
        }

        // Create new consolidated alert
        // More sources = higher confidence
        if (tracked.sources.length >= 3) {
          tracked.confidence = 'High';
        } else if (tracked.sources.length >= 2) {
          tracked.confidence = 'High';
        }

        const alertData = {
          candidate_id: tracked.candidate_id,
          candidate_name: tracked.candidate_name,
          client_name: tracked.client_name,
          sources: tracked.sources,
          source: tracked.sources.join(' + '), // For backwards compatibility
          confidence: tracked.confidence,
          match_details: `Found on ${tracked.sources.length} source(s): ${tracked.sources.join(', ')}`,
          matches: tracked.matches
        };

        // Copy over source-specific data from matches
        for (const match of tracked.matches) {
          if (match.npi_number) alertData.npi_number = match.npi_number;
          if (match.npi_employer) alertData.npi_employer = match.npi_employer;
          if (match.npi_registry_url) alertData.npi_registry_url = match.npi_registry_url;
          if (match.cms_lookup_url) alertData.cms_lookup_url = match.cms_lookup_url;
          if (match.linkedin_url) alertData.linkedin_url = match.linkedin_url;
          if (match.linkedin_employer) alertData.linkedin_employer = match.linkedin_employer;
          if (match.doximity_url) alertData.doximity_url = match.doximity_url;
          if (match.healthgrades_url) alertData.healthgrades_url = match.healthgrades_url;
          if (match.google_source_url) alertData.google_source_url = match.google_source_url;
        }

        this.createAlert(alertData);
        results.alertsCreated++;

        // Update candidate profile with source links
        const candidate = candidates.find(c => c.id === tracked.candidate_id);
        if (candidate) {
          // Store all found links in candidate profile
          if (!candidate.source_links) candidate.source_links = {};

          for (const match of tracked.matches) {
            if (match.npi_registry_url) candidate.source_links.npi_registry = match.npi_registry_url;
            if (match.cms_lookup_url) candidate.source_links.cms_lookup = match.cms_lookup_url;
            if (match.linkedin_url) candidate.source_links.linkedin = match.linkedin_url;
            if (match.doximity_url) candidate.source_links.doximity = match.doximity_url;
            if (match.healthgrades_url) candidate.source_links.healthgrades = match.healthgrades_url;
            if (match.google_source_url) candidate.source_links.google = match.google_source_url;
          }

          // Also store match info
          if (!candidate.match_history) candidate.match_history = [];
          candidate.match_history.push({
            client_name: tracked.client_name,
            sources: tracked.sources,
            confidence: tracked.confidence,
            found_at: new Date().toISOString()
          });

          this.db.saveDatabase();
        }

        console.log(`  🚨 NEW ALERT: ${tracked.candidate_name} → ${tracked.client_name}`);
        console.log(`     Sources: ${tracked.sources.join(', ')}`);
        console.log(`     Confidence: ${tracked.confidence}`);
      }

      // =========================================
      // Summary
      // =========================================
      console.log(`\n${'='.repeat(70)}`);
      console.log(`  MONITORING COMPLETE`);
      console.log(`${'='.repeat(70)}`);
      console.log(`  Candidates checked: ${results.checked}`);
      console.log(`  Total alerts created: ${results.alertsCreated}`);
      console.log(`  Matches by Source:`);
      console.log(`    - Pipeline (Confirmed): ${results.bySource.pipeline}`);
      console.log(`    - NPI: ${results.bySource.npi}`);
      console.log(`    - LinkedIn: ${results.bySource.linkedin}`);
      console.log(`    - Doximity: ${results.bySource.doximity}`);
      console.log(`    - Healthgrades: ${results.bySource.healthgrades}`);
      console.log(`    - Google: ${results.bySource.google}`);
      console.log(`  Note: Matches are consolidated into single alerts per candidate+client`);
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
