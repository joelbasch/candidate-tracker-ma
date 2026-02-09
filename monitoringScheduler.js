/**
 * Monitoring Scheduler
 * Checks candidates against NPI registry and creates alerts for matches
 * Matches based on: employer name, parent/subsidiary, AND location
 *
 * ARCHITECTURE: Processes each candidate-company pair together.
 * For each pair, ALL enrichment steps run inline:
 *   1. Pipeline stage check
 *   2. Company enrichment (website scraping for practice names, cached)
 *   3. NPI registry check (employer + location matching)
 *   4. Google search check (if configured)
 */

const https = require('https');
const http = require('http');
const CompanyResearchService = require('./companyResearchService');

class MonitoringScheduler {
  constructor(db, npiService, linkedinService, socialMediaService) {
    this.db = db;
    this.npi = npiService;
    this.linkedin = linkedinService;
    this.socialMedia = socialMediaService;
    this.companyResearch = new CompanyResearchService();
    this.isRunning = false;

    // Cache for company enrichment so each company is only scraped once per run
    this.companyEnrichmentCache = new Map();

    // Cache for NPI lookups so each candidate is only searched once per run
    this.npiCache = new Map();

    // Try to load GoogleSearchService if available
    try {
      const GoogleSearchService = require('./googleSearchService');
      this.googleSearch = new GoogleSearchService();
    } catch (e) {
      this.googleSearch = null;
    }
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

    if (!state1 || !state2) return { match: false };
    if (state1 !== state2) return { match: false };

    if (city1 && city2) {
      if (city1 === city2) {
        return { match: true, reason: `Same city: ${city1}, ${state1.toUpperCase()}` };
      }
      if (city1.includes(city2) || city2.includes(city1)) {
        return { match: true, reason: `City match: ${city1} / ${city2}, ${state1.toUpperCase()}` };
      }
      return { match: true, reason: `Same state (${state1.toUpperCase()}), different city: ${city1} vs ${city2}`, confidence: 'Medium' };
    }

    return { match: true, reason: `Same state: ${state1.toUpperCase()}`, confidence: 'Low' };
  }

  /**
   * Fetch a web page's text content for scraping practice names
   */
  async fetchPageContent(url, timeoutMs = 5000) {
    if (!url) return '';

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(''), timeoutMs);
      const protocol = url.startsWith('https') ? https : http;

