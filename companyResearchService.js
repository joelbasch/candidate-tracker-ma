/**
 * Company Research Service
 * Researches parent companies, subsidiaries, and related business names
 * Uses web search and caches results
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

class CompanyResearchService {
  constructor() {
    this.cacheFile = path.join(__dirname, 'company-relationships.json');
    this.cache = this.loadCache();
    this.serperApiKey = process.env.SERPER_API_KEY;
    
    // Manual overrides - add known relationships here
    // Comprehensive list of eye care parent companies and their subsidiaries
    this.manualRelationships = {
      "EssilorLuxottica": [
        "essilor",
        "luxottica",
        "lenscrafters",
        "lens crafters",
        "pearle vision",
        "target optical",
        "sears optical",
        "sunglass hut",
        "oliver peoples",
        "persol",
        "ray-ban",
        "oakley",
        "eyemed",
        "grandvision",
        "for eyes",
        "vision express"
      ],
      "National Vision": [
        "america's best",
        "americas best",
        "america's best contacts",
        "eyeglass world",
        "vista optical",
        "vision center",
        "fred meyer optical",
        "walmart vision center"
      ],
      "MyEyeDr": [
        "my eye dr",
        "myeyedr",
        "my eye doctor",
        "clarkson eyecare",
        "svs vision",
        "vision source member"
      ],
      "EyeCare Partners": [
        "eyecare partners",
        "ecp",
        "eye care partners",
        "ecp vision"
      ],
      "US Vision": [
        "usvision",
        "us vision",
        "jcpenney optical",
        "jc penney optical",
        "boscov's optical",
        "boscovs optical",
        "meijer optical"
      ],
      "VSP Vision": [
        "vsp",
        "vsp vision",
        "vsp global",
        "marchon",
        "eyefinity",
        "altair eyewear",
        "visionworks"
      ],
      "Visionworks": [
        "vision works",
        "visionworks",
        "davis vision"
      ],
      "AEG Vision": [
        "AEG Vision*",
        "aeg vision",
        "aeg vision group",
        "total vision",
        "vision care associates"
      ],
      "EyeSouth Partners": [
        "eyesouth",
        "eye south",
        "eye south partners",
        "eyesouth partners"
      ],
      "TeamVision": [
        "team vision",
        "teamvision",
        "olympia vision clinic",
        "olympic vision"
      ],
      "American Vision Partners": [
        "avp",
        "american vision",
        "american vision partners",
        "avp eye"
      ],
      "Shopko Optical": [
        "shopko",
        "shopko optical"
      ],
      "Clarkson Eyecare": [
        "clarkson",
        "clarkson eye",
        "clarkson eyecare"
      ],
      "Warby Parker": [
        "warby",
        "warby parker"
      ],
      "Costco Optical": [
        "costco optical",
        "costco vision",
        "costco eye"
      ],
      "Sam's Club Optical": [
        "sam's club optical",
        "sams club optical",
        "sam's club vision"
      ],
      "BJ's Optical": [
        "bj's optical",
        "bjs optical"
      ],
      "Cohen's Fashion Optical": [
        "cohen's fashion optical",
        "cohens fashion optical",
        "cohens optical"
      ],
      "Eye Associates": [
        "eye associates",
        "eyecare associates",
        "eye care associates"
      ],
      "Sterling Optical": [
        "sterling optical",
        "sterling vision"
      ],
      "Site for Sore Eyes": [
        "site for sore eyes",
        "siteforsoreeyes"
      ],
      "Eyemart Express": [
        "eyemart express",
        "eyemart",
        "eye mart"
      ],
      "Stanton Optical": [
        "stanton optical",
        "my eyelab",
        "now optics"
      ],
      "Texas State Optical": [
        "tso",
        "texas state optical"
      ],
      "ACUITY Eyecare Group": [
        "acuity eyecare",
        "acuity eye",
        "acuity group"
      ],
      "Vision Source": [
        "vision source",
        "visionsource",
        "vision source member"
      ],
      "PECAA": [
        "pecaa",
        "professional eye care associates of america"
      ],
      "IDOC": [
        "idoc",
        "independent doctors of optometric care"
      ]
    };
  }

  loadCache() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data = fs.readFileSync(this.cacheFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (e) {
      console.log('Could not load company cache, starting fresh');
    }
    return {
      relationships: {},
      lastUpdated: {}
    };
  }

  saveCache() {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
    } catch (e) {
      console.error('Could not save company cache:', e.message);
    }
  }

  /**
   * Normalize company name for comparison
   */
  normalize(name) {
    if (!name) return '';
    return name.toLowerCase()
      .replace(/[*.,'"!?()&]/g, '')
      .replace(/\b(inc|llc|llp|corp|corporation|company|co|pc|pllc|md|od|dds|pa|psc)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Get all known aliases for a company (manual + cached)
   */
  getAliases(companyName) {
    const normalized = this.normalize(companyName);
    const aliases = new Set([normalized]);

    // Add manual relationships
    for (const [parent, subs] of Object.entries(this.manualRelationships)) {
      const normalizedParent = this.normalize(parent);
      
      // If this company is the parent, add all subsidiaries
      if (normalizedParent === normalized || this.normalize(parent) === normalized) {
        subs.forEach(s => aliases.add(this.normalize(s)));
        aliases.add(normalizedParent);
      }
      
      // If this company is a subsidiary, add the parent and siblings
      for (const sub of subs) {
        if (this.normalize(sub) === normalized) {
          aliases.add(normalizedParent);
          subs.forEach(s => aliases.add(this.normalize(s)));
        }
      }
    }

    // Add cached relationships
    if (this.cache.relationships[normalized]) {
      this.cache.relationships[normalized].forEach(r => aliases.add(this.normalize(r)));
    }

    return Array.from(aliases);
  }

  /**
   * Check if two company names are related
   */
  areCompaniesRelated(company1, company2) {
    const norm1 = this.normalize(company1);
    const norm2 = this.normalize(company2);

    if (!norm1 || !norm2) return false;

    // Direct match
    if (norm1 === norm2) return { match: true, reason: 'Direct match' };

    // Check if one contains the other (minimum 4 chars)
    if (norm1.length >= 4 && norm2.includes(norm1)) {
      return { match: true, reason: `"${company2}" contains "${company1}"` };
    }
    if (norm2.length >= 4 && norm1.includes(norm2)) {
      return { match: true, reason: `"${company1}" contains "${company2}"` };
    }

    // Check aliases
    const aliases1 = this.getAliases(company1);
    const aliases2 = this.getAliases(company2);

    for (const a1 of aliases1) {
      for (const a2 of aliases2) {
        if (a1 === a2 && a1.length >= 3) {
          return { match: true, reason: `Related companies: "${company1}" and "${company2}" share alias "${a1}"` };
        }
        // Partial match on significant words
        if (a1.length >= 5 && a2.includes(a1)) {
          return { match: true, reason: `"${a2}" contains alias "${a1}"` };
        }
        if (a2.length >= 5 && a1.includes(a2)) {
          return { match: true, reason: `"${a1}" contains alias "${a2}"` };
        }
      }
    }

    // Check for common significant words (at least 5 chars)
    const words1 = norm1.split(' ').filter(w => w.length >= 5);
    const words2 = norm2.split(' ').filter(w => w.length >= 5);
    
    for (const w1 of words1) {
      for (const w2 of words2) {
        if (w1 === w2) {
          return { match: true, reason: `Common word: "${w1}"` };
        }
      }
    }

    return { match: false, reason: null };
  }

  /**
   * IMPROVED: Check if two companies are related by searching for them together
   * This catches cases like "Abba Eye Care" being owned by "AEG Vision"
   * where the relationship isn't stated explicitly as "subsidiary of"
   */
  async checkCompanyRelationshipViaSearch(company1, company2) {
    if (!this.serperApiKey) {
      return { match: false, reason: 'No API key for web search' };
    }

    const norm1 = this.normalize(company1);
    const norm2 = this.normalize(company2);

    if (!norm1 || !norm2 || norm1.length < 3 || norm2.length < 3) {
      return { match: false, reason: 'Invalid company names' };
    }

    console.log(`    🔍 Searching for relationship: "${company1}" ↔ "${company2}"`);

    // METHOD 1: Direct co-occurrence search
    // If both names appear on the same page, they're likely related
    const coOccurrenceQuery = `"${company1}" "${company2}"`;
    const coOccurrenceResults = await this.makeSerperRequest(coOccurrenceQuery);

    if (coOccurrenceResults && coOccurrenceResults.organic && coOccurrenceResults.organic.length > 0) {
      // Check if results actually mention both companies meaningfully
      for (const result of coOccurrenceResults.organic) {
        const text = `${result.title || ''} ${result.snippet || ''}`.toLowerCase();

        // Skip results that are just search pages or directories
        if (result.link && (
          result.link.includes('google.com') ||
          result.link.includes('bing.com') ||
          result.link.includes('yellowpages') ||
          result.link.includes('yelp.com/search')
        )) continue;

        // Look for relationship indicators
        const relationshipIndicators = [
          'part of', 'member of', 'owned by', 'acquired', 'subsidiary',
          'joined', 'partnership', 'affiliate', 'location', 'practice',
          'welcome', 'team', 'staff', 'doctor', 'optometrist'
        ];

        const hasRelationshipContext = relationshipIndicators.some(ind => text.includes(ind));

        if (hasRelationshipContext) {
          console.log(`    ✅ Found co-occurrence: ${result.link}`);

          // Cache this relationship
          this.addRelationship(company2, company1);

          return {
            match: true,
            reason: `"${company1}" and "${company2}" appear together on: ${result.link}`,
            sourceUrl: result.link
          };
        }
      }
    }

    // METHOD 2: Check if company1 is on company2's website
    // E.g., if "Abba Eye Care" appears on aegvision.com
    const siteSearchQuery = `"${company1}" site:${this.extractDomain(company2)}`;
    const siteResults = await this.makeSerperRequest(siteSearchQuery);

    if (siteResults && siteResults.organic && siteResults.organic.length > 0) {
      console.log(`    ✅ Found "${company1}" on ${company2}'s website`);

      this.addRelationship(company2, company1);

      return {
        match: true,
        reason: `"${company1}" found on ${company2}'s website`,
        sourceUrl: siteResults.organic[0].link
      };
    }

    // METHOD 3: Search acquisition/press release news
    const acquisitionQuery = `"${company2}" acquisition OR acquired "${company1}"`;
    const acquisitionResults = await this.makeSerperRequest(acquisitionQuery);

    if (acquisitionResults && acquisitionResults.organic) {
      for (const result of acquisitionResults.organic) {
        const text = `${result.title || ''} ${result.snippet || ''}`.toLowerCase();

        if (text.includes('acqui') || text.includes('purchase') || text.includes('join') || text.includes('welcome')) {
          if (text.includes(norm1) || text.includes(company1.toLowerCase())) {
            console.log(`    ✅ Found acquisition news: ${result.link}`);

            this.addRelationship(company2, company1);

            return {
              match: true,
              reason: `Acquisition found: "${company2}" acquired "${company1}"`,
              sourceUrl: result.link
            };
          }
        }
      }
    }

    console.log(`    ℹ️ No relationship found between "${company1}" and "${company2}"`);
    return { match: false, reason: 'No relationship found via web search' };
  }

  /**
   * Extract likely domain from company name
   */
  extractDomain(companyName) {
    // Convert "AEG Vision" -> "aegvision.com"
    // Convert "MyEyeDr" -> "myeyedr.com"
    const cleaned = companyName.toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .substring(0, 30);
    return `${cleaned}.com`;
  }

  /**
   * Add a manual relationship
   */
  addRelationship(parentCompany, subsidiaryOrAlias) {
    const normalizedParent = this.normalize(parentCompany);
    
    if (!this.manualRelationships[parentCompany]) {
      this.manualRelationships[parentCompany] = [];
    }
    
    if (!this.manualRelationships[parentCompany].includes(subsidiaryOrAlias.toLowerCase())) {
      this.manualRelationships[parentCompany].push(subsidiaryOrAlias.toLowerCase());
    }

    // Also add to cache
    if (!this.cache.relationships[normalizedParent]) {
      this.cache.relationships[normalizedParent] = [];
    }
    
    const normalizedSub = this.normalize(subsidiaryOrAlias);
    if (!this.cache.relationships[normalizedParent].includes(normalizedSub)) {
      this.cache.relationships[normalizedParent].push(normalizedSub);
      this.saveCache();
    }
  }

  /**
   * Make a Serper API request
   */
  async makeSerperRequest(query) {
    if (!this.serperApiKey) {
      return null;
    }

    return new Promise((resolve) => {
      const postData = JSON.stringify({ q: query, num: 10 });

      const options = {
        hostname: 'google.serper.dev',
        port: 443,
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
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(null);
          }
        });
      });

      req.on('error', () => resolve(null));
      req.setTimeout(10000, () => {
        req.destroy();
        resolve(null);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Extract company names from search results
   */
  extractCompanyNames(searchResults, originalCompany) {
    const companies = new Set();
    const normalized = this.normalize(originalCompany);

    if (!searchResults) return [];

    // Common patterns to look for
    const parentPatterns = [
      /(?:owned by|subsidiary of|part of|acquired by|parent company[:\s]+)([A-Z][A-Za-z\s&']+(?:Inc|LLC|Corp|Company|Partners)?)/gi,
      /([A-Z][A-Za-z\s&']+(?:Inc|LLC|Corp|Company|Partners)?)\s+(?:owns|acquired|subsidiary|parent)/gi
    ];

    // Check organic results
    const results = [
      ...(searchResults.organic || []),
      ...(searchResults.answerBox ? [searchResults.answerBox] : [])
    ];

    for (const result of results) {
      const text = `${result.title || ''} ${result.snippet || ''} ${result.answer || ''}`;

      for (const pattern of parentPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const company = match[1].trim();
          const normalizedCompany = this.normalize(company);

          // Don't add the original company or very short names
          if (normalizedCompany !== normalized && company.length >= 3 && company.length <= 50) {
            companies.add(company);
          }
        }
      }
    }

    return Array.from(companies);
  }

  /**
   * Research a company using web search to find parent companies and subsidiaries
   */
  async researchCompany(companyName) {
    console.log(`  📊 Researching company: ${companyName}`);

    // Check if we've researched recently (within 7 days)
    const normalized = this.normalize(companyName);
    const lastUpdated = this.cache.lastUpdated[normalized];
    const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    if (lastUpdated && lastUpdated > weekAgo) {
      console.log(`    Using cached research from ${new Date(lastUpdated).toLocaleDateString()}`);
      return this.cache.relationships[normalized] || [];
    }

    // Start with manual relationships
    const aliases = new Set(this.getAliases(companyName));

    // Try web search if Serper API is available
    if (this.serperApiKey) {
      try {
        // Search for parent company
        console.log(`    Searching for parent company of "${companyName}"...`);
        const parentResults = await this.makeSerperRequest(`"${companyName}" parent company OR owned by`);
        const parentCompanies = this.extractCompanyNames(parentResults, companyName);

        if (parentCompanies.length > 0) {
          console.log(`    Found potential parent companies: ${parentCompanies.join(', ')}`);
          parentCompanies.forEach(p => aliases.add(this.normalize(p)));
        }

        // Search for subsidiaries
        console.log(`    Searching for subsidiaries of "${companyName}"...`);
        const subResults = await this.makeSerperRequest(`"${companyName}" subsidiaries OR owns OR acquired`);
        const subsidiaries = this.extractCompanyNames(subResults, companyName);

        if (subsidiaries.length > 0) {
          console.log(`    Found potential subsidiaries: ${subsidiaries.join(', ')}`);
          subsidiaries.forEach(s => aliases.add(this.normalize(s)));
        }

        // Save discovered relationships to cache
        if (parentCompanies.length > 0 || subsidiaries.length > 0) {
          if (!this.cache.relationships[normalized]) {
            this.cache.relationships[normalized] = [];
          }
          [...parentCompanies, ...subsidiaries].forEach(c => {
            const normalizedC = this.normalize(c);
            if (!this.cache.relationships[normalized].includes(normalizedC)) {
              this.cache.relationships[normalized].push(normalizedC);
            }
          });
        }
      } catch (e) {
        console.log(`    Web search failed: ${e.message}`);
      }
    } else {
      console.log(`    No Serper API key, using manual relationships only`);
    }

    // Update cache timestamp
    this.cache.lastUpdated[normalized] = Date.now();
    this.saveCache();

    return Array.from(aliases);
  }

  /**
   * Research multiple companies in parallel
   */
  async researchCompanies(companyNames) {
    const results = {};
    for (const name of companyNames) {
      results[name] = await this.researchCompany(name);
    }
    return results;
  }

  /**
   * Get all relationships for display/export
   */
  getAllRelationships() {
    return {
      manual: this.manualRelationships,
      cached: this.cache.relationships
    };
  }
}

module.exports = CompanyResearchService;
