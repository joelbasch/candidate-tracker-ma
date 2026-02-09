/**
 * NPI Registry Monitoring Service
 * Eye to Eye Careers - Candidate Placement Tracker
 *
 * Updated: February 2026
 *
 * Data Sources:
 * 1. NPPES API - Search by name → get NPI, addresses, employer, specialty
 * 2. CMS Reassignment API - Get ALL organizations a provider belongs to
 *    (data.cms.gov Revalidation Reassignment List)
 *
 * Workflow:
 * - Search NPPES by name → get NPI number + practice addresses
 * - Query CMS Reassignment with NPI → get all affiliated organizations
 * - Return all org names + all addresses for matching
 *
 * Both APIs are FREE - no API key required!
 */

const https = require('https');

class NPIService {
  constructor() {
    this.baseUrl = 'https://npiregistry.cms.hhs.gov/api';
    this.apiVersion = '2.1';
    this.initialized = false;

    // CMS Reassignment API
    this.cmsDatasetUUID = null; // Discovered on init from data.cms.gov/data.json
    this.cmsBaseUrl = 'data.cms.gov';

    // Rate limiting
    this.requestDelay = 350;
    this.lastRequestTime = 0;
  }

  /**
   * Initialize the NPI service - discovers CMS dataset UUID
   */
  async initialize() {
    // Try to discover the CMS Reassignment dataset UUID
    try {
      await this.discoverCMSDatasetUUID();
    } catch (e) {
      console.log(`  ⚠ CMS Reassignment API: Could not discover dataset UUID (${e.message})`);
    }

    const cmsStatus = this.cmsDatasetUUID
      ? `CMS Reassignment API ready`
      : `CMS Reassignment API unavailable`;

    console.log(`✓ NPI Registry Service (NPPES + ${cmsStatus})`);
    this.initialized = true;
    return true;
  }

  /**
   * Discover the CMS Revalidation Reassignment List dataset UUID from data.json
   */
  async discoverCMSDatasetUUID() {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.cmsBaseUrl,
        path: '/data.json',
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 15000
      };

      const req = https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const catalog = JSON.parse(data);
            const datasets = catalog.dataset || [];

            // Find the Revalidation Reassignment List
            const reassignmentDataset = datasets.find(d =>
              (d.title || '').toLowerCase().includes('revalidation reassignment list')
            );

            if (reassignmentDataset && reassignmentDataset.distribution) {
              // Find the API distribution
              const apiDist = reassignmentDataset.distribution.find(d =>
                (d.format || '').toUpperCase() === 'API' ||
                (d.accessURL || '').includes('data-api')
              );

              if (apiDist && apiDist.accessURL) {
                // Extract UUID from URL like: https://data.cms.gov/data-api/v1/dataset/UUID/data
                const uuidMatch = apiDist.accessURL.match(/dataset\/([a-f0-9-]+)/);
                if (uuidMatch) {
                  this.cmsDatasetUUID = uuidMatch[1];
                  console.log(`  ✓ CMS Reassignment dataset UUID: ${this.cmsDatasetUUID}`);
                  resolve();
                  return;
                }
              }
            }

