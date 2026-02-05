/**
 * Healthgrades Service
 * Searches for healthcare providers on Healthgrades via Google (Serper.dev)
 *
 * Healthgrades is a major healthcare provider directory
 * - Contains practice information and employer details
 * - Shows current practice affiliations
 * - Often updated when providers change locations
 *
 * Uses Serper.dev API to search site:healthgrades.com
 */

const https = require('https');

class HealthgradesService {
  constructor() {
    this.apiKey = process.env.SERPER_API_KEY || '';
    this.configured = !!this.apiKey;
    this.apiEndpoint = 'google.serper.dev';

    if (this.configured) {
      console.log(`✓ Healthgrades Service configured (via Serper.dev)`);
    } else {
      console.log(`⚠ Healthgrades Service: Missing SERPER_API_KEY - Healthgrades checks disabled`);
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
   * Search for a provider's Healthgrades profile
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

    console.log(`    🔍 Healthgrades search for: "${cleanedName}"`);

    // Search Google for their Healthgrades profile
    const queries = [
      `"${cleanedName}" site:healthgrades.com optometrist`,
      `"${cleanedName}" site:healthgrades.com ophthalmologist`
    ];

    let bestProfile = null;

    for (const query of queries) {
      const data = await this.makeRequest(query, 5);

      if (data && data.organic) {
        for (const result of data.organic) {
          const link = result.link || '';
          // Must be a Healthgrades provider profile URL
          if (link.includes('healthgrades.com/') &&
              (link.includes('/optometrist/') || link.includes('/ophthalmologist/') || link.includes('/physician/'))) {
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
      console.log(`    ℹ️ No Healthgrades profile found`);
      return { found: false, reason: 'No Healthgrades profile found' };
    }

    console.log(`    ✅ Found Healthgrades: ${bestProfile.url}`);

    // Extract info from title/snippet
    const profileData = this.parseHealthgradesResult(bestProfile.title, bestProfile.snippet);

    return {
      found: true,
      profileUrl: bestProfile.url,
      profileTitle: bestProfile.title,
      profileSnippet: bestProfile.snippet,
      currentPractice: profileData.currentPractice,
      location: profileData.location,
      practices: profileData.practices
    };
  }

  /**
   * Parse Healthgrades search result for practice info
   * Healthgrades titles: "Dr. John Smith, OD | Optometrist in City, ST"
   * Snippets often contain practice names and locations
   */
  parseHealthgradesResult(title, snippet) {
    const result = {
      currentPractice: null,
      location: null,
      practices: []
    };

    // Extract location from title
    if (title) {
      const locMatch = title.match(/in\s+([A-Za-z\s]+),\s*([A-Z]{2})/i);
      if (locMatch) {
        result.location = `${locMatch[1].trim()}, ${locMatch[2].toUpperCase()}`;
      }
    }

    // Parse snippet for practice information
    if (snippet) {
      // Pattern: "practices at Practice Name"
      const practiceMatch = snippet.match(/(?:practices at|affiliated with|works at)\s+([A-Z][A-Za-z0-9\s&'.,-]{3,60}?)(?:\s+in|\s*[.,]|$)/i);
      if (practiceMatch) {
        const practice = practiceMatch[1].trim();
        result.currentPractice = practice;
        result.practices.push(practice);
      }

      // Pattern: "Office: Practice Name" or "Practice: Name"
      const officeMatch = snippet.match(/(?:Office|Practice|Location):\s*([A-Z][A-Za-z0-9\s&'.,-]{3,60}?)(?:\s*[.,|]|$)/i);
      if (officeMatch) {
        const practice = officeMatch[1].trim();
        if (!result.currentPractice) result.currentPractice = practice;
        if (!result.practices.includes(practice)) {
          result.practices.push(practice);
        }
      }

      // Look for eye care related business names
      const eyeCarePatterns = [
        /([A-Z][A-Za-z0-9\s&'.,-]*(?:Eye|Vision|Optical|Optometry|Ophthalmology)[A-Za-z0-9\s&'.,-]*)/gi,
        /([A-Z][A-Za-z0-9\s&'.,-]*(?:Clinic|Center|Associates|Group|Practice)[A-Za-z0-9\s&'.,-]*)/gi
      ];

      for (const pattern of eyeCarePatterns) {
        const matches = snippet.matchAll(pattern);
        for (const m of matches) {
          const practice = m[1].trim();
          if (practice.length > 5 && practice.length < 60 && !result.practices.includes(practice)) {
            result.practices.push(practice);
          }
        }
      }
    }

    return result;
  }

  /**
   * Check if Healthgrades profile mentions a client company
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

    // CHECK 1: Current practice match
    if (profileData.currentPractice) {
      const normPractice = normalize(profileData.currentPractice);
      for (const name of uniqueNames) {
        if (normPractice.includes(name) || name.includes(normPractice)) {
          return {
            match: true,
            matchType: 'current_practice',
            confidence: 'High',
            reason: `Healthgrades: Current practice "${profileData.currentPractice}" matches "${clientName}"`,
            practice: profileData.currentPractice,
            profileUrl: profileData.profileUrl
          };
        }
      }
    }

    // CHECK 2: Any listed practice
    if (profileData.practices && profileData.practices.length > 0) {
      for (const practice of profileData.practices) {
        const normPractice = normalize(practice);
        for (const name of uniqueNames) {
          if (normPractice.includes(name) || name.includes(normPractice)) {
            return {
              match: true,
              matchType: 'listed_practice',
              confidence: 'Medium',
              reason: `Healthgrades: Listed practice "${practice}" matches "${clientName}"`,
              practice: practice,
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
          reason: `Healthgrades: Profile mentions "${clientName}"`,
          practice: profileData.currentPractice,
          profileUrl: profileData.profileUrl
        };
      }
    }

    return { match: false };
  }
}

module.exports = HealthgradesService;
