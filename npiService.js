/**
 * NPI Registry Monitoring Service
 * Eye to Eye Careers - Candidate Placement Tracker
 * 
 * Updated: February 2026
 * 
 * This service queries the NPPES NPI Registry to:
 * - Look up providers by NAME (first_name + last_name) - NO NPI REQUIRED
 * - Retrieve current employer/practice location information
 * - Detect when candidates start working at submitted clients
 * 
 * API Documentation: https://npiregistry.cms.hhs.gov/api-page
 * Demo/Testing: https://npiregistry.cms.hhs.gov/demo-api
 * 
 * KEY CHANGE: This version searches by candidate NAME, not NPI number.
 * The system will automatically find and store NPI numbers when matches are found.
 * 
 * API is FREE - no API key required!
 */

const https = require('https');

class NPIService {
  constructor() {
    this.baseUrl = 'https://npiregistry.cms.hhs.gov/api';
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
    console.log('✓ NPI Registry Service (searches by name - no NPI required)');
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
      }
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
   * 
   * @param {object} candidate - Candidate object with full_name, npi_number (optional)
   * @param {object} submission - Submission object with client_name
   * @returns {object|null} Alert data if match found, null otherwise
   */
  async checkCandidateAtClient(candidate, submission) {
    const clientName = submission.client_name;
    let providers = [];
    let searchMethod = '';

    // Strategy 1: If we have NPI number, use it (most accurate)
    if (candidate.npi_number && /^\d{10}$/.test(candidate.npi_number)) {
      const provider = await this.searchByNPI(candidate.npi_number);
      if (provider) {
        providers = [{ ...provider, matchScore: 1.0 }];
        searchMethod = 'NPI lookup';
      }
    }

    // Strategy 2: Search by name (works even without NPI)
    if (providers.length === 0) {
      providers = await this.searchByName(candidate.full_name);
      searchMethod = 'name search';
      
      // If we found a high-confidence match, we might want to store the NPI for future use
      if (providers.length > 0 && providers[0].matchScore > 0.8) {
        // Could update candidate.npi_number here if desired
      }
    }

    if (providers.length === 0) {
      console.log(`    No NPI records found for ${candidate.full_name}`);
      return null;
    }

    // Check each potential provider for employer match
    for (const provider of providers) {
      // Skip if name match is too weak
      if (provider.matchScore < 0.5) continue;

      const employerName = provider.organizationName;
      
      if (!employerName) {
        // No employer listed - might be self-employed or not updated
        continue;
      }

      // Check if employer matches client
      const matchResult = this.compareEmployerToClient(employerName, clientName);
      
      if (matchResult.isMatch) {
        console.log(`    🚨 MATCH FOUND: ${provider.fullName} at "${employerName}" matches client "${clientName}"`);
        
        return {
          source: 'NPI',
          confidence: matchResult.confidence,
          matchDetails: `NPI Registry (${searchMethod}) shows ${provider.fullName} (NPI: ${provider.npi}) ` +
                       `is currently at "${employerName}" - ${matchResult.matchType} match with submitted client "${clientName}"`,
          npiNumber: provider.npi,
          employerFound: employerName,
          providerInfo: {
            npi: provider.npi,
            name: provider.fullName,
            credential: provider.credential,
            specialty: provider.taxonomy.description,
            address: provider.practiceAddress,
            lastUpdated: provider.lastUpdated
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
   */
  async batchCheck(candidatesWithSubmissions) {
    const alerts = [];
    let checked = 0;

    for (const { candidate, submissions } of candidatesWithSubmissions) {
      for (const submission of submissions) {
        checked++;
        const alert = await this.checkCandidateAtClient(candidate, submission);
        
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
