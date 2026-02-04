/**
 * Loxo CRM API Integration Service
 * Eye to Eye Careers - Candidate Placement Tracker
 * 
 * Updated: February 2026
 * 
 * This service integrates with Loxo's Open API to:
 * - Fetch candidates (people) from your Loxo database
 * - Retrieve job applications and submissions
 * - Sync candidate data for placement tracking
 * 
 * API Documentation: https://loxo.readme.io/reference/loxo-api
 * 
 * REQUIRED ENVIRONMENT VARIABLES:
 * - LOXO_API_KEY: Bearer token from Settings > API Keys in Loxo
 * - LOXO_DOMAIN: Your agency domain (e.g., eye-to-eye-careers.app.loxo.co)
 * - LOXO_AGENCY_SLUG: Your agency slug (e.g., eye-to-eye-careers)
 */

const https = require('https');
const http = require('http');

class LoxoService {
  constructor() {
    this.apiKey = process.env.LOXO_API_KEY;
    this.domain = process.env.LOXO_DOMAIN || 'app.loxo.co';
    this.agencySlug = process.env.LOXO_AGENCY_SLUG;
    
    // Construct base URL: https://{domain}/api/{agency_slug}
    this.baseUrl = `https://${this.domain}/api/${this.agencySlug}`;
    
    this.initialized = false;
  }

  /**
   * Initialize and validate the Loxo connection
   */
  async initialize() {
    if (!this.apiKey) {
      console.warn('⚠️  LOXO_API_KEY not configured - Loxo sync disabled');
      return false;
    }
    
    if (!this.agencySlug) {
      console.warn('⚠️  LOXO_AGENCY_SLUG not configured - Loxo sync disabled');
      return false;
    }

    try {
      // Test connection by fetching activity types (lightweight endpoint)
      const response = await this.makeRequest('/activity_types', 'GET');
      if (response) {
        console.log('✓ Loxo API connection verified');
        this.initialized = true;
        return true;
      }
    } catch (error) {
      console.warn('⚠️  Loxo API connection test failed:', error.message);
      console.warn('   Please verify your LOXO_API_KEY and LOXO_AGENCY_SLUG');
    }
    
    return false;
  }

  /**
   * Make an authenticated request to the Loxo API
   * @param {string} endpoint - API endpoint (e.g., '/people')
   * @param {string} method - HTTP method (GET, POST, PUT, DELETE)
   * @param {object} data - Request body for POST/PUT
   * @param {object} queryParams - URL query parameters
   */
  async makeRequest(endpoint, method = 'GET', data = null, queryParams = {}) {
    return new Promise((resolve, reject) => {
      // Build query string
      const queryString = Object.keys(queryParams).length > 0
        ? '?' + new URLSearchParams(queryParams).toString()
        : '';
      
      const url = new URL(`${this.baseUrl}${endpoint}${queryString}`);
      
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      };

      const protocol = url.protocol === 'https:' ? https : http;
      
      const req = protocol.request(options, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(responseData);
              resolve(parsed);
            } catch (e) {
              resolve(responseData);
            }
          } else if (res.statusCode === 401) {
            reject(new Error('Unauthorized - check your LOXO_API_KEY'));
          } else if (res.statusCode === 404) {
            reject(new Error(`Endpoint not found: ${endpoint}`));
          } else {
            reject(new Error(`Loxo API error ${res.statusCode}: ${responseData}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Network error: ${error.message}`));
      });

      // Set timeout
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (data && (method === 'POST' || method === 'PUT')) {
        req.write(JSON.stringify(data));
      }

