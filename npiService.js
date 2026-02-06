/**
 * NPI Registry Monitoring Service - COMPREHENSIVE VERSION
 * Eye to Eye Careers - Candidate Placement Tracker
 *
 * Updated: February 2026
 *
 * This service implements the FULL NPI monitoring workflow:
 * 1. Search NPPES NPI Registry by name to get NPI number
 * 2. Query MULTIPLE sources for all practice addresses:
 *    - NPPES (primary/official)
 *    - CMS Medicare Provider Data (shows ALL practice affiliations)
 *    - NPIDB.org (third-party aggregator)
 *    - NPINo.com (third-party mirror)
 *    - NPIProfile.com (third-party profile site)
 *    - DocInfo.org (doctor information)
 *    - Zocdoc (appointment/practice info)
 *    - Vitals.com (healthcare provider directory)
 *    - WebMD (provider directory)
 * 3. Match business names against client + parent companies
 *
 * API Documentation:
 * - NPPES: https://npiregistry.cms.hhs.gov/api-page
 * - CMS Medicare: https://data.cms.gov/provider-data/api
 * - Third-party sites: searched via Serper.dev Google Search API
 *
 * NPPES/CMS APIs are FREE - no API key required!
 * Third-party searches require SERPER_API_KEY
 */

const https = require('https');

class NPIService {
  constructor() {
    this.baseUrl = 'https://npiregistry.cms.hhs.gov/api';
    this.cmsBaseUrl = 'https://data.cms.gov/provider-data/api/1/datastore/query';
    this.apiVersion = '2.1';
    this.initialized = false;

    // Serper.dev API for third-party site searches
    this.serperApiKey = process.env.SERPER_API_KEY || '';
    this.serperEndpoint = 'google.serper.dev';

    // Rate limiting: NPPES recommends max 200 requests per minute
    this.requestDelay = 350; // ms between requests (safe rate)
    this.lastRequestTime = 0;

    // Third-party NPI sites to search
    this.thirdPartySites = [
      { name: 'NPIDB', domain: 'npidb.org', searchPattern: 'site:npidb.org' },
      { name: 'NPINo', domain: 'npino.com', searchPattern: 'site:npino.com' },
      { name: 'NPIProfile', domain: 'npiprofile.com', searchPattern: 'site:npiprofile.com' },
      { name: 'DocInfo', domain: 'docinfo.org', searchPattern: 'site:docinfo.org' },
      { name: 'Zocdoc', domain: 'zocdoc.com', searchPattern: 'site:zocdoc.com' },
      { name: 'Vitals', domain: 'vitals.com', searchPattern: 'site:vitals.com' },
      { name: 'WebMD', domain: 'webmd.com/doctor', searchPattern: 'site:webmd.com/doctor' }
    ];
  }

  /**
   * Initialize the NPI service
   */
  async initialize() {
    const sources = ['NPPES', 'CMS Medicare'];
    if (this.serperApiKey) {
      sources.push('NPIDB', 'NPINo', 'NPIProfile', 'DocInfo', 'Zocdoc', 'Vitals', 'WebMD');
    }
    console.log(`✓ NPI Registry Service (${sources.join(' + ')})`);
    this.initialized = true;
    return true;
  }

  /**
   * Make a Serper.dev search request
   */
  async serperSearch(query, numResults = 5) {
    if (!this.serperApiKey) return null;

    return new Promise((resolve) => {
      const postData = JSON.stringify({
        q: query,
        num: numResults
      });

      const options = {
        hostname: this.serperEndpoint,
        path: '/search',
        method: 'POST',
        headers: {
          'X-API-KEY': this.serperApiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve(null); }
        });
      });

