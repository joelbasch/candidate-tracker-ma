/**
 * Doximity Service
 * Searches for healthcare providers on Doximity via Google (Serper.dev)
 *
 * Doximity is the largest professional medical network in the US
 * - Most physicians/optometrists have profiles
 * - Profiles include current employer and practice location
 * - Users often update employment status here
 *
 * Uses Serper.dev API to search site:doximity.com
 */

const https = require('https');

class DoximityService {
  constructor() {
    this.apiKey = process.env.SERPER_API_KEY || '';
    this.configured = !!this.apiKey;
    this.apiEndpoint = 'google.serper.dev';

    if (this.configured) {
      console.log(`✓ Doximity Service configured (via Serper.dev)`);
    } else {
      console.log(`⚠ Doximity Service: Missing SERPER_API_KEY - Doximity checks disabled`);
    }
  }

  /**
   * Make a POST request to Serper.dev API
   */
  async makeRequest(query, numResults = 5) {
    return new Promise((resolve) => {
      const postData = JSON.stringify({
        q: query,
        num: numResults
      });

      const options = {
        hostname: this.apiEndpoint,
        path: '/search',
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey,
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
   * Clean candidate name for search
   */
  cleanName(fullName) {
    if (!fullName) return '';
    let name = fullName.trim();
    name = name.replace(/\([^)]*\)/g, '').trim();
    name = name.replace(/,?\s*(OD|O\.D\.|MD|M\.D\.|DO|D\.O\.|DPM|DDS|DMD|PhD|FAAO|FCOVD)\s*$/gi, '').trim();
    name = name.replace(/^Dr\.?\s+/i, '').trim();
    name = name.replace(/,\s*$/, '').replace(/\s+/g, ' ').trim();
    return name;
  }

  /**
   * Search for a provider's Doximity profile
   * @param {string} fullName - Candidate's full name
   * @returns {object} Profile data or not found
   */
  async findProfile(fullName) {
    if (!this.configured) {
      return { found: false, reason: 'Serper not configured' };
    }

    const cleanedName = this.cleanName(fullName);
    if (!cleanedName) {
      return { found: false, reason: 'Could not parse name' };
    }

    console.log(`    🔍 Doximity search for: "${cleanedName}"`);

    // Search Google for their Doximity profile
    const queries = [
      `"${cleanedName}" site:doximity.com optometrist`,
      `"${cleanedName}" site:doximity.com OD`
    ];

    let bestProfile = null;

    for (const query of queries) {
      const data = await this.makeRequest(query, 5);

      if (data && data.organic) {
        for (const result of data.organic) {
          const link = result.link || '';
          // Must be a Doximity profile URL
          if (link.includes('doximity.com/pub/') || link.includes('doximity.com/cv/')) {
            // Check the title/snippet for name match
            const normTitle = (result.title || '').toLowerCase();
            const normSnippet = (result.snippet || '').toLowerCase();
            const nameParts = cleanedName.toLowerCase().split(' ');

            const firstName = nameParts[0];
            const lastName = nameParts[nameParts.length - 1];
            const combined = `${normTitle} ${normSnippet}`;

            if (combined.includes(firstName) && combined.includes(lastName)) {
              bestProfile = {
                url: link,
                title: result.title || '',
                snippet: result.snippet || ''
              };
              break;
            }
          }
        }
      }

      if (bestProfile) break;
      await new Promise(r => setTimeout(r, 300));
    }

    if (!bestProfile) {
      console.log(`    ℹ️ No Doximity profile found`);
      return { found: false, reason: 'No Doximity profile found' };
    }

    console.log(`    ✅ Found Doximity: ${bestProfile.url}`);

    // Extract employer info from title/snippet
    const profileData = this.parseDoximityResult(bestProfile.title, bestProfile.snippet);

    return {
      found: true,
      profileUrl: bestProfile.url,
      profileTitle: bestProfile.title,
      profileSnippet: bestProfile.snippet,
      currentEmployer: profileData.currentEmployer,
      location: profileData.location,
      specialty: profileData.specialty,
      employers: profileData.employers
    };
  }

  /**
   * Parse Doximity search result for employer info
   * Doximity titles look like: "Dr. John Smith, OD - Optometrist in City, ST | Doximity"
   * Snippets often contain: "Dr. Smith is an optometrist at Company Name in City, State"
   */
  parseDoximityResult(title, snippet) {
    const result = {
      currentEmployer: null,
      location: null,
      specialty: null,
      employers: []
    };

    // Extract specialty
    if (title) {
      const specMatch = title.match(/[-–]\s*(Optometrist|Ophthalmologist|Optician)/i);
      if (specMatch) {
        result.specialty = specMatch[1];
      }

      // Extract location from title: "in City, ST"
      const locMatch = title.match(/in\s+([A-Za-z\s]+),\s*([A-Z]{2})/i);
      if (locMatch) {
        result.location = `${locMatch[1].trim()}, ${locMatch[2].toUpperCase()}`;
      }
    }

    // Parse snippet for employer
    if (snippet) {
      // Pattern: "at Company Name" or "works at Company"
      const atMatch = snippet.match(/(?:at|works at|practicing at)\s+([A-Z][A-Za-z0-9\s&'.,-]{3,50}?)(?:\s+in|\s*[.,]|$)/i);
      if (atMatch) {
        const employer = atMatch[1].trim();
        result.currentEmployer = employer;
        result.employers.push(employer);
      }

      // Pattern: "affiliated with Company"
      const affMatch = snippet.match(/affiliated with\s+([A-Z][A-Za-z0-9\s&'.,-]{3,50}?)(?:\s*[.,]|$)/i);
      if (affMatch) {
        const employer = affMatch[1].trim();
        if (!result.employers.includes(employer)) {
          result.employers.push(employer);
        }
      }

      // Extract additional employer mentions
      const employerPatterns = [
        /(?:joined|works for|employed by|practicing at)\s+([A-Z][A-Za-z0-9\s&'.,-]{3,50})/gi
      ];

      for (const pattern of employerPatterns) {
        const matches = snippet.matchAll(pattern);
        for (const m of matches) {
          const emp = m[1].trim();
          if (emp.length > 3 && emp.length < 50 && !result.employers.includes(emp)) {
            result.employers.push(emp);
          }
        }
      }
    }

    return result;
  }

  /**
   * Check if Doximity profile mentions a client company
   */
  checkProfileForClient(profileData, clientName, companyResearch) {
    if (!profileData || !profileData.found) return { match: false };

    const normalize = (str) => {
      if (!str) return '';
      return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    };

    const normClient = normalize(clientName);

    // Build list of names to check
    const namesToCheck = [normClient];

    if (companyResearch && typeof companyResearch.getAliases === 'function') {
      try {
        const aliases = companyResearch.getAliases(clientName);
        for (const alias of aliases) {
          namesToCheck.push(normalize(alias));
        }
      } catch (e) { /* ignore */ }
    }

    const uniqueNames = [...new Set(namesToCheck)].filter(n => n.length > 2);

    // CHECK 1: Current employer match
    if (profileData.currentEmployer) {
      const normEmployer = normalize(profileData.currentEmployer);
      for (const name of uniqueNames) {
        if (normEmployer.includes(name) || name.includes(normEmployer)) {
          return {
            match: true,
            matchType: 'current_employer',
            confidence: 'High',
            reason: `Doximity: Current employer "${profileData.currentEmployer}" matches "${clientName}"`,
            employer: profileData.currentEmployer,
            profileUrl: profileData.profileUrl
          };
        }
      }
    }

    // CHECK 2: Any listed employer
    if (profileData.employers && profileData.employers.length > 0) {
      for (const employer of profileData.employers) {
        const normEmployer = normalize(employer);
        for (const name of uniqueNames) {
          if (normEmployer.includes(name) || name.includes(normEmployer)) {
            return {
              match: true,
              matchType: 'listed_employer',
              confidence: 'Medium',
              reason: `Doximity: Listed employer "${employer}" matches "${clientName}"`,
              employer: employer,
              profileUrl: profileData.profileUrl
            };
          }
        }
      }
    }

    // CHECK 3: Search in snippet text
    const combinedText = normalize(`${profileData.profileTitle} ${profileData.profileSnippet}`);
    for (const name of uniqueNames) {
      if (name.length >= 4 && combinedText.includes(name)) {
        return {
          match: true,
          matchType: 'snippet_mention',
          confidence: 'Medium',
          reason: `Doximity: Profile mentions "${clientName}"`,
          employer: profileData.currentEmployer,
          profileUrl: profileData.profileUrl
        };
      }
    }

    return { match: false };
  }
}

module.exports = DoximityService;