      req.end();
    });
  }

  /**
   * Fetch all people (candidates) from Loxo
   * @param {object} filters - Optional filters (query, per_page, page, etc.)
   * @returns {Array} List of people/candidates
   */
  async getPeople(filters = {}) {
    if (!this.initialized && !await this.initialize()) {
      throw new Error('Loxo service not initialized');
    }

    const params = {
      per_page: filters.per_page || 100,
      page: filters.page || 1,
      ...filters
    };

    try {
      const response = await this.makeRequest('/people', 'GET', null, params);
      return response.people || response.data || response || [];
    } catch (error) {
      console.error('Error fetching people from Loxo:', error.message);
      throw error;
    }
  }

  /**
   * Fetch a specific person by ID
   * @param {string|number} personId - Loxo person ID
   */
  async getPerson(personId) {
    if (!this.initialized && !await this.initialize()) {
      throw new Error('Loxo service not initialized');
    }

    try {
      const response = await this.makeRequest(`/people/${personId}`, 'GET');
      return response.person || response;
    } catch (error) {
      console.error(`Error fetching person ${personId}:`, error.message);
      throw error;
    }
  }

  /**
   * Fetch all jobs from Loxo
   * @param {object} filters - Optional filters
   */
  async getJobs(filters = {}) {
    if (!this.initialized && !await this.initialize()) {
      throw new Error('Loxo service not initialized');
    }

    const params = {
      per_page: filters.per_page || 100,
      page: filters.page || 1,
      ...filters
    };

    try {
      const response = await this.makeRequest('/jobs', 'GET', null, params);
      return response.jobs || response.data || response || [];
    } catch (error) {
      console.error('Error fetching jobs from Loxo:', error.message);
      throw error;
    }
  }

  /**
   * Fetch candidates for a specific job
   * @param {string|number} jobId - Loxo job ID
   */
  async getJobCandidates(jobId) {
    if (!this.initialized && !await this.initialize()) {
      throw new Error('Loxo service not initialized');
    }

    try {
      const response = await this.makeRequest(`/jobs/${jobId}/candidates`, 'GET');
      return response.candidates || response.data || response || [];
    } catch (error) {
      console.error(`Error fetching candidates for job ${jobId}:`, error.message);
      throw error;
    }
  }

  /**
   * Fetch companies from Loxo
   * @param {object} filters - Optional filters
   */
  async getCompanies(filters = {}) {
    if (!this.initialized && !await this.initialize()) {
      throw new Error('Loxo service not initialized');
    }

    const params = {
      per_page: filters.per_page || 100,
      page: filters.page || 1,
      ...filters
    };

    try {
      const response = await this.makeRequest('/companies', 'GET', null, params);
      return response.companies || response.data || response || [];
    } catch (error) {
      console.error('Error fetching companies from Loxo:', error.message);
      throw error;
    }
  }

  /**
   * Fetch person lists (useful for getting candidates in specific lists)
   */
  async getPersonLists() {
    if (!this.initialized && !await this.initialize()) {
      throw new Error('Loxo service not initialized');
    }

    try {
      const response = await this.makeRequest('/person_lists', 'GET');
      return response.person_lists || response.data || response || [];
    } catch (error) {
      console.error('Error fetching person lists:', error.message);
      throw error;
    }
  }

  /**
   * Fetch activity records for a person (notes, emails, tasks)
   * @param {string|number} personId - Loxo person ID
   */
  async getPersonActivities(personId) {
    if (!this.initialized && !await this.initialize()) {
      throw new Error('Loxo service not initialized');
    }

    try {
      const response = await this.makeRequest(`/people/${personId}/person_events`, 'GET');
      return response.person_events || response.data || response || [];
    } catch (error) {
      console.error(`Error fetching activities for person ${personId}:`, error.message);
      throw error;
    }
  }

  /**
   * Main sync function - fetches candidates and their job submissions
   * This is the primary method used by the tracker
   * 
   * @returns {object} { candidates: [], submissions: [] }
   */
  async syncCandidatesAndSubmissions() {
    if (!this.initialized && !await this.initialize()) {
      return { candidates: [], submissions: [], error: 'Loxo service not initialized' };
    }

    console.log('Starting Loxo sync...');
    const results = {
      candidates: [],
      submissions: []
    };

    try {
      // Step 1: Fetch all jobs
      console.log('  Fetching jobs...');
      const jobs = await this.getJobs({ per_page: 200 });
      console.log(`  Found ${jobs.length} jobs`);

      // Step 2: For each job, get candidates
      for (const job of jobs) {
        try {
          const jobCandidates = await this.getJobCandidates(job.id);
          
          for (const candidate of jobCandidates) {
            // Get full person details
            let personDetails = candidate;
            if (candidate.person_id) {
              try {
                personDetails = await this.getPerson(candidate.person_id);
              } catch (e) {
                // Use what we have
              }
            }

            // Extract candidate info
            const candidateData = {
              loxo_id: personDetails.id || candidate.id,
              full_name: personDetails.name || `${personDetails.first_name || ''} ${personDetails.last_name || ''}`.trim(),
              email: this.extractEmail(personDetails),
              phone: this.extractPhone(personDetails),
              linkedin_url: personDetails.linkedin_url || personDetails.linkedin || '',
              npi_number: this.extractNPI(personDetails),
              facebook_url: personDetails.facebook_url || '',
              instagram_url: personDetails.instagram_url || '',
              twitter_url: personDetails.twitter_url || ''
            };

            // Check if candidate already in results
            const existingIndex = results.candidates.findIndex(c => c.loxo_id === candidateData.loxo_id);
            if (existingIndex === -1) {
              results.candidates.push(candidateData);
            }

            // Create submission record
            const submissionData = {
              loxo_candidate_id: candidateData.loxo_id,
              client_name: job.company_name || job.company?.name || 'Unknown Client',
              job_title: job.title || job.name || 'Unknown Position',
              submitted_date: candidate.created_at || candidate.added_at || new Date().toISOString().split('T')[0],
              loxo_job_id: job.id
            };

            results.submissions.push(submissionData);
          }
        } catch (error) {
          console.warn(`  Warning: Could not fetch candidates for job ${job.id}: ${error.message}`);
        }
      }

      console.log(`  Sync complete: ${results.candidates.length} candidates, ${results.submissions.length} submissions`);
      return results;

    } catch (error) {
      console.error('Loxo sync error:', error.message);
      return { candidates: [], submissions: [], error: error.message };
    }
  }

  /**
   * Alternative sync method - fetch people directly and look for submission metadata
   */
  async syncPeopleWithSubmissions() {
    if (!this.initialized && !await this.initialize()) {
      return { candidates: [], submissions: [], error: 'Loxo service not initialized' };
    }

    console.log('Starting Loxo people sync...');
    const results = {
      candidates: [],
      submissions: []
    };

    try {
      // Fetch all people with pagination
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        const people = await this.getPeople({ page, per_page: 100 });
        
        if (!people || people.length === 0) {
          hasMore = false;
          break;
        }

        for (const person of people) {
          const candidateData = {
            loxo_id: person.id,
            full_name: person.name || `${person.first_name || ''} ${person.last_name || ''}`.trim(),
            email: this.extractEmail(person),
            phone: this.extractPhone(person),
            linkedin_url: person.linkedin_url || person.linkedin || '',
            npi_number: this.extractNPI(person),
            facebook_url: person.facebook_url || '',
            instagram_url: person.instagram_url || '',
            twitter_url: person.twitter_url || ''
          };

          results.candidates.push(candidateData);

          // Try to get activities to find submission info
          try {
            const activities = await this.getPersonActivities(person.id);
            // Look for submission-related activities
            for (const activity of activities) {
              if (activity.activity_type === 'submission' || 
                  activity.notes?.toLowerCase().includes('submitted') ||
                  activity.notes?.toLowerCase().includes('application')) {
                results.submissions.push({
                  loxo_candidate_id: person.id,
                  client_name: activity.company_name || 'Unknown Client',
                  job_title: activity.job_title || 'Unknown Position',
                  submitted_date: activity.created_at || new Date().toISOString().split('T')[0]
                });
              }
            }
          } catch (e) {
            // Activities not available for this person
          }
        }

        page++;
        if (people.length < 100) hasMore = false;
      }

      console.log(`  People sync complete: ${results.candidates.length} candidates`);
      return results;

    } catch (error) {
      console.error('Loxo people sync error:', error.message);
      return { candidates: [], submissions: [], error: error.message };
    }
  }

  /**
   * Helper: Extract email from person object
   */
  extractEmail(person) {
    if (person.email) return person.email;
    if (person.emails && person.emails.length > 0) {
      return person.emails[0].email || person.emails[0];
    }
    if (person.primary_email) return person.primary_email;
    return '';
  }

  /**
   * Helper: Extract phone from person object
   */
  extractPhone(person) {
    if (person.phone) return person.phone;
    if (person.phones && person.phones.length > 0) {
      return person.phones[0].phone || person.phones[0];
    }
    if (person.primary_phone) return person.primary_phone;
    return '';
  }

  /**
   * Helper: Extract NPI number from person object (look in custom fields)
   */
  extractNPI(person) {
    // Check common field names for NPI
    if (person.npi) return person.npi;
    if (person.npi_number) return person.npi_number;
    
    // Check custom fields
    if (person.custom_fields) {
      for (const field of Object.values(person.custom_fields)) {
        if (typeof field === 'string' && /^\d{10}$/.test(field)) {
          return field;
        }
      }
      // Look for NPI-named field
      if (person.custom_fields.npi) return person.custom_fields.npi;
      if (person.custom_fields.NPI) return person.custom_fields.NPI;
      if (person.custom_fields.npi_number) return person.custom_fields.npi_number;
    }
    
    return '';
  }

  /**
   * Test the Loxo connection and return status info
   */
  async testConnection() {
    const status = {
      configured: !!(this.apiKey && this.agencySlug),
      connected: false,
      domain: this.domain,
      agencySlug: this.agencySlug,
      baseUrl: this.baseUrl,
      error: null
    };

    if (!status.configured) {
      status.error = 'Missing LOXO_API_KEY or LOXO_AGENCY_SLUG in .env file';
      return status;
    }

    try {
      await this.makeRequest('/activity_types', 'GET');
      status.connected = true;
    } catch (error) {
      status.error = error.message;
    }

    return status;
  }
}

module.exports = new LoxoService();