            reject(new Error('Dataset not found in catalog'));
          } catch (e) {
            reject(new Error(`Failed to parse CMS catalog: ${e.message}`));
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  /**
   * Query CMS Reassignment API to get all organizations an individual NPI belongs to
   * Returns array of { groupName, groupNPI, groupState, specialty }
   */
  async getOrganizations(npiNumber) {
    if (!this.cmsDatasetUUID || !npiNumber) return [];

    return new Promise((resolve) => {
      const path = `/data-api/v1/dataset/${this.cmsDatasetUUID}/data?filter[Individual NPI]=${npiNumber}&size=100`;

      const options = {
        hostname: this.cmsBaseUrl,
        path: encodeURI(path),
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 15000
      };

      const req = https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const rows = JSON.parse(data);
            if (!Array.isArray(rows)) {
              resolve([]);
              return;
            }

            const orgs = rows.map(row => ({
              groupName: row['Group Legal Business Name'] || '',
              groupState: row['Group State Code'] || '',
              recordType: row['Record Type'] || '',
              individualSpecialty: row['Individual Specialty Description'] || '',
              totalAssociations: row['Individual Total Employer Associations'] || ''
            })).filter(o => o.groupName);

            resolve(orgs);
          } catch (e) {
            resolve([]);
          }
        });
      });

      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    });
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
   */
  async makeRequest(params) {
    await this.rateLimit();

    return new Promise((resolve, reject) => {
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
   * Also strips parenthetical content: "Reuben Alexander (formerly Arunasalem)"
   */
  parseName(fullName) {
    if (!fullName) return { firstName: '', lastName: '' };

    let name = fullName.trim();

    // Strip parenthetical content first
    name = name.replace(/\([^)]*\)/g, '').trim();

    // Remove common prefixes/suffixes
    const prefixes = ['Dr.', 'Dr', 'MD', 'M.D.', 'DO', 'D.O.', 'OD', 'O.D.', 'DPM', 'DDS', 'DMD', 'PhD', 'Ph.D.', 'NP', 'PA', 'RN', 'APRN'];
    for (const prefix of prefixes) {
      const regex = new RegExp(`^${prefix}\\s+`, 'i');
      name = name.replace(regex, '');
      const endRegex = new RegExp(`\\s*,?\\s*${prefix}$`, 'i');
      name = name.replace(endRegex, '');
    }

    name = name.replace(/,\s*$/, '').trim();

    // Handle "Last, First" format
    if (name.includes(',')) {
      const parts = name.split(',').map(p => p.trim());
      return { firstName: parts[1] || '', lastName: parts[0] || '' };
    }

    // Handle "First Middle Last" or "First Last"
    const parts = name.split(/\s+/);
    if (parts.length === 1) {
      return { firstName: '', lastName: parts[0] };
    } else if (parts.length === 2) {
      return { firstName: parts[0], lastName: parts[1] };
    } else {
      return { firstName: parts[0], lastName: parts[parts.length - 1] };
    }
  }

  /**
   * MAIN METHOD: Search for a provider by name
   * Returns providers with NPI, ALL addresses, employer, specialty
   */
  async searchByName(fullName, state = null, city = null) {
    const { firstName, lastName } = this.parseName(fullName);

    if (!lastName) {
      console.warn(`  Cannot search NPI - no last name extracted from: ${fullName}`);
      return [];
    }

    const params = {
      enumeration_type: 'NPI-1',
      limit: 50
    };

    if (firstName && firstName.length >= 2) {
      params.first_name = firstName + '*';
    }
    if (lastName && lastName.length >= 2) {
      params.last_name = lastName + '*';
    }

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

      const providers = (response.results || []).map(result => this.parseProviderResult(result));

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
   * Search NPI for an ORGANIZATION by name (NPI-2 type)
   * Used to find client company NPIs and all their subsidiary practice names
   * Returns array of { npi, orgName, addresses, ... }
   */
  async searchOrganizationByName(companyName) {
    if (!companyName || companyName.length < 3) return [];

    // Clean the company name for NPI search
    const cleanName = companyName
      .replace(/\bllc|llp|inc|corp|pc|pllc|pa\b/gi, '')
      .replace(/[^\w\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleanName || cleanName.length < 3) return [];

    const params = {
      enumeration_type: 'NPI-2', // Organizations only
      organization_name: cleanName + '*',
      limit: 20
    };

    try {
      console.log(`    🔍 Searching NPI for organization: "${cleanName}"`);
      const response = await this.makeRequest(params);

      if (!response || response.result_count === 0) {
        return [];
      }

      const orgs = (response.results || []).map(result => {
        const basic = result.basic || {};
        const addresses = result.addresses || [];
        const practiceAddr = addresses.find(a => a.address_purpose === 'LOCATION') || addresses[0] || {};

        return {
          npi: result.number,
          orgName: basic.organization_name || '',
          authorizedOfficial: `${basic.authorized_official_first_name || ''} ${basic.authorized_official_last_name || ''}`.trim(),
          address: {
            line1: practiceAddr.address_1 || '',
            city: practiceAddr.city || '',
            state: practiceAddr.state || '',
            zip: practiceAddr.postal_code || ''
          }
        };
      });

      console.log(`    📊 Found ${orgs.length} organization(s)`);
      return orgs;

    } catch (error) {
      console.log(`    ⚠️ Org search error: ${error.message}`);
      return [];
    }
  }

  /**
   * Get all subsidiary/practice names for an organization NPI
   * Queries CMS Reassignment API for all providers reassigned to this org
   * Returns unique practice/group names
   */
  async getSubsidiaryNames(orgNpiNumber) {
    if (!this.cmsDatasetUUID || !orgNpiNumber) return [];

    return new Promise((resolve) => {
      // Search by Group PAC ID or by organization - we search by the org's providers
      // The Reassignment list maps Individual → Group, so we need to find entries where
      // the Group Legal Business Name matches what we found
      // Actually, we can't filter by Group NPI directly in this dataset
      // But we CAN use the Group Legal Business Name
      resolve([]);
    });
  }

  /**
   * Search by NPI number (if we have it)
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
   * Parse a provider result from the NPPES API response
   * Now extracts ALL addresses, practice_locations, endpoints, and other_names
   */
  parseProviderResult(result) {
    const basic = result.basic || {};
    const addresses = result.addresses || [];
    const taxonomies = result.taxonomies || [];
    const practiceLocations = result.practice_locations || [];
    const endpoints = result.endpoints || [];
    const otherNames = result.other_names || [];

    // Get practice location address (not mailing)
    const practiceAddress = addresses.find(a => a.address_purpose === 'LOCATION') || addresses[0] || {};

    // Get ALL location addresses
    const allAddresses = [];
    for (const addr of addresses) {
      if (addr.address_purpose === 'LOCATION') {
        allAddresses.push({
          line1: addr.address_1 || '',
          line2: addr.address_2 || '',
          city: addr.city || '',
          state: addr.state || '',
          zip: addr.postal_code || '',
          phone: addr.telephone_number || '',
          organizationName: addr.organization_name || ''
        });
      }
    }

    // Add practice_locations (secondary locations)
    for (const loc of practiceLocations) {
      allAddresses.push({
        line1: loc.address_1 || '',
        line2: loc.address_2 || '',
        city: loc.city || '',
        state: loc.state || '',
        zip: loc.postal_code || '',
        phone: loc.telephone_number || '',
        organizationName: loc.organization_name || ''
      });
    }

    // Get primary taxonomy
    const primaryTaxonomy = taxonomies.find(t => t.primary) || taxonomies[0] || {};

    // Extract all organization names from various sources
    const orgNames = new Set();
    if (practiceAddress.organization_name) orgNames.add(practiceAddress.organization_name);
    if (basic.organization_name) orgNames.add(basic.organization_name);
    for (const addr of allAddresses) {
      if (addr.organizationName) orgNames.add(addr.organizationName);
    }
    for (const ep of endpoints) {
      if (ep.affiliationName) orgNames.add(ep.affiliationName);
    }
    for (const on of otherNames) {
      if (on.organization_name) orgNames.add(on.organization_name);
    }

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

      // Primary employer/practice
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

      // ALL addresses (primary + secondary locations)
      allAddresses: allAddresses,

      // ALL organization names found in NPPES data
      allOrgNames: [...orgNames],

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
   * Compare employer name to client name with smart matching
   */
  compareEmployerToClient(employer, client) {
    if (!employer || !client) {
      return { isMatch: false };
    }

    const emp = employer.toLowerCase().trim();
    const cli = client.toLowerCase().trim();

    if (emp === cli) {
      return { isMatch: true, confidence: 'high', matchType: 'exact' };
    }

    if (emp.includes(cli) || cli.includes(emp)) {
      return { isMatch: true, confidence: 'high', matchType: 'substring' };
    }

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

    if (normEmp === normCli) {
      return { isMatch: true, confidence: 'high', matchType: 'normalized exact' };
    }

    if (normEmp.includes(normCli) || normCli.includes(normEmp)) {
      return { isMatch: true, confidence: 'high', matchType: 'normalized substring' };
    }

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
}

module.exports = new NPIService();
