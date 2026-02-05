/**
 * LinkedIn Service - Enhanced with Serper.dev + US & Optometrist Filtering
 *
 * Uses Google Search (via Serper.dev) to find LinkedIn profiles and extract:
 * - Current employer / company
 * - Job title
 * - Location (MUST be in US)
 * - Title match (MUST be optometrist, optician, or related)
 *
 * FILTERING RULES:
 * 1. Profile must be US-based (location shows US state)
 * 2. Title must match optometrist, optician, OD, or related eye care roles
 */

const https = require('https');
const http = require('http');

class LinkedInService {
  constructor() {
    this.apiKey = process.env.SERPER_API_KEY || process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY || '';
    this.configured = !!this.apiKey;
    this.apiEndpoint = 'google.serper.dev';

    // US State abbreviations for location filtering
    this.usStates = new Set([
      'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
      'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
      'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
      'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
      'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
      'DC', 'PR'
    ]);

    // Valid job titles for optometry/eye care
    this.validTitles = [
      'optometrist', 'optician', 'od', 'o.d.', 'doctor of optometry',
      'eye doctor', 'vision', 'ophthalmologist', 'eye care',
      'optical', 'optometry', 'ocularist', 'orthoptist',
      'contact lens', 'dispensing optician', 'ophthalmic'
    ];

    if (this.configured) {
      console.log(`✓ LinkedIn Service configured (via Serper.dev) - US + Optometrist filtering enabled`);
    } else {
      console.log(`⚠ LinkedIn Service: Missing SERPER_API_KEY - LinkedIn checks disabled`);
    }
  }

