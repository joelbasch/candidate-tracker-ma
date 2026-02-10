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
      id: Date.now() + Math.floor(Math.random() * 1000),
      status: 'pending',
      created_at: new Date().toISOString(),
      ...alertData
    };
    this.db.data.alerts.push(alert);
    this.db.saveDatabase();
    return alert;
  }

  /**
   * Enrich a client company by scraping their website for practice names and locations
   * 1) Google search "{client name}" to find their official website
   * 2) Only scrape pages from that domain (not third-party sites)
   * 3) Extract practice/subsidiary names
   * 4) Register all names as aliases in companyResearch
   */
  async enrichClientFromWebsite(clientName) {
    console.log(`  🌐 ${clientName}:`);

    // Check cache first — skip the whole Google search if we already know this client
    if (!this._clientWebsiteCache) this._clientWebsiteCache = {};
    if (this._clientWebsiteCache[clientName]) {
      const cached = this._clientWebsiteCache[clientName];
      if (cached.skip) {
        console.log(`    ℹ️ Skipping (cached: no suitable website found)`);
        return;
      }
      console.log(`    🌐 Official website: ${cached.website} (cached)`);
      // Jump straight to step 2 with cached values
      return this._enrichFromVerifiedSite(clientName, cached.website, cached.domain);
    }

    // Blacklist: never treat these as the client's official website
    const blacklistedDomains = new Set([
      'indeed', 'glassdoor', 'linkedin', 'facebook', 'twitter', 'instagram',
      'yelp', 'bbb', 'mapquest', 'yellowpages', 'whitepages', 'manta',
      'crunchbase', 'bloomberg', 'zoominfo', 'dnb', 'hoovers',
      'google', 'apple', 'bing', 'yahoo', 'wikipedia', 'reddit',
      'healthgrades', 'zocdoc', 'vitals', 'webmd', 'npidb',
      'visionmonday', 'reviewofoptometry', 'aoa', 'allaboutvision',
      'eyesoneyecare', 'optometrytimes', 'invisionmag'
    ]);

    // Industry keywords — the website must mention at least one to be an eye care company
    const industryKeywords = [
      'optometry', 'optometrist', 'optometric', 'ophthalmology', 'ophthalmologist',
      'eye care', 'eyecare', 'eye doctor', 'eye exam', 'eye health',
      'vision care', 'optical', 'glasses', 'contact lens', 'contacts',
      'retina', 'cataract', 'lasik', 'glaucoma', 'cornea',
      'od ', ' od,', ' od.', 'o.d.', 'doctor of optometry'
    ];

    // Step 1: Find the client's OFFICIAL website first
    // Include "optometry" in search to bias toward the right industry
    const searchData = await this.googleSearch.makeRequest(`"${clientName}" optometry OR optometrist OR "eye care"`, 10);

    let clientWebsite = null;
    let clientDomain = null;

    if (searchData && searchData.organic) {
      const clientNorm = clientName.toLowerCase().replace(/[^a-z0-9]/g, '');

      for (const r of searchData.organic) {
        if (!r.link) continue;
        try {
          const url = new URL(r.link);
          const host = url.hostname.replace('www.', '').toLowerCase();
          const hostNorm = host.replace(/[^a-z0-9]/g, '').replace(/(com|org|net|io|co|us|gg|biz|info)$/, '');

          // Skip blacklisted domains (job boards, social media, directories)
          if (blacklistedDomains.has(hostNorm) || blacklistedDomains.has(host.split('.')[0])) {
            continue;
          }

          // Domain must meaningfully match the client name
          const domainMatch = hostNorm.includes(clientNorm) ||
            (hostNorm.length >= 5 && clientNorm.includes(hostNorm));

          if (!domainMatch) continue;

          // VERIFY: Check snippet/title for industry keywords before accepting
          const snippetAndTitle = ((r.snippet || '') + ' ' + (r.title || '')).toLowerCase();
          const hasIndustrySignal = industryKeywords.some(kw => snippetAndTitle.includes(kw));

          if (!hasIndustrySignal) {
            // Domain matches but no eye care keywords — fetch homepage to verify
            console.log(`    🔍 Checking ${host} for eye care content...`);
            try {
              const pageContent = await this.googleSearch.fetchPageContent(`${url.protocol}//${url.hostname}`);
              const pageLower = (pageContent || '').toLowerCase();
              const pageHasIndustry = industryKeywords.some(kw => pageLower.includes(kw));
              if (!pageHasIndustry) {
                console.log(`    ❌ ${host} is not an eye care site, skipping`);
                continue; // Try next result
              }
            } catch (e) {
              console.log(`    ⚠️ Could not verify ${host}, skipping`);
              continue;
            }
          }

          clientWebsite = `${url.protocol}//${url.hostname}`;
          clientDomain = host;
          console.log(`    🌐 Official website: ${clientWebsite}`);
          break;
        } catch (e) {}
      }
    }

    if (!clientWebsite) {
      console.log(`    ℹ️ Could not find official website for ${clientName}`);
      this._clientWebsiteCache[clientName] = { skip: true };
      return;
    }

    // Cache the verified website for future candidates with same client
    this._clientWebsiteCache[clientName] = { website: clientWebsite, domain: clientDomain };

    return this._enrichFromVerifiedSite(clientName, clientWebsite, clientDomain);
  }

  /**
   * Step 2+: Scrape a verified client website for practice names/locations
   * Called directly for cached sites (skip Google search), or after website verification
   */
  async _enrichFromVerifiedSite(clientName, clientWebsite, clientDomain) {
    await new Promise(resolve => setTimeout(resolve, 300));

    // Step 2: Search for locations/practices page ON THEIR OWN DOMAIN
    let practicesPageUrl = null;
    const locSearch = await this.googleSearch.makeRequest(`site:${clientDomain} locations OR practices OR offices`, 5);

    if (locSearch && locSearch.organic) {
      for (const r of locSearch.organic) {
        const link = (r.link || '').toLowerCase();
        // Verify the result is actually from the client's domain (Google sometimes leaks other domains)
        try {
          const resultHost = new URL(r.link).hostname.replace('www.', '').toLowerCase();
          if (resultHost !== clientDomain && !resultHost.endsWith('.' + clientDomain)) {
            continue; // Skip results from wrong domain
          }
        } catch (e) { continue; }

        if (link.includes('location') || link.includes('practice') ||
            link.includes('office') || link.includes('our-brands')) {
          practicesPageUrl = r.link;
          break;
        }
      }
    }

    // Fallback: try common location page URLs on their domain
    const urlToScrape = practicesPageUrl || `${clientWebsite}/locations`;
    console.log(`    📄 Scraping: ${urlToScrape}`);

    let practiceNames = [];

    try {
      const pageText = await this.googleSearch.fetchPageContent(urlToScrape);
      if (pageText && pageText.length > 100) {
        console.log(`    ✅ Got ${pageText.length} chars from practices page`);

        // Extract practice/company names from the page
        // Look for patterns like business names that appear multiple times
        practiceNames = this.extractPracticeNames(pageText, clientName);

        if (practiceNames.length > 0) {
          console.log(`    🏥 Found ${practiceNames.length} practice name(s):`);
          for (const name of practiceNames.slice(0, 20)) {
            console.log(`       - ${name}`);
          }
          if (practiceNames.length > 20) {
            console.log(`       ... and ${practiceNames.length - 20} more`);
          }
        }
      }
    } catch (e) {
      console.log(`    ⚠️ Could not scrape practices page: ${e.message}`);
    }

    // Step 3: If we found practice names, try to get their locations too
    // For each practice with its own website, scrape for addresses
    // (limit to first 5 to avoid too many requests)
    const practiceLocations = [];

    for (const practiceName of practiceNames.slice(0, 5)) {
      // Google search for this practice's locations
      try {
        const practiceSearch = await this.googleSearch.makeRequest(`"${practiceName}" locations optometrist`, 5);
        if (practiceSearch && practiceSearch.organic && practiceSearch.organic[0]) {
          const practiceUrl = practiceSearch.organic[0].link;
          if (practiceUrl && (practiceUrl.includes('location') || practiceUrl.includes(practiceName.toLowerCase().replace(/\s+/g, '')))) {
            const locPage = await this.googleSearch.fetchPageContent(practiceUrl);
            if (locPage && locPage.length > 100) {
              // Extract addresses from the locations page
              const addresses = this.extractAddresses(locPage);
              if (addresses.length > 0) {
                console.log(`    📍 ${practiceName}: ${addresses.length} location(s)`);
                practiceLocations.push({ name: practiceName, addresses, url: practiceUrl });
              }
            }
          }
        }
      } catch (e) {}

      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Step 4: Register all discovered names as aliases for this client
    const allNames = [...practiceNames];
    for (const loc of practiceLocations) {
      if (!allNames.includes(loc.name)) allNames.push(loc.name);
    }

    if (allNames.length > 0 && this.companyResearch && typeof this.companyResearch.addRelationship === 'function') {
      for (const name of allNames) {
        this.companyResearch.addRelationship(clientName, name);
      }
      console.log(`    ✅ Registered ${allNames.length} practice name(s) as aliases for "${clientName}"`);
    }

    // Store practice locations for address matching during NPI check
    if (!this.clientLocations) this.clientLocations = {};
    this.clientLocations[clientName] = practiceLocations;
  }

  /**
   * Extract practice/company names from a scraped practices page
   * Looks for repeated patterns that look like business names
   */
  extractPracticeNames(pageText, parentName) {
    const names = new Set();
    const text = pageText || '';

    // Common patterns for practice names on aggregator pages:
    // - Lines that end with common suffixes like "Eye Care", "Vision", "Optical", "Eyecare"
    // - Names that appear as headers or list items
    const patterns = [
      /([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,4}\s+(?:Eye\s*Care|Eyecare|Vision|Optical|Optometry|Ophthalmology|Eye\s+(?:Center|Clinic|Associates|Group|Institute|Specialists)))/g,
      /([A-Z][A-Za-z'\-]+(?:\s+[A-Z][A-Za-z'\-]+){0,3}\s+(?:Family\s+Eye|Advanced\s+Eye|Premier\s+Eye|Complete\s+Eye)(?:\s+\w+)?)/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const name = match[1].trim();
        // Skip if it's just the parent company name or too short
        if (name.length > 5 && name.toLowerCase() !== parentName.toLowerCase()) {
          names.add(name);
        }
      }
    }

    // Also look for lines between common separators that look like practice names
    const lines = text.split(/[|\n•·–—]/).map(l => l.trim()).filter(l => l.length > 5 && l.length < 60);
    for (const line of lines) {
      const lower = line.toLowerCase();
      if ((lower.includes('eye') || lower.includes('vision') || lower.includes('optical') ||
           lower.includes('optom') || lower.includes('ophthalm')) &&
          /^[A-Z]/.test(line) && !lower.includes('click') && !lower.includes('learn more') &&
          !lower.includes('http') && !lower.includes('cookie')) {
        if (line.toLowerCase() !== parentName.toLowerCase()) {
          names.add(line.replace(/[,.]$/, '').trim());
        }
      }
    }

    // Filter out junk: names with too many words, or that contain nav/article keywords
    const junkWords = ['report', 'summit', 'corner', 'honor', 'moves', 'career', 'newsroom',
      'subscribe', 'newsletter', 'copyright', 'privacy', 'terms', 'login', 'sign in',
      'search', 'menu', 'navigation', 'footer', 'header', 'sidebar', 'article', 'blog',
      'watch', 'video', 'podcast', 'webinar', 'event', 'conference'];
    const filtered = [...names].filter(name => {
      const lower = name.toLowerCase();
      const words = name.split(/\s+/);
      // Max 6 words for a practice name
      if (words.length > 6) return false;
      // Skip if it contains junk keywords
      if (junkWords.some(j => lower.includes(j))) return false;
      return true;
    });

    return filtered;
  }

  /**
   * Extract addresses from a locations page
   * Looks for US address patterns (street, city, state zip)
   */
  extractAddresses(pageText) {
    const addresses = [];
    const text = pageText || '';

    // US address pattern: number + street, city, ST ZIP
    const addrPattern = /(\d+\s+[A-Za-z0-9\s\.\-]+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Ct|Court|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Pl|Place)[.\s,]+[A-Za-z\s]+,\s*[A-Z]{2}\s*\d{5})/gi;

    let match;
    while ((match = addrPattern.exec(text)) !== null) {
      const addr = match[1].trim();
      if (!addresses.includes(addr) && addr.length < 120) {
        addresses.push(addr);
      }
    }

    return addresses;
  }

  /**
   * Extract dates from scraped page content near a company/person mention
   * Looks for patterns like "Updated: Jan 2026", "Posted: Feb 5, 2026", copyright years, etc.
   */
  extractPageDates(pageText) {
    if (!pageText) return null;

    // Common date patterns on web pages
    const datePatterns = [
      // "Updated: Jan 15, 2026" or "Last updated January 2026"
      /(?:updated|modified|published|posted|added|joined|started)[:.\s]*(\w+\.?\s+\d{1,2},?\s+\d{4})/i,
      /(?:updated|modified|published|posted|added|joined|started)[:.\s]*(\w+\.?\s+\d{4})/i,
      // "01/15/2026" or "2026-01-15"
      /(?:updated|modified|published|posted|added|joined|started)[:.\s]*(\d{1,2}\/\d{1,2}\/\d{4})/i,
      /(?:updated|modified|published|posted|added|joined|started)[:.\s]*(\d{4}-\d{2}-\d{2})/i,
      // General date near top of page (first 500 chars)
      /(\w+\s+\d{1,2},?\s+202[4-9])/,
      /(\d{1,2}\/\d{1,2}\/202[4-9])/,
      /(202[4-9]-\d{2}-\d{2})/
    ];

    for (const pattern of datePatterns) {
      const match = pageText.substring(0, 2000).match(pattern);
      if (match) return match[1].trim();
    }

    return null;
  }

  /**
   * Enrich a client company on-demand, with caching
   * Called per-candidate; skips if already enriched this run
   */
  async ensureClientEnriched(clientName) {
    if (!clientName) return;
    if (!this._enrichedClients) this._enrichedClients = new Set();
    if (this._enrichedClients.has(clientName)) return;
    this._enrichedClients.add(clientName);

    if (this.googleSearch && this.googleSearch.apiKey) {
      try {
        console.log(`    🌐 Enriching client: ${clientName}`);
        await this.enrichClientFromWebsite(clientName);
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (e) {
        console.log(`    ⚠️ Error enriching ${clientName}: ${e.message}`);
      }
    }
  }

  /**
   * Check a single candidate through all sources: Pipeline → NPI → Google → LinkedIn
   * Google runs before LinkedIn to save Netrows credits when Google finds a match
   * Returns per-candidate results
   */
  async checkCandidate(candidate, submission, isHired, results) {
    const clientName = submission.client_name || '';
    const jobTitle = submission.job_title || '';
    const candidateResults = { pipeline: false, npi: false, linkedin: false, google: false };

    // --- Client Enrichment (cached after first lookup per client) ---
    await this.ensureClientEnriched(clientName);

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
    // Workflow:
    // 1) Search NPPES by candidate name → get NPI, addresses, employer
    // 2) Query CMS Reassignment API → get ALL organizations they belong to
    // 3) Check all org names (NPPES + CMS) against client
    // 4) If no direct match, Google search each NPI address to see what's there
    // 5) If still unclear, scrape pages for parent company names
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
          const addrLine = npiAddress.line1 || '';
          const addrCity = npiAddress.city || '';
          const addrState = npiAddress.state || '';
          const addrZip = npiAddress.zip || '';

          console.log(`    📍 NPI: ${relevantProvider.fullName} (${relevantProvider.npi})`);
          console.log(`    📍 Primary Address: ${addrLine}, ${addrCity}, ${addrState} ${addrZip}`);

          // Collect ALL organization names from NPPES data
          const allOrgNames = [...(relevantProvider.allOrgNames || [])];
          if (allOrgNames.length > 0) {
            console.log(`    🏢 NPPES Organizations: ${allOrgNames.join(', ')}`);
          }

          // Step 1: Query CMS Reassignment API for ALL affiliated organizations
          let cmsOrgs = [];
          try {
            cmsOrgs = await this.npi.getOrganizations(relevantProvider.npi);
            if (cmsOrgs.length > 0) {
              console.log(`    🏥 CMS Organizations (${cmsOrgs.length}):`);
              for (const org of cmsOrgs) {
                console.log(`       - ${org.groupName} (${org.groupState})`);
                if (!allOrgNames.includes(org.groupName)) {
                  allOrgNames.push(org.groupName);
                }
              }
            } else {
              console.log(`    ℹ️ CMS Reassignment: No organizations found`);
            }
          } catch (e) {
            console.log(`    ⚠️ CMS Reassignment error: ${e.message}`);
          }

          let matched = false;
          let matchReason = '';
          let confidence = 'Medium';
          let matchSourceUrl = '';

          // Step 2: Check ALL organization names against client
          for (const orgName of allOrgNames) {
            const orgMatch = this.companyResearch.areCompaniesRelated(orgName, clientName);
            if (orgMatch.match) {
              matched = true;
              matchReason = `Organization "${orgName}" matches client "${clientName}". ${orgMatch.reason}`;
              confidence = 'High';
              console.log(`    🚨 Organization match: "${orgName}" → "${clientName}"`);
              break;
            }
          }

          // Step 3: If no direct org match, Google search each NPI address
          if (!matched && this.googleSearch && this.googleSearch.apiKey) {
            const addressesToSearch = relevantProvider.allAddresses || [];
            // Add primary address if not in list
            if (addrLine && !addressesToSearch.find(a => a.line1 === addrLine)) {
              addressesToSearch.unshift({ line1: addrLine, city: addrCity, state: addrState });
            }

            for (const addr of addressesToSearch) {
              if (!addr.line1 || !addr.city || !addr.state) continue;
              if (matched) break;

              console.log(`    🔍 Searching address: "${addr.line1}" "${addr.city}" ${addr.state}`);
              const addressQuery = `"${addr.line1}" "${addr.city}" ${addr.state}`;

              try {
                const searchData = await this.googleSearch.makeRequest(addressQuery, 10);

                if (searchData && (searchData.organic || searchData.places)) {
                  const allResults = [];

                  if (searchData.organic) {
                    for (const r of searchData.organic) {
                      allResults.push({ title: r.title || '', snippet: r.snippet || '', link: r.link || '' });
                    }
                  }
                  if (searchData.places) {
                    for (const p of searchData.places) {
                      allResults.push({
                        title: p.title || '',
                        snippet: [p.type, p.address, p.phoneNumber].filter(Boolean).join(' - '),
                        link: p.website || '',
                        isLocal: true
                      });
                    }
                  }

                  console.log(`    📊 Got ${allResults.length} results for address`);

                  // Check titles and snippets for client match
                  for (const result of allResults) {
                    const titleCheck = this.companyResearch.areCompaniesRelated(result.title, clientName);
                    if (titleCheck.match) {
                      matched = true;
                      matchReason = `Address ${addr.line1}, ${addr.city}, ${addr.state} has "${result.title}" which matches "${clientName}". ${titleCheck.reason}`;
                      confidence = 'High';
                      matchSourceUrl = result.link;
                      console.log(`    🚨 Address match: "${result.title}" → "${clientName}"`);
                      break;
                    }

                    const snippetCheck = this.companyResearch.areCompaniesRelated(result.snippet, clientName);
                    if (snippetCheck.match) {
                      matched = true;
                      matchReason = `Address ${addr.line1}, ${addr.city}, ${addr.state} - result "${result.title}" mentions "${clientName}"`;
                      confidence = 'Medium';
                      matchSourceUrl = result.link;
                      console.log(`    🚨 Snippet match: "${result.title}" mentions "${clientName}"`);
                      break;
                    }
                  }

                  // Step 4: Scrape top pages to check for parent company names
                  if (!matched) {
                    const pagesToCheck = allResults.filter(r => r.link && !r.isLocal).slice(0, 3);
                    for (const result of pagesToCheck) {
                      try {
                        const pageText = await this.googleSearch.fetchPageContent(result.link);
                        if (pageText && pageText.length > 50) {
                          const pageCheck = this.companyResearch.areCompaniesRelated(pageText.substring(0, 3000), clientName);
                          if (pageCheck.match) {
                            matched = true;
                            matchReason = `Address ${addr.line1}, ${addr.city}, ${addr.state} - page "${result.title}" mentions "${clientName}" (parent/subsidiary). ${pageCheck.reason}`;
                            confidence = 'Medium';
                            matchSourceUrl = result.link;
                            console.log(`    🚨 Page content: "${result.link}" mentions "${clientName}"`);
                            break;
                          }
                        }
                      } catch (e) {
                        // Skip failed pages
                      }
                    }
                  }
                }

                await new Promise(resolve => setTimeout(resolve, 500));
              } catch (e) {
                console.log(`    ⚠️ Address search error: ${e.message}`);
              }
            }
          }

          if (matched && !this.alertExists(candidate.id, clientName, 'NPI')) {
            this.createAlert({
              candidate_id: candidate.id,
              candidate_name: candidate.full_name,
              client_name: clientName,
              source: 'NPI Registry',
              confidence: confidence,
              match_details: `NPI ${relevantProvider.npi} - ${relevantProvider.fullName} at ${addrLine}, ${addrCity}, ${addrState}. ${matchReason}`,
              npi_number: relevantProvider.npi,
              npi_location: `${addrCity}, ${addrState}`.toUpperCase(),
              google_source_url: matchSourceUrl || null
            });
            results.alertsCreated++;
            results.npiAlerts++;
            candidateResults.npi = true;
          } else if (!matched) {
            console.log(`    ℹ️ NPI: No client match found`);
          }
        }
      } else {
        console.log(`    ℹ️ NPI: No records found`);
      }
    } catch (error) {
      console.log(`    ❌ NPI error: ${error.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 100));

    // --- Google Search (Step 3 — runs BEFORE LinkedIn to save Netrows credits) ---
    // If Google finds the candidate on a client's website/news, no need for LinkedIn
    if (this.googleSearch && this.googleSearch.apiKey && !this.alertExists(candidate.id, clientName, 'Google Search')) {
      try {
        const searchResults = await this.googleSearch.searchCandidate(candidate.full_name);

        if (searchResults && searchResults.allResults && searchResults.allResults.length > 0) {
          const clientMatch = this.googleSearch.checkResultsForClient(searchResults, clientName, this.companyResearch);

          if (clientMatch && clientMatch.match) {
            // Try to extract a date from the matching page
            let pageDate = null;
            if (clientMatch.sourceUrl && searchResults.pageContents && searchResults.pageContents[clientMatch.sourceUrl]) {
              pageDate = this.extractPageDates(searchResults.pageContents[clientMatch.sourceUrl]);
            }
            // Also check if Serper returned a date for this result
            if (!pageDate && clientMatch.matchedResult && clientMatch.matchedResult.date) {
              pageDate = clientMatch.matchedResult.date;
            }

            let matchDetails = clientMatch.reason;
            if (pageDate) {
              matchDetails += ` | Page date: ${pageDate}`;
              console.log(`    📅 Page date found: ${pageDate}`);
            }

            console.log(`    🚨 GOOGLE MATCH: ${clientMatch.reason}`);

            this.createAlert({
              candidate_id: candidate.id,
              candidate_name: candidate.full_name,
              client_name: clientName,
              source: 'Google Search',
              confidence: 'Medium',
              match_details: matchDetails,
              google_source_url: clientMatch.sourceUrl,
              google_matched_text: clientMatch.matchedText,
              google_page_date: pageDate || null
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

    // --- LinkedIn (Step 4 — deep check, uses Netrows credit) ---
    // Skip if Google already found a match (save Netrows credits)
    if (candidateResults.google) {
      console.log(`    ⏭️ LinkedIn: Skipping — Google already confirmed match (saving Netrows credit)`);
    } else if (this.linkedin && this.linkedin.configured && !this.alertExists(candidate.id, clientName, 'LinkedIn')) {
      try {
        const profileData = await this.linkedin.findProfile(candidate.full_name);

        if (profileData && profileData.found) {
          // Save LinkedIn URL to candidate record
          if (!candidate.linkedin_url && profileData.profileUrl) {
            candidate.linkedin_url = profileData.profileUrl;
            this.db.saveDatabase();
          }

          // Log data source
          if (profileData.dataSource === 'netrows') {
            const histCount = (profileData.employmentHistory || []).length;
            console.log(`    📡 Data source: Netrows (${histCount} positions in history)`);
          } else {
            console.log(`    📡 Data source: Google snippet (limited employer data)`);
          }

          const clientMatch = this.linkedin.checkProfileForClient(profileData, clientName, this.companyResearch);

          if (clientMatch && clientMatch.match) {
            console.log(`    🚨 LINKEDIN MATCH: ${clientMatch.reason}`);

            const alertData = {
              candidate_id: candidate.id,
              candidate_name: candidate.full_name,
              client_name: clientName,
              source: 'LinkedIn',
              confidence: clientMatch.confidence || 'Medium',
              match_details: clientMatch.reason,
              linkedin_url: profileData.profileUrl,
              linkedin_employer: clientMatch.employer || profileData.currentEmployer,
              linkedin_title: clientMatch.title || profileData.currentTitle
            };

            // Include employment dates if available (from Netrows)
            if (clientMatch.startDate) {
              alertData.match_details += ` | Started: ${clientMatch.startDate}`;
            }

            this.createAlert(alertData);
            results.alertsCreated++;
            results.linkedinAlerts++;
            candidateResults.linkedin = true;
          } else {
            console.log(`    ℹ️ LinkedIn: Profile found, no client match`);
          }
        } else {
          console.log(`    ℹ️ LinkedIn: ${profileData?.reason || 'No profile found'}`);
        }
      } catch (error) {
        console.log(`    ❌ LinkedIn error: ${error.message}`);
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

      // Client enrichment runs per-candidate (cached after first lookup)
      this._enrichedClients = new Set();
      this._clientWebsiteCache = {};

      console.log(`\n══════════════════════════════════════════════════════════════════`);
      console.log(`  CANDIDATE MONITORING`);
      console.log(`  ${hiredCandidates.length} candidates to check (Pipeline → NPI → Google → LinkedIn)`);
      console.log(`  Client enrichment runs per-candidate (cached after first lookup)`);
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