      try {
        const req = protocol.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; EyeToEyeBot/1.0)',
            'Accept': 'text/html'
          },
          timeout: timeoutMs
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            clearTimeout(timer);
            this.fetchPageContent(res.headers.location, timeoutMs - 1000).then(resolve);
            return;
          }
          if (res.statusCode !== 200) {
            clearTimeout(timer);
            resolve('');
            return;
          }

          let data = '';
          res.on('data', chunk => {
            data += chunk;
            if (data.length > 100000) res.destroy();
          });
          res.on('end', () => {
            clearTimeout(timer);
            const text = data
              .replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&#\d+;/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .substring(0, 5000);
            resolve(text);
          });
          res.on('error', () => { clearTimeout(timer); resolve(''); });
        });
        req.on('error', () => { clearTimeout(timer); resolve(''); });
        req.on('timeout', () => { req.destroy(); clearTimeout(timer); resolve(''); });
      } catch (e) {
        clearTimeout(timer);
        resolve('');
      }
    });
  }

  /**
   * Extract practice/business names from scraped page content
   * Looks for patterns like location names, practice names, clinic names
   */
  extractPracticeNames(pageText, companyName) {
    if (!pageText || pageText.length < 50) return [];

    const names = new Set();
    const normalizedCompany = companyName.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

    // Look for patterns that suggest practice/clinic names
    // Pattern: capitalized multi-word phrases near eye/vision/optical keywords
    const eyeKeywords = /(?:eye|vision|optical|optometry|ophthalmology|optic|retina|lasik|clinic|center|associates|partners|practice|group)/i;

    // Extract potential practice names (2-5 capitalized words in a row)
    const namePattern = /(?:^|\s)((?:[A-Z][a-z]+\s+){1,4}(?:Eye|Vision|Optical|Optometry|Clinic|Center|Associates|Partners|Practice|Group|Care|Institute|Medical)[a-z]*)/gm;
    const rawMatches = pageText.match(namePattern) || [];

    for (const match of rawMatches) {
      const cleaned = match.trim();
      if (cleaned.length > 5 && cleaned.length < 80) {
        const normalizedMatch = cleaned.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        // Don't add the company name itself as an alias
        if (normalizedMatch !== normalizedCompany && !normalizedMatch.includes('cookie') && !normalizedMatch.includes('privacy')) {
          names.add(cleaned);
        }
      }
    }

    // Also look for lines that contain location-like patterns
    const lines = pageText.split(/[.\n|•]/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 5 && trimmed.length < 80 && eyeKeywords.test(trimmed)) {
        const normalizedLine = trimmed.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        if (normalizedLine !== normalizedCompany && !normalizedLine.includes('cookie') && !normalizedLine.includes('privacy')) {
          names.add(trimmed);
        }
      }
    }

    return Array.from(names).slice(0, 20);
  }

  /**
   * Enrich a company by scraping its website for practice names.
   * Results are cached so each company is only scraped once per monitoring run.
   * Found practice names are registered as aliases in CompanyResearchService.
   */
  async enrichCompany(clientName, submission) {
    const cacheKey = clientName.toLowerCase().trim();

    if (this.companyEnrichmentCache.has(cacheKey)) {
      return this.companyEnrichmentCache.get(cacheKey);
    }

    const enrichResult = { practiceNames: [], scraped: false, url: null };

    // Try to find a URL to scrape for this company
    // Check submission for website_url, or try common patterns
    let urlToScrape = submission.website_url || submission.company_url || null;

    if (!urlToScrape) {
      // Try to use Google Search to find the company's locations page
      if (this.googleSearch && this.googleSearch.apiKey) {
        try {
          const searchResults = await this.googleSearch.performSearch(`"${clientName}" optometry locations site`);
          if (searchResults && searchResults.length > 0) {
            // Use the first result that looks like a company website
            const companyResult = searchResults.find(r =>
              r.link && !r.link.includes('google.com') && !r.link.includes('serper.dev') &&
              (r.link.includes('location') || r.title.toLowerCase().includes(clientName.toLowerCase().split(' ')[0]))
            ) || searchResults[0];
            if (companyResult && companyResult.link) {
              urlToScrape = companyResult.link;
            }
          }
        } catch (e) {
          // Skip if search fails
        }
      }
    }

    if (urlToScrape) {
      console.log(`      📄 Scraping: ${urlToScrape}`);
      const pageText = await this.fetchPageContent(urlToScrape);

      if (pageText && pageText.length > 50) {
        console.log(`      ✅ Got ${pageText.length} chars from practices page`);
        enrichResult.scraped = true;
        enrichResult.url = urlToScrape;

        const practiceNames = this.extractPracticeNames(pageText, clientName);
        enrichResult.practiceNames = practiceNames;

        if (practiceNames.length > 0) {
          console.log(`      🏥 Found ${practiceNames.length} practice name(s):`);
          for (const name of practiceNames) {
            console.log(`         - ${name}`);
          }
          // Register practice names as aliases for matching
          for (const name of practiceNames) {
            this.companyResearch.addRelationship(clientName, name);
          }
          console.log(`      ✅ Registered ${practiceNames.length} practice name(s) as aliases for "${clientName}"`);
        }
      } else {
        console.log(`      ⚠️ Could not get content from ${urlToScrape}`);
      }
    }

    this.companyEnrichmentCache.set(cacheKey, enrichResult);
    return enrichResult;
  }

  /**
   * Get NPI results for a candidate (cached per run)
   */
  async getNPIForCandidate(candidate) {
    const cacheKey = candidate.id;

    if (this.npiCache.has(cacheKey)) {
      return this.npiCache.get(cacheKey);
    }

    let npiResults = null;
    try {
      npiResults = await this.npi.searchByName(candidate.full_name);
    } catch (error) {
      console.log(`      ⚠️ NPI search error: ${error.message}`);
    }

    this.npiCache.set(cacheKey, npiResults);
    return npiResults;
  }

  /**
   * Process a single candidate-company pair.
   * Runs ALL enrichment and matching for this pair together.
   */
  async processPair(candidate, submission, results) {
    const clientName = submission.client_name || '';
    const jobTitle = submission.job_title || '';
    const stage = (submission.pipeline_stage || '').toLowerCase();

    console.log(`\n  📋 ${candidate.full_name} → ${clientName}`);
    console.log(`     Stage: ${submission.pipeline_stage || 'N/A'} | Job: ${jobTitle || 'N/A'}`);

    // --- Step 1: Pipeline stage alert ---
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
        console.log(`     🚨 Pipeline: ${alertType}`);

        const alert = {
          id: Date.now() + Math.random(),
          candidate_id: candidate.id,
          candidate_name: candidate.full_name,
          client_name: submission.client_name,
          source: `Pipeline: ${submission.pipeline_stage}`,
          confidence: isHired ? 'Confirmed' : 'High',
          match_details: isHired
            ? `${candidate.full_name} was HIRED at ${submission.client_name} - ${jobTitle}`
            : `${candidate.full_name} is in NEGOTIATION with ${submission.client_name} - ${jobTitle}`,
          status: 'pending',
          created_at: new Date().toISOString()
        };

        if (!this.db.data.alerts) this.db.data.alerts = [];
        this.db.data.alerts.push(alert);
        results.alertsCreated++;
        results.pipelineAlerts++;
        this.db.saveDatabase();
      }
    }

    // --- Step 2: Company enrichment (scrape website for practice names) ---
    console.log(`     🌐 Enriching company: ${clientName}`);
    await this.enrichCompany(clientName, submission);

    // --- Step 3: NPI registry check ---
    console.log(`     🔍 Checking NPI for: ${candidate.full_name}`);
    const npiResults = await this.getNPIForCandidate(candidate);

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

        // Extract locations
        const jobLocation = this.extractLocation(jobTitle);
        const clientLocation = this.extractLocation(clientName);

        // Check employer match (now includes any scraped practice name aliases)
        const employerMatch = this.companyResearch.areCompaniesRelated(employerName, clientName);

        // Check location match
        const locationMatchJob = this.locationsMatch(npiLocation, jobLocation);
        const locationMatchClient = this.locationsMatch(npiLocation, clientLocation);
        const locationMatch = locationMatchJob.match ? locationMatchJob : locationMatchClient;

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

            console.log(`     🚨 NPI MATCH!`);
            console.log(`        NPI: ${relevantProvider.npi} - ${npiLocation.city}, ${npiLocation.state.toUpperCase()}`);
            console.log(`        Employer: ${employerName}`);
            console.log(`        Reason: ${matchReason}`);

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
        } else {
          console.log(`     ✅ No NPI match (employer: "${employerName}", location: ${npiLocation.city || '?'}, ${npiLocation.state || '?'})`);
        }
      }
    } else {
      console.log(`     ℹ️ No NPI records found`);
    }

    // --- Step 4: Google search check (if configured) ---
    if (this.googleSearch && this.googleSearch.apiKey) {
      const existingGoogleAlert = (this.db.data.alerts || []).find(a =>
        a.candidate_id === candidate.id &&
        a.client_name === submission.client_name &&
        a.source === 'Google Search'
      );

      if (!existingGoogleAlert) {
        console.log(`     🔎 Google search: "${candidate.full_name}" + "${clientName}"`);
        try {
          const searchResults = await this.googleSearch.searchCandidate(candidate.full_name);
          const googleMatch = this.googleSearch.checkResultsForClient(searchResults, clientName, this.companyResearch);

          if (googleMatch.match) {
            console.log(`     🚨 Google MATCH: ${googleMatch.reason}`);

            const alert = {
              id: Date.now() + Math.random(),
              candidate_id: candidate.id,
              candidate_name: candidate.full_name,
              client_name: submission.client_name,
              source: 'Google Search',
              confidence: 'Medium',
              match_details: googleMatch.reason,
              source_links: {
                search_url: googleMatch.sourceUrl || '',
                search_title: googleMatch.matchedText || '',
                search_snippet: googleMatch.matchedResult?.snippet || ''
              },
              status: 'pending',
              created_at: new Date().toISOString()
            };

            if (!this.db.data.alerts) this.db.data.alerts = [];
            this.db.data.alerts.push(alert);
            results.alertsCreated++;
            results.googleAlerts = (results.googleAlerts || 0) + 1;
            this.db.saveDatabase();
          }
        } catch (e) {
          console.log(`     ⚠️ Google search error: ${e.message}`);
        }
      }
    }

    // Small delay between pairs to avoid API rate limits
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  /**
   * Main monitoring method.
   * Processes each candidate-company pair together with all enrichment steps.
   */
  async runMonitoring() {
    if (this.isRunning) {
      return { checked: 0, alertsCreated: 0, message: 'Already running', skipped: true };
    }

    this.isRunning = true;

    // Clear per-run caches
    this.companyEnrichmentCache.clear();
    this.npiCache.clear();

    const results = {
      checked: 0,
      pairs: 0,
      npiUpdated: 0,
      alertsCreated: 0,
      pipelineAlerts: 0,
      npiAlerts: 0,
      googleAlerts: 0
    };

    try {
      const candidates = this.db.data.candidates || [];
      const submissions = this.db.data.submissions || [];

      // Build candidate-company pairs
      const pairs = [];
      for (const candidate of candidates) {
        const candidateSubmissions = submissions.filter(s => s.candidate_id === candidate.id);
        for (const submission of candidateSubmissions) {
          pairs.push({ candidate, submission });
        }
      }

      const uniqueCompanies = [...new Set(pairs.map(p => p.submission.client_name))];
      const uniqueCandidates = [...new Set(pairs.map(p => p.candidate.id))];

      console.log(`\n══════════════════════════════════════════════════════════════════`);
      console.log(`  CANDIDATE-COMPANY MONITORING`);
      console.log(`  Processing ${pairs.length} candidate-company pair(s)`);
      console.log(`  (${uniqueCandidates.length} candidates × ${uniqueCompanies.length} companies)`);
      console.log(`══════════════════════════════════════════════════════════════════`);

      // Process each pair together
      for (const { candidate, submission } of pairs) {
        results.pairs++;
        if (!results._checkedCandidates) results._checkedCandidates = new Set();
        results._checkedCandidates.add(candidate.id);

        await this.processPair(candidate, submission, results);
      }

      results.checked = results._checkedCandidates ? results._checkedCandidates.size : 0;
      delete results._checkedCandidates;

      console.log(`\n══════════════════════════════════════════════════════════════════`);
      console.log(`  MONITORING COMPLETE`);
      console.log(`  Candidates checked: ${results.checked}`);
      console.log(`  Pairs processed: ${results.pairs}`);
      console.log(`  NPI numbers updated: ${results.npiUpdated}`);
      console.log(`  Pipeline alerts: ${results.pipelineAlerts}`);
      console.log(`  NPI alerts: ${results.npiAlerts}`);
      console.log(`  Google alerts: ${results.googleAlerts}`);
      console.log(`  Total alerts created: ${results.alertsCreated}`);
      console.log(`  Companies enriched: ${this.companyEnrichmentCache.size}`);
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
