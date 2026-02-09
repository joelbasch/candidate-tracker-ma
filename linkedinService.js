/**
 * LinkedIn Service - Enhanced with Serper.dev
 *
 * Uses Google Search (via Serper.dev - 2,500 free searches/month) to find LinkedIn profiles and extract:
 * - Current employer / company
 * - Job title
 * - Whether they recently changed jobs
 * - Whether their profile mentions the client company
 *
 * Also scrapes the LinkedIn profile page for deeper content analysis.
 */

const https = require('https');
const http = require('http');

class LinkedInService {
  constructor() {
    // Support both old SERPAPI keys (for migration) and new SERPER key
    this.apiKey = process.env.SERPER_API_KEY || process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY || '';
    this.configured = !!this.apiKey;
    this.apiEndpoint = 'google.serper.dev';

    if (this.configured) {
      console.log(`✓ LinkedIn Service configured (via Serper.dev)`);
    } else {
      console.log(`⚠ LinkedIn Service: Missing SERPER_API_KEY - LinkedIn checks disabled`);
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
   * Check if a LinkedIn URL slug matches the candidate name
   * e.g., "linkedin.com/in/erik-belcarz-0793a9b0" should match "Erik Belcarz"
   * but "linkedin.com/in/bonnie-barrett-aa60b71a4" should NOT match "Kenneth Minarik"
   */
  urlMatchesName(url, cleanedName) {
    if (!url || !cleanedName) return false;

    try {
      // Extract the slug from the URL: "/in/erik-belcarz-0793a9b0" → "erik-belcarz"
      const match = url.match(/linkedin\.com\/in\/([^/?]+)/);
      if (!match) return false;

      // Remove trailing hash/numbers (e.g., "-0793a9b0", "-aa60b71a4")
      const slug = match[1].toLowerCase().replace(/-[a-f0-9]{6,}$/, '').replace(/-\d+$/, '');
      const slugParts = slug.split('-').filter(p => p.length > 1);

      const nameParts = cleanedName.toLowerCase().split(/\s+/);
      const firstName = nameParts[0];
      const lastName = nameParts[nameParts.length - 1];

      // At minimum, last name must appear in the URL slug
      const lastNameInSlug = slugParts.some(p => p === lastName || lastName.startsWith(p) || p.startsWith(lastName));
      if (!lastNameInSlug) return false;

      // First name should also appear (or a reasonable abbreviation)
      const firstNameInSlug = slugParts.some(p => p === firstName || firstName.startsWith(p) || p.startsWith(firstName));

      return firstNameInSlug;
    } catch (e) {
      return false;
    }
  }

  /**
   * Check if title/snippet indicates an optometrist or eye care professional
   */
  isOptometristProfile(title, snippet) {
    const combined = `${title || ''} ${snippet || ''}`.toLowerCase();
    const keywords = [
      'optometrist', 'optometry', 'o.d.', ' od ', 'od,', 'od |', 'od-',
      'doctor of optometry', 'eye doctor', 'eye care', 'eyecare',
      'ophthalmolog', 'vision', 'optical'
    ];
    return keywords.some(kw => combined.includes(kw));
  }

  /**
   * Check if profile appears to be US-based
   */
  isUSProfile(url, title, snippet) {
    // Non-US LinkedIn domains indicate non-US profiles
    const nonUSPatterns = /^https?:\/\/(ca|uk|au|in|de|fr|it|br|mx|es|nl|be|ch|at|ie|nz|sg|hk|jp)\./i;
    if (nonUSPatterns.test(url)) return false;

    // Check for US location indicators in snippet
    const combined = `${title || ''} ${snippet || ''}`.toLowerCase();
    const usStates = [
      'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
      'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
      'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
      'minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire',
      'new jersey','new mexico','new york','north carolina','north dakota','ohio',
      'oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota',
      'tennessee','texas','utah','vermont','virginia','washington','west virginia',
      'wisconsin','wyoming','district of columbia'
    ];
    // 2-letter state codes at word boundaries
    const stateAbbrevs = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;

    // Check for US state names or major US cities
    const hasUSState = usStates.some(s => combined.includes(s));
    const hasStateAbbrev = stateAbbrevs.test(`${title || ''} ${snippet || ''}`);
    const usCities = ['new york', 'los angeles', 'chicago', 'houston', 'phoenix', 'san antonio',
      'san diego', 'dallas', 'san jose', 'austin', 'jacksonville', 'columbus', 'charlotte',
      'indianapolis', 'seattle', 'denver', 'boston', 'nashville', 'portland', 'las vegas',
      'atlanta', 'miami', 'minneapolis', 'tampa', 'orlando', 'st. louis', 'pittsburgh',
      'sacramento', 'detroit', 'cleveland', 'salt lake'];
    const hasUSCity = usCities.some(c => combined.includes(c));

    // www.linkedin.com (no country prefix) is likely US
    const isWWW = /^https?:\/\/www\.linkedin\.com/i.test(url);

    return hasUSState || hasStateAbbrev || hasUSCity || isWWW;
  }

  /**
   * Score a LinkedIn search result for how well it matches the candidate
   * Higher score = better match
   */
  scoreResult(result, cleanedName) {
    const url = result.link || '';
    const title = result.title || '';
    const snippet = result.snippet || '';
    let score = 0;

    // URL name match (critical - prevents wrong-person matches like bonnie-barrett)
    if (this.urlMatchesName(url, cleanedName)) {
      score += 30;
    } else {
      // If URL doesn't match the name, this is very likely the wrong person
      return -1;
    }

    // Title name match (name should appear in the title, not just snippet)
    const normTitle = title.toLowerCase();
    const nameParts = cleanedName.toLowerCase().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts[nameParts.length - 1];
    if (normTitle.includes(firstName) && normTitle.includes(lastName)) {
      score += 20;
    }

    // Optometrist indicators
    if (this.isOptometristProfile(title, snippet)) {
      score += 25;
    }

    // US location
    if (this.isUSProfile(url, title, snippet)) {
      score += 15;
    }

    // Penalize non-US domains
    if (/^https?:\/\/(ca|uk|au|in|de|fr|it)\./i.test(url)) {
      score -= 10;
    }

    return score;
  }

  /**
   * Search for a candidate's LinkedIn profile via Serper.dev
   * Uses multi-criteria scoring: URL name match + optometrist + US location
   * Returns profile URL, current employer, title
   */
  async findProfile(fullName) {
    if (!this.configured) {
      return { found: false, reason: 'Serper not configured' };
    }

    const cleanedName = this.cleanName(fullName);
    if (!cleanedName) {
      return { found: false, reason: 'Could not parse name' };
    }

    console.log(`    🔍 LinkedIn search for: "${cleanedName}"`);

    // Collect ALL candidate profiles across multiple queries
    const allCandidates = new Map(); // url → { result, score }

    const queries = [
      `"${cleanedName}" site:linkedin.com/in optometrist`,
      `"${cleanedName}" site:linkedin.com/in OD`
    ];

    for (const query of queries) {
      const data = await this.makeRequest(query, 10);

      if (data && data.organic) {
        for (const result of data.organic) {
          const link = result.link || '';
          if (!link.includes('linkedin.com/in/')) continue;

          // Skip if we've already seen this URL
          if (allCandidates.has(link)) continue;

          const score = this.scoreResult(result, cleanedName);

          // Skip results with negative score (URL doesn't match name)
          if (score < 0) continue;

          allCandidates.set(link, {
            result: {
              url: link,
              title: result.title || '',
              snippet: result.snippet || '',
              displayLink: new URL(link).hostname
            },
            score
          });
        }
      }

      await new Promise(r => setTimeout(r, 500));
    }

    if (allCandidates.size === 0) {
      console.log(`    ℹ️ No LinkedIn results found for "${cleanedName}"`);
      return { found: false, reason: 'No LinkedIn profile found' };
    }

    // Log filtering stats
    const candidates = Array.from(allCandidates.values());
    const nameMatches = candidates.length;
    const usProfiles = candidates.filter(c => this.isUSProfile(c.result.url, c.result.title, c.result.snippet)).length;
    const optProfiles = candidates.filter(c => this.isOptometristProfile(c.result.title, c.result.snippet)).length;
    console.log(`    📋 Found ${nameMatches} LinkedIn results, filtering...`);
    console.log(`    📊 Filter stats: ${nameMatches} name match, ${usProfiles} US, ${optProfiles} optometrist`);

    // Sort by score (highest first) and pick the best
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // Require minimum score to accept
    if (best.score < 20) {
      console.log(`    ℹ️ No suitable LinkedIn profile found after filtering`);
      return { found: false, reason: 'No profile met quality threshold' };
    }

    const bestProfile = best.result;

    // Log match quality
    if (best.score >= 70) {
      console.log(`    ✅ Best match: US + Optometrist confirmed`);
    } else if (best.score >= 45) {
      const isOpt = this.isOptometristProfile(bestProfile.title, bestProfile.snippet);
      const isUS = this.isUSProfile(bestProfile.url, bestProfile.title, bestProfile.snippet);
      if (isOpt && !isUS) console.log(`    ⚠️ Best match: Optometrist title, location not confirmed as US`);
      else if (!isOpt && isUS) console.log(`    ⚠️ Best match: US location, title not confirmed as optometrist`);
      else console.log(`    ⚠️ Best match: Partial confidence (score: ${best.score})`);
    } else {
      console.log(`    ⚠️ Best match: Low confidence (score: ${best.score})`);
    }

    console.log(`    ✅ Found LinkedIn: ${bestProfile.url}`);

    // Extract employer info from the Google search result title/snippet
    const profileData = this.parseLinkedInTitle(bestProfile.title, bestProfile.snippet);

    if (profileData.currentEmployer) {
      console.log(`     🏢 Employer: ${profileData.currentEmployer}`);
    }

    return {
      found: true,
      profileUrl: bestProfile.url,
      profileTitle: bestProfile.title,
      profileSnippet: bestProfile.snippet,
      currentEmployer: profileData.currentEmployer,
      currentTitle: profileData.currentTitle,
      employers: profileData.allEmployers || profileData.employers,
      matchScore: best.score,
      pageContent: '',
      raw: bestProfile
    };
  }

  /**
   * Parse LinkedIn title format: "Name - Title at Company | LinkedIn"
   * Also handles: "Name - Title - Company | LinkedIn"
   * And snippet which often has: "Current: Optometrist at Company. Previous: ..."
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
   * Looks for patterns like "at Company", "Experience Company", etc.
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
   * Uses direct matching, fuzzy matching, and parent company relationships
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
    
    if (companyResearch && typeof companyResearch.getAllRelationships === 'function') {
      try {
        const allRels = companyResearch.getAllRelationships();
        if (Array.isArray(allRels)) {
          for (const rel of allRels) {
            const normParent = normalize(rel.parent);
            const isRelevant = normParent === normClient ||
              (rel.subsidiaries || []).some(s => normalize(s) === normClient);
            if (isRelevant) {
              namesToCheck.push(normParent);
              for (const sub of (rel.subsidiaries || [])) {
                namesToCheck.push(normalize(sub));
              }
            }
          }
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
            profileUrl: profileData.profileUrl
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
              profileUrl: profileData.profileUrl
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
            profileUrl: profileData.profileUrl
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
            profileUrl: profileData.profileUrl
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
          profileUrl: profileData.profileUrl
        };
      }
    }

    return { match: false };
  }
}

module.exports = LinkedInService;