  /**
   * Make a POST request to Serper.dev API
   */
  async makeRequest(query, numResults = 10) {
    return new Promise((resolve) => {
      const postData = JSON.stringify({
        q: query,
        num: numResults,
        gl: 'us' // Geo-locate to US for better US results
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
   * Fetch page content with timeout
   */
  async fetchPage(url, timeoutMs = 8000) {
    if (!url) return '';
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(''), timeoutMs);
      const protocol = url.startsWith('https') ? https : http;

      try {
        const req = protocol.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          timeout: timeoutMs
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            clearTimeout(timer);
            this.fetchPage(res.headers.location, timeoutMs - 2000).then(resolve);
            return;
          }
          if (res.statusCode !== 200) { clearTimeout(timer); resolve(''); return; }

          let data = '';
          res.on('data', chunk => {
            data += chunk;
            if (data.length > 200000) res.destroy();
          });
          res.on('end', () => {
            clearTimeout(timer);
            const text = data
              .replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
              .replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ')
              .trim().substring(0, 10000);
            resolve(text);
          });
          res.on('error', () => { clearTimeout(timer); resolve(''); });
        });
        req.on('error', () => { clearTimeout(timer); resolve(''); });
        req.on('timeout', () => { req.destroy(); clearTimeout(timer); resolve(''); });
      } catch (e) { clearTimeout(timer); resolve(''); }
    });
  }

  /**
   * Clean candidate name for LinkedIn search
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
   * Check if location indicates US-based
   * @returns {object} { isUS: boolean, location: string }
   */
  checkUSLocation(title, snippet) {
    const combined = `${title} ${snippet}`.toLowerCase();

    // Look for "City, ST" pattern where ST is a US state
    const statePatterns = [
      /([a-z\s]+),\s*([a-z]{2})\b/gi,
      /\b([a-z]{2})\s*,\s*(?:usa|united states|us)\b/gi
    ];

    for (const pattern of statePatterns) {
      const matches = combined.matchAll(pattern);
      for (const m of matches) {
        const possibleState = (m[2] || m[1]).toUpperCase();
        if (this.usStates.has(possibleState)) {
          return { isUS: true, location: m[0].trim() };
        }
      }
    }

    // Look for explicit US mentions
    if (combined.includes('united states') || combined.includes('usa') || /\bus\b/.test(combined)) {
      // Check it's not "us" as a pronoun by looking for state context
      for (const state of this.usStates) {
        if (combined.includes(`, ${state.toLowerCase()}`) || combined.includes(` ${state.toLowerCase()} `)) {
          return { isUS: true, location: state };
        }
      }
    }

    // Look for US city names followed by state patterns
    const usCities = ['new york', 'los angeles', 'chicago', 'houston', 'phoenix', 'philadelphia',
      'san antonio', 'san diego', 'dallas', 'san jose', 'austin', 'jacksonville', 'fort worth',
      'columbus', 'charlotte', 'seattle', 'denver', 'boston', 'atlanta', 'miami', 'portland'];

    for (const city of usCities) {
      if (combined.includes(city)) {
        return { isUS: true, location: city };
      }
    }

    return { isUS: false, location: null };
  }

  /**
   * Check if title matches optometrist/optician/eye care roles
   * @returns {object} { isValid: boolean, title: string }
   */
  checkValidTitle(title, snippet) {
    const combined = `${title} ${snippet}`.toLowerCase();

    for (const validTitle of this.validTitles) {
      if (combined.includes(validTitle)) {
        return { isValid: true, matchedTitle: validTitle };
      }
    }

    return { isValid: false, matchedTitle: null };
  }

  /**
   * Search for a candidate's LinkedIn profile via Serper.dev
   * APPLIES FILTERING: US-only + Optometrist titles only
   */
  async findProfile(fullName) {
    if (!this.configured) {
      return { found: false, reason: 'Serper not configured' };
    }

    const cleanedName = this.cleanName(fullName);
    if (!cleanedName) {
      return { found: false, reason: 'Could not parse name' };
    }

    console.log(`    🔍 LinkedIn search for: "${cleanedName}" (US + Optometrist filter)`);

    // Search Google for their LinkedIn profile - include optometrist to help filtering
    const queries = [
      `"${cleanedName}" site:linkedin.com/in optometrist`,
      `"${cleanedName}" site:linkedin.com/in OD optometry`
    ];

    let bestProfile = null;
    let filterReason = null;

    for (const query of queries) {
      const data = await this.makeRequest(query, 10);

      if (data && data.organic) {
        for (const result of data.organic) {
          const link = result.link || '';
          // Must be a LinkedIn profile URL (not company page, not post)
          if (!link.includes('linkedin.com/in/')) continue;

          const normTitle = (result.title || '');
          const normSnippet = (result.snippet || '');
          const nameParts = cleanedName.toLowerCase().split(' ');

          const firstName = nameParts[0];
          const lastName = nameParts[nameParts.length - 1];
          const combined = `${normTitle} ${normSnippet}`.toLowerCase();

          // Name must match
          if (!(combined.includes(firstName) && combined.includes(lastName))) continue;

          // FILTER 1: Check US location
          const locationCheck = this.checkUSLocation(normTitle, normSnippet);
          if (!locationCheck.isUS) {
            filterReason = `Filtered out: Location not confirmed as US`;
            continue;
          }

          // FILTER 2: Check title matches optometrist/optician
          const titleCheck = this.checkValidTitle(normTitle, normSnippet);
          if (!titleCheck.isValid) {
            filterReason = `Filtered out: Title doesn't match optometrist/optician`;
            continue;
          }

          // Passed all filters!
          bestProfile = {
            url: link,
            title: result.title || '',
            snippet: result.snippet || '',
            usLocation: locationCheck.location,
            matchedTitle: titleCheck.matchedTitle
          };
          break;
        }
      }

      if (bestProfile) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (!bestProfile) {
      console.log(`    ℹ️ No LinkedIn profile found${filterReason ? ` (${filterReason})` : ''}`);
      return { found: false, reason: filterReason || 'No LinkedIn profile found' };
    }

    console.log(`    ✅ Found LinkedIn: ${bestProfile.url}`);
    console.log(`       Location: ${bestProfile.usLocation} (US confirmed)`);
    console.log(`       Title match: ${bestProfile.matchedTitle}`);

    // Extract employer info from title/snippet
    const profileData = this.parseLinkedInTitle(bestProfile.title, bestProfile.snippet);

    // Also try to scrape the actual profile page for more data
    console.log(`    📄 Scraping LinkedIn profile page...`);
    const pageContent = await this.fetchPage(bestProfile.url);

    if (pageContent && pageContent.length > 100) {
      console.log(`       ✅ Got ${pageContent.length} chars from profile`);
      profileData.pageContent = pageContent;

      // Try to extract additional employer info from page content
      const pageEmployers = this.extractEmployersFromPage(pageContent);
      if (pageEmployers.length > 0) {
        profileData.allEmployers = [...new Set([...profileData.employers, ...pageEmployers])];
        console.log(`       🏢 Employers found: ${profileData.allEmployers.join(', ')}`);
      }
    } else {
      console.log(`       ⚠️ Could not scrape profile (LinkedIn may block bots)`);
      profileData.pageContent = '';
    }

    return {
      found: true,
      profileUrl: bestProfile.url,
      profileTitle: bestProfile.title,
      profileSnippet: bestProfile.snippet,
      currentEmployer: profileData.currentEmployer,
      currentTitle: profileData.currentTitle,
      employers: profileData.allEmployers || profileData.employers,
      pageContent: profileData.pageContent || '',
      usLocation: bestProfile.usLocation,
      matchedTitle: bestProfile.matchedTitle,
      raw: bestProfile
    };
  }

  /**
   * Parse LinkedIn title format: "Name - Title at Company | LinkedIn"
   */
  parseLinkedInTitle(title, snippet) {
    const result = {
      currentEmployer: null,
      currentTitle: null,
      employers: []
    };

    if (!title) return result;

    // Remove " | LinkedIn" or " - LinkedIn" suffix
    let clean = title.replace(/\s*[\|–-]\s*LinkedIn\s*$/i, '').trim();

    // Try pattern: "Name - Title at Company"
    const atMatch = clean.match(/[-–]\s*(.+?)\s+at\s+(.+)$/i);
    if (atMatch) {
      result.currentTitle = atMatch[1].trim();
      result.currentEmployer = atMatch[2].trim();
      result.employers.push(result.currentEmployer);
    }

    // Try pattern: "Name - Title - Company"
    if (!result.currentEmployer) {
      const dashParts = clean.split(/\s*[-–]\s*/);
      if (dashParts.length >= 3) {
        result.currentTitle = dashParts[1].trim();
        result.currentEmployer = dashParts[dashParts.length - 1].trim();
        result.employers.push(result.currentEmployer);
      }
    }

    // Parse snippet for additional employer mentions
    if (snippet) {
      // "Current: Title at Company" pattern
      const currentMatch = snippet.match(/(?:Current|Present)[:.]?\s*(.+?)\s+at\s+([^.·]+)/i);
      if (currentMatch) {
        const employer = currentMatch[2].trim();
        if (!result.currentEmployer) result.currentEmployer = employer;
        if (!result.employers.includes(employer)) result.employers.push(employer);
      }

      // "Previous: Title at Company" pattern
      const prevMatches = snippet.matchAll(/(?:Previous|Past|Former)[:.]?\s*(.+?)\s+at\s+([^.·]+)/gi);
      for (const m of prevMatches) {
        const employer = m[2].trim();
        if (!result.employers.includes(employer)) result.employers.push(employer);
      }

      // Also catch "Experience: Company1 · Company2" pattern
      const expMatch = snippet.match(/Experience[:.]?\s*([^.]+)/i);
      if (expMatch) {
        const companies = expMatch[1].split(/[·•,]/).map(c => c.trim()).filter(c => c.length > 2 && c.length < 50);
        for (const company of companies) {
          if (!result.employers.includes(company)) result.employers.push(company);
        }
      }
    }

    return result;
  }

  /**
   * Extract employer names from scraped LinkedIn page content
   */
  extractEmployersFromPage(pageContent) {
    if (!pageContent) return [];

    const employers = [];
    const text = pageContent;

    // Pattern: "at CompanyName" (common in LinkedIn)
    const atMatches = text.matchAll(/(?:at|@)\s+([A-Z][A-Za-z0-9\s&'.,-]{2,40})(?:\s|$|[·•|])/g);
    for (const m of atMatches) {
      const emp = m[1].trim().replace(/\s+/g, ' ');
      if (emp.length > 2 && emp.length < 50 && !employers.includes(emp)) {
        employers.push(emp);
      }
    }

    // Pattern: "Optometrist Company" or "OD Company"
    const titleMatches = text.matchAll(/(?:Optometrist|OD|O\.D\.|Doctor of Optometry|Eye Doctor)\s+(?:at\s+)?([A-Z][A-Za-z0-9\s&'.,-]{2,40})/gi);
    for (const m of titleMatches) {
      const emp = m[1].trim().replace(/\s+/g, ' ');
      if (emp.length > 2 && emp.length < 50 && !employers.includes(emp)) {
        employers.push(emp);
      }
    }

    return employers;
  }

  /**
   * Check if LinkedIn profile data mentions a specific client company
   */
  checkProfileForClient(profileData, clientName, companyResearch) {
    if (!profileData || !profileData.found) return { match: false };

    const normalize = (str) => {
      if (!str) return '';
      return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    };

    const normClient = normalize(clientName);

    // Build list of names to check (client + subsidiaries + parent companies)
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

    // CHECK 1: Current employer direct match
    if (profileData.currentEmployer) {
      const normEmployer = normalize(profileData.currentEmployer);
      for (const name of uniqueNames) {
        if (normEmployer.includes(name) || name.includes(normEmployer)) {
          return {
            match: true,
            matchType: 'current_employer',
            confidence: 'High',
            reason: `LinkedIn: Current employer "${profileData.currentEmployer}" matches "${clientName}"`,
            employer: profileData.currentEmployer,
            title: profileData.currentTitle,
            profileUrl: profileData.profileUrl,
            usLocation: profileData.usLocation
          };
        }
      }
    }

    // CHECK 2: Any listed employer matches
    if (profileData.employers && profileData.employers.length > 0) {
      for (const employer of profileData.employers) {
        const normEmployer = normalize(employer);
        for (const name of uniqueNames) {
          if (normEmployer.includes(name) || name.includes(normEmployer)) {
            const isCurrent = normalize(profileData.currentEmployer || '') === normEmployer;
            return {
              match: true,
              matchType: isCurrent ? 'current_employer' : 'past_employer',
              confidence: isCurrent ? 'High' : 'Medium',
              reason: `LinkedIn: ${isCurrent ? 'Current' : 'Listed'} employer "${employer}" matches "${clientName}"`,
              employer: employer,
              title: profileData.currentTitle,
              profileUrl: profileData.profileUrl,
              usLocation: profileData.usLocation
            };
          }
        }
      }
    }

    // CHECK 3: Full page content search (deepest check)
    if (profileData.pageContent) {
      const normPage = normalize(profileData.pageContent);
      for (const name of uniqueNames) {
        if (normPage.includes(name)) {
          return {
            match: true,
            matchType: 'page_mention',
            confidence: 'Medium',
            reason: `LinkedIn: Profile page content mentions "${clientName}"`,
            employer: profileData.currentEmployer,
            title: profileData.currentTitle,
            profileUrl: profileData.profileUrl,
            usLocation: profileData.usLocation
          };
        }

        // Multi-word fuzzy: all significant words appear
        const words = name.split(' ').filter(w => w.length > 3);
        if (words.length >= 2 && words.every(w => normPage.includes(w))) {
          return {
            match: true,
            matchType: 'page_mention_fuzzy',
            confidence: 'Medium',
            reason: `LinkedIn: Profile page references "${clientName}" (word match)`,
            employer: profileData.currentEmployer,
            title: profileData.currentTitle,
            profileUrl: profileData.profileUrl,
            usLocation: profileData.usLocation
          };
        }
      }
    }

    // CHECK 4: Title/snippet from search results
    const combinedText = normalize(`${profileData.profileTitle} ${profileData.profileSnippet}`);
    for (const name of uniqueNames) {
      if (combinedText.includes(name)) {
        return {
          match: true,
          matchType: 'search_snippet',
          confidence: 'Medium',
          reason: `LinkedIn: Search result for profile mentions "${clientName}"`,
          employer: profileData.currentEmployer,
          title: profileData.currentTitle,
          profileUrl: profileData.profileUrl,
          usLocation: profileData.usLocation
        };
      }
    }

    return { match: false };
  }
}

module.exports = LinkedInService;