      req.on('error', () => resolve(null));
      req.write(postData);
      req.end();
    });
  }

  /**
   * Search a third-party NPI site for provider info
   * @param {string} fullName - Provider's full name
   * @param {string} npiNumber - NPI number (if known)
   * @param {object} site - Site config from thirdPartySites
   */
  async searchThirdPartySite(fullName, npiNumber, site) {
    if (!this.serperApiKey) return null;

    await this.rateLimit();

    // Build search query
    let query = `"${fullName}" ${site.searchPattern}`;
    if (npiNumber) {
      query = `"${npiNumber}" ${site.searchPattern}`;
    }

    const data = await this.serperSearch(query, 3);

    if (!data || !data.organic || data.organic.length === 0) {
      return null;
    }

    // Parse results for employer/practice info
    const results = [];
    for (const result of data.organic) {
      const parsed = this.parseThirdPartyResult(result, site.name);
      if (parsed) {
        results.push(parsed);
      }
    }

    return results.length > 0 ? results : null;
  }

  /**
   * Parse a third-party site search result for employer info
   */
  parseThirdPartyResult(result, sourceName) {
    const title = result.title || '';
    const snippet = result.snippet || '';
    const link = result.link || '';
    const combined = `${title} ${snippet}`.toLowerCase();

    // Extract organization/employer names from snippets
    const employers = [];

    // Common patterns for employer mentions
    const patterns = [
      /(?:works at|practicing at|affiliated with|employed by|at)\s+([A-Z][A-Za-z0-9\s&'.,-]{3,50}?)(?:\s+in|\s*[.,]|$)/gi,
      /(?:practice|office|location|employer):\s*([A-Z][A-Za-z0-9\s&'.,-]{3,50}?)(?:\s*[.,|]|$)/gi,
      /([A-Z][A-Za-z0-9\s&'.,-]*(?:Eye|Vision|Optical|Optometry|Medical|Health|Clinic|Center|Hospital|Associates|Group)[A-Za-z0-9\s&'.,-]*)/gi
    ];

    for (const pattern of patterns) {
      const matches = snippet.matchAll(pattern);
      for (const m of matches) {
        const emp = m[1].trim();
        if (emp.length > 3 && emp.length < 60 && !employers.includes(emp)) {
          employers.push(emp);
        }
      }
    }

    // Extract location info
    let location = null;
    const locMatch = combined.match(/(?:in|located in)\s+([A-Za-z\s]+),\s*([A-Z]{2})/i);
    if (locMatch) {
      location = `${locMatch[1].trim()}, ${locMatch[2].toUpperCase()}`;
    }

    if (employers.length === 0 && !location) {
      return null;
    }

    return {
      source: sourceName,
      url: link,
      title: title,
      snippet: snippet,
      employers: employers,
      location: location
    };
  }

  /**
   * Search ALL third-party NPI sites for a provider
   */
  async searchAllThirdPartySites(fullName, npiNumber = null) {
    if (!this.serperApiKey) {
      return [];
    }

    const allResults = [];

    for (const site of this.thirdPartySites) {
      try {
        const results = await this.searchThirdPartySite(fullName, npiNumber, site);
        if (results && results.length > 0) {
          allResults.push(...results);
        }
      } catch (e) {
        // Silently continue on error
      }
      // Small delay between sites
      await new Promise(r => setTimeout(r, 200));
    }

    return allResults;
  }

  /**
   * Google search for a company/address to find parent companies or related businesses
   * @param {string} companyName - Company name from NPI
   * @param {object} address - Address object with city, state
   */
  async googleSearchCompany(companyName, address) {
    if (!this.serperApiKey || !companyName) return null;

    await this.rateLimit();

    // Build search query with company name and location
    let query = `"${companyName}"`;
    if (address && address.city && address.state) {
      query += ` ${address.city}, ${address.state}`;
    }
    query += ' eye care optometry';

    const data = await this.serperSearch(query, 5);

    if (!data || !data.organic) return null;

    const relatedCompanies = [];

    for (const result of data.organic) {
      const title = result.title || '';
      const snippet = result.snippet || '';
      const combined = `${title} ${snippet}`;

      // Look for parent company patterns
      const parentPatterns = [
        /(?:part of|owned by|subsidiary of|division of|member of|affiliated with)\s+([A-Z][A-Za-z0-9\s&'.,-]{3,50})/gi,
        /([A-Z][A-Za-z0-9\s&'.,-]+)\s+(?:owns|acquired|parent company)/gi
      ];

      for (const pattern of parentPatterns) {
        const matches = combined.matchAll(pattern);
        for (const m of matches) {
          const company = m[1].trim();
          if (company.length > 3 && company.length < 50 && !relatedCompanies.includes(company)) {
            relatedCompanies.push(company);
          }
        }
      }

      // Also extract any company names from snippets
      const companyPatterns = [
        /([A-Z][A-Za-z0-9\s&'.,-]*(?:Eye|Vision|Optical|EyeCare|Optometry|Medical|Health)[A-Za-z0-9\s&'.,-]*)/g
      ];

      for (const pattern of companyPatterns) {
        const matches = combined.matchAll(pattern);
        for (const m of matches) {
          const company = m[1].trim();
          if (company.length > 5 && company.length < 50 &&
              !relatedCompanies.includes(company) &&
              company.toLowerCase() !== companyName.toLowerCase()) {
            relatedCompanies.push(company);
          }
        }
      }
    }

    return relatedCompanies.length > 0 ? relatedCompanies : null;
  }

  /**
   * Google search an address to find what business is there
   * @param {object} address - Address object
   */
  async googleSearchAddress(address) {
    if (!this.serperApiKey || !address) return null;

    const addressStr = `${address.line1} ${address.city} ${address.state}`.trim();
    if (!addressStr || addressStr.length < 10) return null;

    await this.rateLimit();

    const query = `"${addressStr}" optometry eye care`;
    const data = await this.serperSearch(query, 5);

    if (!data || !data.organic) return null;

    const businessesFound = [];

    for (const result of data.organic) {
      const title = result.title || '';
      const snippet = result.snippet || '';

      // Extract business names
      const patterns = [
        /([A-Z][A-Za-z0-9\s&'.,-]*(?:Eye|Vision|Optical|EyeCare|Optometry|Clinic|Center|Associates)[A-Za-z0-9\s&'.,-]*)/g
      ];

      for (const pattern of patterns) {
        const matches = `${title} ${snippet}`.matchAll(pattern);
        for (const m of matches) {
          const business = m[1].trim();
          if (business.length > 5 && business.length < 50 && !businessesFound.includes(business)) {
            businessesFound.push(business);
          }
        }
      }
    }

    return businessesFound.length > 0 ? businessesFound : null;
  }

  /**
   * Rate limiter to avoid overloading the API
   */
  async rateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.requestDelay) {
      await new Promise(resolve => setTimeout(resolve, this.requestDelay - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
  }

  /**
   * Make a request to the NPPES API
   * @param {object} params - Query parameters
   */
  async makeRequest(params) {
    await this.rateLimit();

    return new Promise((resolve, reject) => {
      // Always include version
      params.version = this.apiVersion;

      const queryString = new URLSearchParams(params).toString();
      const url = `${this.baseUrl}/?${queryString}`;

      https.get(url, (res) => {
        let data = '';

        res.on('data', chunk => data += chunk);

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${data.substring(0, 200)}`));
          }
        });
      }).on('error', (error) => {
        reject(new Error(`NPI API request failed: ${error.message}`));
      });
    });
  }

  /**
   * Query CMS Medicare Provider Data for practice affiliations
   * This shows ALL locations where a provider bills Medicare - critical for detecting placements!
   * @param {string} npiNumber - 10-digit NPI number
   */
  async queryCMSMedicare(npiNumber) {
    if (!npiNumber) return [];

    await this.rateLimit();

    return new Promise((resolve) => {
      // CMS Medicare Physician & Other Practitioners dataset
      const datasetId = 'mj5m-pzi6'; // Medicare Physician & Other Practitioners
      const url = `https://data.cms.gov/provider-data/api/1/datastore/query/${datasetId}/0?conditions[0][property]=Rndrng_NPI&conditions[0][value]=${npiNumber}&limit=50`;

      https.get(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'CandidateTracker/1.0'
        }
      }, (res) => {
        let data = '';

        res.on('data', chunk => data += chunk);

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.results && Array.isArray(parsed.results)) {
              // Extract practice locations from CMS data
              const locations = parsed.results.map(r => ({
                organizationName: r.Rndrng_Prvdr_Org_Name || r.Org_Name || '',
                address: {
                  line1: r.Rndrng_Prvdr_St1 || '',
                  line2: r.Rndrng_Prvdr_St2 || '',
                  city: r.Rndrng_Prvdr_City || '',
                  state: r.Rndrng_Prvdr_State_Abrvtn || '',
                  zip: r.Rndrng_Prvdr_Zip5 || ''
                },
                source: 'CMS Medicare'
              }));
              resolve(locations);
            } else {
              resolve([]);
            }
          } catch (e) {
            console.log(`    CMS API parse error: ${e.message}`);
            resolve([]);
          }
        });
      }).on('error', (error) => {
        console.log(`    CMS API request failed: ${error.message}`);
        resolve([]);
      });
    });
  }

  /**
   * Parse a full name into first and last name components
   * Handles: "Dr. John Smith", "John A. Smith MD", "Smith, John", etc.
   */
  parseName(fullName) {
    if (!fullName) return { firstName: '', lastName: '' };

    let name = fullName.trim();

    // Remove common prefixes
    const prefixes = ['Dr.', 'Dr', 'MD', 'M.D.', 'DO', 'D.O.', 'OD', 'O.D.', 'DPM', 'DDS', 'DMD', 'PhD', 'Ph.D.', 'NP', 'PA', 'RN', 'APRN'];
    for (const prefix of prefixes) {
      const regex = new RegExp(`^${prefix}\\s+`, 'i');
      name = name.replace(regex, '');
      // Also remove from end
      const endRegex = new RegExp(`\\s*,?\\s*${prefix}$`, 'i');
      name = name.replace(endRegex, '');
    }

    name = name.trim();

    // Handle "Last, First" format
    if (name.includes(',')) {
      const parts = name.split(',').map(p => p.trim());
      return {
        firstName: parts[1] || '',
        lastName: parts[0] || ''
      };
    }

    // Handle "First Middle Last" or "First Last" format
    const parts = name.split(/\s+/);
    if (parts.length === 1) {
      return { firstName: '', lastName: parts[0] };
    } else if (parts.length === 2) {
      return { firstName: parts[0], lastName: parts[1] };
    } else {
      // Multiple parts - first is first name, last is last name, middle ignored
      return {
        firstName: parts[0],
        lastName: parts[parts.length - 1]
      };
    }
  }

  /**
   * MAIN METHOD: Search for a provider by name
   * This is the primary search method - no NPI number needed!
   *
   * @param {string} fullName - Candidate's full name (e.g., "Dr. John Smith")
   * @param {string} state - Optional state to narrow search (e.g., "CA")
   * @param {string} city - Optional city to narrow search
   * @returns {Array} List of matching providers with their NPI and employer info
   */
  async searchByName(fullName, state = null, city = null) {
    const { firstName, lastName } = this.parseName(fullName);

    if (!lastName) {
      console.warn(`  Cannot search NPI - no last name extracted from: ${fullName}`);
      return [];
    }

    const params = {
      enumeration_type: 'NPI-1', // Individual providers only
      limit: 50 // Get multiple results to find best match
    };

    // NPPES API requires at least 2 characters for wildcard searches
    if (firstName && firstName.length >= 2) {
      params.first_name = firstName + '*'; // Wildcard for variations
    }
    if (lastName && lastName.length >= 2) {
      params.last_name = lastName + '*';
    }

    // Add location filters if provided
    if (state) params.state = state.toUpperCase();
    if (city) params.city = city;

    try {
      console.log(`  Searching NPI registry for: ${firstName} ${lastName}${state ? ` in ${state}` : ''}`);
      const response = await this.makeRequest(params);

      if (response.result_count === 0) {
        console.log(`    No NPI records found`);
        return [];
      }

      console.log(`    Found ${response.result_count} potential matches`);

      // Process results
      const providers = (response.results || []).map(result => this.parseProviderResult(result));

      // Score and sort by name match quality
      const scored = providers.map(p => ({
        ...p,
        matchScore: this.calculateNameMatchScore(fullName, `${p.firstName} ${p.lastName}`)
      }));

      scored.sort((a, b) => b.matchScore - a.matchScore);

      return scored;

    } catch (error) {
      console.error(`  NPI search error for ${fullName}:`, error.message);
      return [];
    }
  }

  /**
   * Search by NPI number (if we have it)
   * @param {string} npiNumber - 10-digit NPI number
   */
  async searchByNPI(npiNumber) {
    if (!npiNumber || !/^\d{10}$/.test(npiNumber)) {
      return null;
    }

    try {
      console.log(`  Looking up NPI: ${npiNumber}`);
      const response = await this.makeRequest({ number: npiNumber });

      if (response.result_count === 0) {
        console.log(`    NPI ${npiNumber} not found`);
        return null;
      }

      return this.parseProviderResult(response.results[0]);

    } catch (error) {
      console.error(`  NPI lookup error for ${npiNumber}:`, error.message);
      return null;
    }
  }

  /**
   * COMPREHENSIVE: Get ALL practice locations from multiple sources
   * @param {string} npiNumber - 10-digit NPI number
   * @param {object} nppesData - Already fetched NPPES data (optional)
   * @param {string} fullName - Provider's full name for third-party searches
   */
  async getAllPracticeLocations(npiNumber, nppesData = null, fullName = null) {
    const allLocations = [];

    // Source 1: NPPES (primary address)
    if (nppesData && nppesData.practiceAddress) {
      allLocations.push({
        organizationName: nppesData.organizationName || '',
        address: nppesData.practiceAddress,
        source: 'NPPES'
      });
    }

    // Source 2: CMS Medicare Provider Data (ALL billing locations)
    console.log(`    📋 Querying CMS Medicare...`);
    const cmsLocations = await this.queryCMSMedicare(npiNumber);

    if (cmsLocations.length > 0) {
      console.log(`    ✅ CMS: ${cmsLocations.length} location(s)`);
      allLocations.push(...cmsLocations);
    }

    // Source 3-9: Third-party NPI sites (via Serper)
    if (this.serperApiKey && fullName) {
      console.log(`    📋 Querying third-party NPI sites...`);
      const thirdPartyResults = await this.searchAllThirdPartySites(fullName, npiNumber);

      if (thirdPartyResults.length > 0) {
        let sitesFound = new Set();
        for (const result of thirdPartyResults) {
          sitesFound.add(result.source);
          // Add each employer found as a location
          for (const employer of (result.employers || [])) {
            allLocations.push({
              organizationName: employer,
              address: {
                line1: '',
                city: result.location ? result.location.split(',')[0].trim() : '',
                state: result.location ? result.location.split(',')[1]?.trim() : '',
                zip: ''
              },
              source: result.source,
              sourceUrl: result.url
            });
          }
        }
        console.log(`    ✅ Third-party: Found data from ${Array.from(sitesFound).join(', ')}`);
      }
    }

    // Source 10: Google search for each company name + address
    if (this.serperApiKey && allLocations.length > 0) {
      console.log(`    📋 Google searching company names & addresses...`);
      const googleFoundCompanies = [];

      for (const loc of allLocations.slice(0, 3)) { // Limit to first 3 to avoid too many API calls
        // Search by company name
        if (loc.organizationName) {
          const relatedCompanies = await this.googleSearchCompany(loc.organizationName, loc.address);
          if (relatedCompanies) {
            for (const company of relatedCompanies) {
              if (!googleFoundCompanies.includes(company)) {
                googleFoundCompanies.push(company);
                allLocations.push({
                  organizationName: company,
                  address: loc.address,
                  source: 'Google (related company)',
                  relatedTo: loc.organizationName
                });
              }
            }
          }
        }

        // Search by address
        if (loc.address && loc.address.line1) {
          const businessesAtAddress = await this.googleSearchAddress(loc.address);
          if (businessesAtAddress) {
            for (const business of businessesAtAddress) {
              if (!googleFoundCompanies.includes(business)) {
                googleFoundCompanies.push(business);
                allLocations.push({
                  organizationName: business,
                  address: loc.address,
                  source: 'Google (address search)'
                });
              }
            }
          }
        }
      }

      if (googleFoundCompanies.length > 0) {
        console.log(`    ✅ Google: Found ${googleFoundCompanies.length} related companies`);
      }
    }

    // Deduplicate locations by organization name (more reliable than address for third-party)
    const uniqueLocations = [];
    const seenOrgs = new Set();

    for (const loc of allLocations) {
      const orgKey = (loc.organizationName || '').toLowerCase().trim();
      const addrKey = `${loc.address.line1}-${loc.address.city}-${loc.address.state}`.toLowerCase();
      const key = orgKey || addrKey;

      if (key && !seenOrgs.has(key)) {
        seenOrgs.add(key);
        uniqueLocations.push(loc);
      }
    }

    console.log(`    Found ${uniqueLocations.length} unique practice location(s) to check`);
    return uniqueLocations;
  }

  /**
   * Parse a provider result from the API response
   */
  parseProviderResult(result) {
    const basic = result.basic || {};
    const addresses = result.addresses || [];
    const taxonomies = result.taxonomies || [];

    // Get practice location (not mailing address)
    const practiceAddress = addresses.find(a => a.address_purpose === 'LOCATION') || addresses[0] || {};

    // Get primary taxonomy (specialty)
    const primaryTaxonomy = taxonomies.find(t => t.primary) || taxonomies[0] || {};

    return {
      npi: result.number,
      firstName: basic.first_name || '',
      lastName: basic.last_name || '',
      fullName: `${basic.first_name || ''} ${basic.last_name || ''}`.trim(),
      credential: basic.credential || '',
      gender: basic.gender || '',
      status: basic.status || 'A',
      lastUpdated: basic.last_updated || '',
      enumerationDate: basic.enumeration_date || '',

      // Employer/Practice info - THIS IS WHAT WE USE FOR MATCHING
      organizationName: practiceAddress.organization_name || basic.organization_name || '',
      practiceAddress: {
        line1: practiceAddress.address_1 || '',
        line2: practiceAddress.address_2 || '',
        city: practiceAddress.city || '',
        state: practiceAddress.state || '',
        zip: practiceAddress.postal_code || '',
        phone: practiceAddress.telephone_number || '',
        fax: practiceAddress.fax_number || ''
      },

      // Specialty
      taxonomy: {
        code: primaryTaxonomy.code || '',
        description: primaryTaxonomy.desc || '',
        license: primaryTaxonomy.license || '',
        state: primaryTaxonomy.state || ''
      },

      // NPI Registry Links
      npiRegistryUrl: `https://npiregistry.cms.hhs.gov/provider-view/${result.number}`,
      cmsLookupUrl: `https://data.cms.gov/tools/medicare-physician-other-practitioner-look-up-tool/provider/${result.number}`
    };
  }

  /**
   * Calculate how well two names match (0-1 score)
   */
  calculateNameMatchScore(name1, name2) {
    const n1 = name1.toLowerCase().replace(/[^a-z\s]/g, '').trim();
    const n2 = name2.toLowerCase().replace(/[^a-z\s]/g, '').trim();

    if (n1 === n2) return 1.0;

    const words1 = n1.split(/\s+/);
    const words2 = n2.split(/\s+/);

    let matches = 0;
    for (const w1 of words1) {
      if (words2.some(w2 => w1 === w2 || w1.startsWith(w2) || w2.startsWith(w1))) {
        matches++;
      }
    }

    return matches / Math.max(words1.length, words2.length);
  }

  /**
   * MAIN MONITORING METHOD: Check if a candidate is now working at a client
   * Uses the COMPREHENSIVE workflow:
   * 1. Get NPI number from name search
   * 2. Get ALL practice addresses (NPPES + CMS)
   * 3. Match organization names against client + parent companies
   *
   * @param {object} candidate - Candidate object with full_name, npi_number (optional)
   * @param {object} submission - Submission object with client_name
   * @param {object} companyResearch - CompanyResearchService instance for parent company matching
   * @returns {object|null} Alert data if match found, null otherwise
   */
  async checkCandidateAtClient(candidate, submission, companyResearch = null) {
    const clientName = submission.client_name;
    let provider = null;
    let searchMethod = '';

    // Step 1: Get provider NPI data
    if (candidate.npi_number && /^\d{10}$/.test(candidate.npi_number)) {
      provider = await this.searchByNPI(candidate.npi_number);
      searchMethod = 'NPI lookup';
    }

    if (!provider) {
      const providers = await this.searchByName(candidate.full_name);
      if (providers.length > 0 && providers[0].matchScore > 0.5) {
        provider = providers[0];
        searchMethod = 'name search';
      }
    }

    if (!provider) {
      console.log(`    No NPI records found for ${candidate.full_name}`);
      return null;
    }

    // Step 2: Get ALL practice locations (including third-party sites)
    const allLocations = await this.getAllPracticeLocations(provider.npi, provider, candidate.full_name);

    if (allLocations.length === 0) {
      console.log(`    No practice locations found for ${candidate.full_name}`);
      return null;
    }

    console.log(`    Found ${allLocations.length} practice location(s) to check`);

    // Step 3: Check each location for client/parent company match
    for (const location of allLocations) {
      const employerName = location.organizationName;

      if (!employerName) continue;

      // Direct comparison
      let matchResult = this.compareEmployerToClient(employerName, clientName);

      // If no direct match, check parent companies
      if (!matchResult.isMatch && companyResearch) {
        const companyRelation = companyResearch.areCompaniesRelated(employerName, clientName);
        if (companyRelation && companyRelation.match) {
          matchResult = {
            isMatch: true,
            confidence: 'high',
            matchType: `parent company (${companyRelation.reason})`
          };
        }
      }

      if (matchResult.isMatch) {
        const addressStr = `${location.address.line1}, ${location.address.city}, ${location.address.state} ${location.address.zip}`.trim();

        console.log(`    🚨 MATCH FOUND via ${location.source}!`);
        console.log(`       Organization: "${employerName}"`);
        console.log(`       Client: "${clientName}"`);
        console.log(`       Match Type: ${matchResult.matchType}`);

        return {
          source: 'NPI',
          dataSource: location.source,
          confidence: matchResult.confidence,
          matchDetails: `${location.source} shows ${provider.fullName} (NPI: ${provider.npi}) ` +
                       `practicing at "${employerName}" - ${matchResult.matchType} match with client "${clientName}"`,
          npiNumber: provider.npi,
          employerFound: employerName,
          address: addressStr,
          providerInfo: {
            npi: provider.npi,
            name: provider.fullName,
            credential: provider.credential,
            specialty: provider.taxonomy.description,
            address: location.address,
            lastUpdated: provider.lastUpdated
          },
          links: {
            npiRegistry: provider.npiRegistryUrl,
            cmsLookup: provider.cmsLookupUrl
          }
        };
      }
    }

    console.log(`    No employer match found for ${candidate.full_name}`);
    return null;
  }

  /**
   * Compare employer name to client name with smart matching
   */
  compareEmployerToClient(employer, client) {
    if (!employer || !client) {
      return { isMatch: false };
    }

    const emp = employer.toLowerCase().trim();
    const cli = client.toLowerCase().trim();

    // Exact match
    if (emp === cli) {
      return { isMatch: true, confidence: 'high', matchType: 'exact' };
    }

    // One contains the other
    if (emp.includes(cli) || cli.includes(emp)) {
      return { isMatch: true, confidence: 'high', matchType: 'substring' };
    }

    // Normalize common abbreviations
    const normalize = (str) => {
      return str
        .replace(/\bmed(ical)?\b/gi, 'medical')
        .replace(/\bhosp(ital)?\b/gi, 'hospital')
        .replace(/\bctr|cntr|center\b/gi, 'center')
        .replace(/\bclin(ic)?\b/gi, 'clinic')
        .replace(/\bhealthcare|health care\b/gi, 'healthcare')
        .replace(/\bhlth\b/gi, 'health')
        .replace(/\bassoc(iates?)?\b/gi, 'associates')
        .replace(/\bgrp|group\b/gi, 'group')
        .replace(/\bsvc(s)?|services?\b/gi, 'services')
        .replace(/\bphys(icians?)?\b/gi, 'physicians')
        .replace(/\beye\s*care\b/gi, 'eyecare')
        .replace(/\boptom(etry)?\b/gi, 'optometry')
        .replace(/\bophth(almology)?\b/gi, 'ophthalmology')
        .replace(/\breg(ional)?\b/gi, 'regional')
        .replace(/\buniv(ersity)?\b/gi, 'university')
        .replace(/\bllc|llp|inc|corp|pc|pllc|pa\b/gi, '')
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const normEmp = normalize(emp);
    const normCli = normalize(cli);

    // Check normalized versions
    if (normEmp === normCli) {
      return { isMatch: true, confidence: 'high', matchType: 'normalized exact' };
    }

    if (normEmp.includes(normCli) || normCli.includes(normEmp)) {
      return { isMatch: true, confidence: 'high', matchType: 'normalized substring' };
    }

    // Token overlap analysis
    const empTokens = normEmp.split(/\s+/).filter(t => t.length > 2);
    const cliTokens = normCli.split(/\s+/).filter(t => t.length > 2);

    if (empTokens.length === 0 || cliTokens.length === 0) {
      return { isMatch: false };
    }

    let matchingTokens = 0;
    for (const et of empTokens) {
      if (cliTokens.some(ct => ct === et || ct.includes(et) || et.includes(ct))) {
        matchingTokens++;
      }
    }

    const overlapRatio = matchingTokens / Math.min(empTokens.length, cliTokens.length);

    if (overlapRatio >= 0.7) {
      return { isMatch: true, confidence: 'medium', matchType: `${Math.round(overlapRatio * 100)}% token overlap` };
    }

    if (overlapRatio >= 0.5) {
      return { isMatch: true, confidence: 'low', matchType: `${Math.round(overlapRatio * 100)}% token overlap` };
    }

    return { isMatch: false };
  }

  /**
   * Batch check multiple candidates against their submissions
   * @param {Array} candidatesWithSubmissions - Array of { candidate, submissions }
   * @param {object} companyResearch - CompanyResearchService instance
   */
  async batchCheck(candidatesWithSubmissions, companyResearch = null) {
    const alerts = [];
    let checked = 0;

    for (const { candidate, submissions } of candidatesWithSubmissions) {
      for (const submission of submissions) {
        checked++;
        const alert = await this.checkCandidateAtClient(candidate, submission, companyResearch);

        if (alert) {
          alerts.push({
            candidate_id: candidate.id,
            submission_id: submission.id,
            ...alert
          });
        }
      }
    }

    return { checked, alerts };
  }
}

module.exports = new NPIService();
