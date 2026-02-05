/**
 * NPI Registry Monitoring Service - COMPREHENSIVE VERSION
 * Eye to Eye Careers - Candidate Placement Tracker
 *
 * Updated: February 2026
 *
 * This service implements the FULL NPI monitoring workflow:
 * 1. Search NPPES NPI Registry by name to get NPI number
 * 2. Query multiple sources for all practice addresses:
 *    - NPPES (primary)
 *    - CMS Medicare Provider Data (shows ALL practice affiliations)
 * 3. Google search for businesses at each address
 * 4. Match business names against client + parent companies
 *
 * API Documentation:
 * - NPPES: https://npiregistry.cms.hhs.gov/api-page
 * - CMS Medicare: https://data.cms.gov/provider-data/api
 *
 * APIs are FREE - no API key required!
 */

const https = require('https');

class NPIService {
  constructor() {
    this.baseUrl = 'https://npiregistry.cms.hhs.gov/api';
    this.cmsBaseUrl = 'https://data.cms.gov/provider-data/api/1/datastore/query';
    this.apiVersion = '2.1';
    this.initialized = false;

    // Rate limiting: NPPES recommends max 200 requests per minute
    this.requestDelay = 350; // ms between requests (safe rate)
    this.lastRequestTime = 0;
  }

  /**
   * Initialize the NPI service
   */
  async initialize() {
    console.log('✓ NPI Registry Service (COMPREHENSIVE - NPPES + CMS Medicare)');
    this.initialized = true;
    return true;
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
   * @param {object} npiesData - Already fetched NPPES data (optional)
   */
  async getAllPracticeLocations(npiNumber, nppesData = null) {
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
    console.log(`    📋 Querying CMS Medicare for all practice locations...`);
    const cmsLocations = await this.queryCMSMedicare(npiNumber);

    if (cmsLocations.length > 0) {
      console.log(`    ✅ CMS found ${cmsLocations.length} practice location(s)`);
      allLocations.push(...cmsLocations);
    } else {
      console.log(`    ℹ️ No CMS Medicare records found`);
    }

    // Deduplicate locations by address
    const uniqueLocations = [];
    const seenAddresses = new Set();

    for (const loc of allLocations) {
      const key = `${loc.address.line1}-${loc.address.city}-${loc.address.state}`.toLowerCase();
      if (!seenAddresses.has(key)) {
        seenAddresses.add(key);
        uniqueLocations.push(loc);
      }
    }

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

    // Step 2: Get ALL practice locations
    const allLocations = await this.getAllPracticeLocations(provider.npi, provider);

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
