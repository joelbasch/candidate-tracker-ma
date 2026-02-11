/**
 * Company Research Service
 * Researches parent companies, subsidiaries, and related business names
 * Uses web search and caches results
 */

const fs = require('fs');
const path = require('path');

class CompanyResearchService {
  constructor() {
    this.cacheFile = path.join(__dirname, 'company-relationships.json');
    this.cache = this.loadCache();
    
    // Manual overrides - add known relationships here
    this.manualRelationships = {
      "AEG Vision": [
        "AEG Vision*",
        "aeg vision",
        "eyecare associates",
        "vision source"
      ],
      "TeamVision": [
        "team vision",
        "teamvision",
        "olympia vision clinic",
        "olympic vision"
      ],
      "EyeSouth Partners": [
        "eyesouth",
        "eye south",
        "eye south partners"
      ],
      "MyEyeDr": [
        "my eye dr",
        "myeyedr",
        "my eye doctor"
      ],
      "National Vision": [
        "america's best",
        "eyeglass world",
        "vista optical",
        "vision center"
      ],
      "Warby Parker": [
        "warby",
        "warby parker"
      ],
      "LensCrafters": [
        "lenscrafters",
        "lens crafters",
        "luxottica"
      ],
      "Visionworks": [
        "vision works",
        "visionworks"
      ],
      "US Vision": [
        "usvision",
        "us vision",
        "jcpenney optical",
        "boscov's optical"
      ],
      "EssilorLuxottica": [
        "essilor",
        "luxottica",
        "lenscrafters",
        "pearle vision",
        "target optical",
        "sears optical",
        "sunglass hut"
      ],
      "VSP Vision": [
        "vsp",
        "vsp vision",
        "marchon",
        "eyefinity"
      ],
      "American Vision Partners": [
        "avp",
        "american vision"
      ],
      "Shopko Optical": [
        "shopko",
        "shopko optical",
        "shoptikal"
      ],
      "Clarkson Eyecare": [
        "clarkson",
        "clarkson eye"
      ],
      "EyeCare Partners": [
        "eyecare partners",
        "ecp"
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
   * Generic industry words that should NOT trigger a match on their own.
   * These are too common in eye care company names.
   */
  get stopWords() {
    return new Set([
      'vision', 'eye', 'eyecare', 'optical', 'optic', 'optics',
      'optometry', 'ophthalmology', 'health', 'healthcare',
      'medical', 'center', 'clinic', 'associates', 'group',
      'services', 'partners', 'family', 'professional', 'professionals',
      'primary', 'practice', 'care', 'doctors', 'physician', 'physicians',
      'wellness', 'institute', 'regional', 'national', 'american',
      'advanced', 'premier', 'total', 'complete', 'general',
      'north', 'south', 'east', 'west', 'street', 'cherry'
    ]);
  }

  /**
   * Check if two company names are related
   */
  areCompaniesRelated(company1, company2) {
    const norm1 = this.normalize(company1);
    const norm2 = this.normalize(company2);

    if (!norm1 || !norm2) return { match: false, reason: null };

    // Direct match
    if (norm1 === norm2) return { match: true, reason: 'Direct match' };

    // Check if one fully contains the other (minimum 6 chars to avoid short substring false positives)
    if (norm1.length >= 6 && norm2.includes(norm1)) {
      return { match: true, reason: `"${company2}" contains "${company1}"` };
    }
    if (norm2.length >= 6 && norm1.includes(norm2)) {
      return { match: true, reason: `"${company1}" contains "${company2}"` };
    }

    // Check aliases (from manual relationships and cache only — high confidence)
    const aliases1 = this.getAliases(company1);
    const aliases2 = this.getAliases(company2);

    for (const a1 of aliases1) {
      for (const a2 of aliases2) {
        if (a1 === a2 && a1.length >= 3) {
          return { match: true, reason: `Related companies: "${company1}" and "${company2}" share alias "${a1}"` };
        }
      }
    }

    // Check for common significant words — EXCLUDE generic industry stop words
    // Require at least 2 matching non-stop words, OR 1 very distinctive word (>= 8 chars)
    const stopWords = this.stopWords;
    const words1 = norm1.split(' ').filter(w => w.length >= 4 && !stopWords.has(w));
    const words2 = norm2.split(' ').filter(w => w.length >= 4 && !stopWords.has(w));

    if (words1.length > 0 && words2.length > 0) {
      const matchingWords = words1.filter(w1 => words2.some(w2 => w1 === w2));

      if (matchingWords.length >= 2) {
        return { match: true, reason: `Common words: "${matchingWords.join('", "')}"` };
      }
      if (matchingWords.length === 1 && matchingWords[0].length >= 8) {
        return { match: true, reason: `Distinctive common word: "${matchingWords[0]}"` };
      }
    }

    return { match: false, reason: null };
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
   * Research a company using web search (placeholder for future implementation)
   * This would use a web search API to find parent companies and subsidiaries
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

    // For now, return manual relationships
    // In the future, this could use a web search API like:
    // - Google Custom Search API
    // - Bing Search API
    // - SerpAPI
    // To search for "{companyName} subsidiaries" or "{companyName} parent company"
    
    const aliases = this.getAliases(companyName);
    
    // Update cache timestamp
    this.cache.lastUpdated[normalized] = Date.now();
    this.saveCache();
    
    return aliases;
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
