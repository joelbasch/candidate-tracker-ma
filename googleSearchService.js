/**
 * Google Search Service (via Serper.dev) - ENHANCED
 *
 * Using Serper.dev instead of SerpAPI (2,500 free searches/month)
 *
 * Features:
 * - FIX: Local result URLs no longer return API URLs
 * - NEW: Page content scraping - actually reads top search result pages
 * - FIX: Name cleaning for parenthetical names like "Reuben Alexander (formerly Arunasalem)"
 * - NEW: More search queries for better coverage
 * - NEW: Fuzzy/partial company name matching
 */

const https = require('https');
const http = require('http');

class GoogleSearchService {
  constructor() {
    // Support both old SERPAPI keys (for migration) and new SERPER key
    this.apiKey = process.env.SERPER_API_KEY || process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY || '';
    this.apiEndpoint = 'google.serper.dev';

    if (this.apiKey) {
      console.log(`✓ Google Search Service configured (Serper.dev, key: ${this.apiKey.substring(0, 8)}...)`);
    } else {
      console.log(`⚠ Google Search Service: Missing SERPER_API_KEY env variable`);
    }
  }

  /**
   * Make a POST request to Serper.dev API
   */
  async makeRequest(query, numResults = 10) {
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
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            console.log(`    ⚠️ Failed to parse Serper response`);
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        console.log(`    ⚠️ Serper network error: ${err.message}`);
        resolve(null);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Fetch a web page's text content (for scraping search results)
   * Returns plain text extracted from the page, limited to first 5000 chars
   */
  async fetchPageContent(url, timeoutMs = 5000) {
    if (!url || url.includes('serper.dev') || url.includes('serpapi.com') || url.includes('google.com/search')) {
      return '';
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(''), timeoutMs);
      
      const protocol = url.startsWith('https') ? https : http;
      
      try {
        const req = protocol.get(url, { 
          headers: { 
            'User-Agent': 'Mozilla/5.0 (compatible; EyeToEyeBot/1.0)',
            'Accept': 'text/html'
          },
          timeout: timeoutMs 
        }, (res) => {
          // Follow redirects (up to 2)
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            clearTimeout(timer);
            this.fetchPageContent(res.headers.location, timeoutMs - 1000).then(resolve);
            return;
          }
          
          if (res.statusCode !== 200) {
            clearTimeout(timer);
            resolve('');
            return;
          }

          let data = '';
          res.on('data', chunk => {
            data += chunk;
            if (data.length > 100000) { // Stop reading after 100KB
              res.destroy();
            }
          });
          res.on('end', () => {
            clearTimeout(timer);
            // Strip HTML tags, scripts, styles, and extract text
            const text = data
              .replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&#\d+;/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .substring(0, 5000); // Keep first 5000 chars
            resolve(text);
          });
          res.on('error', () => { clearTimeout(timer); resolve(''); });
        });
        req.on('error', () => { clearTimeout(timer); resolve(''); });
        req.on('timeout', () => { req.destroy(); clearTimeout(timer); resolve(''); });
      } catch (e) {
        clearTimeout(timer);
        resolve('');
      }
    });
  }

  /**
   * Clean candidate name for searching
   * Handles parenthetical names, credentials, prefixes
   * "Reuben Alexander (formerly Arunasalem)" → ["Reuben Alexander", "Reuben Arunasalem"]
   * "John Smith, OD" → ["John Smith"]
   */
  cleanName(fullName) {
    if (!fullName) return [];
    
    let name = fullName.trim();
    const names = [];
    
    // Extract parenthetical content (former names, maiden names, etc.)
    const parenMatch = name.match(/\((?:formerly|née|nee|aka|born|maiden)\s+([^)]+)\)/i);
    const altName = parenMatch ? parenMatch[1].trim() : null;
    
    // Remove ALL parenthetical content from primary name
    name = name.replace(/\([^)]*\)/g, '').trim();
    
    // Remove credentials and suffixes (may be multiple, comma-separated)
    // First pass: remove known credential patterns from the end
    let changed = true;
    while (changed) {
      const before = name;
      name = name.replace(/,?\s*(OD|O\.D\.|MD|M\.D\.|DO|D\.O\.|DPM|DDS|DMD|PhD|Ph\.D\.|NP|PA|RN|APRN|FAAO|FCOVD|FCLSA|FNAP|MS|BS|BA|FACS)\s*$/i, '').trim();
      name = name.replace(/^Dr\.?\s+/i, '').trim();
      changed = name !== before;
    }
    
    // Clean up extra spaces/commas
    name = name.replace(/,\s*$/, '').replace(/\s+/g, ' ').trim();
    
    if (name.length > 2) {
      names.push(name);
    }
    
    // If there was a former/alt name, create an alternate search name
    if (altName) {
      // Use the first name from the primary name + the alt last name
      const primaryParts = name.split(/\s+/);
      const altParts = altName.replace(/,?\s*(OD|O\.D\.|MD|M\.D\.|DO|D\.O\.)\s*$/gi, '').trim().split(/\s+/);
      if (primaryParts.length > 0 && altParts.length > 0) {
        const altFullName = `${primaryParts[0]} ${altParts[altParts.length - 1]}`;
        names.push(altFullName);
      }
    }
    
    // Also try hyphenated name variations
    if (name.includes('-')) {
      const parts = name.split(/\s+/);
      const lastName = parts[parts.length - 1];
      if (lastName.includes('-')) {
        // Try each part of hyphenated last name
        const hyphenParts = lastName.split('-');
        for (const part of hyphenParts) {
          if (part.length > 2) {
            const altName2 = [...parts.slice(0, -1), part].join(' ');
            names.push(altName2);
          }
        }
      }
    }
    
    return [...new Set(names)];
  }

  /**
   * Search Google for a candidate name with professional suffixes
   * Now handles name variations and scrapes page content
   */
  async searchCandidate(fullName) {
    const results = {
      searches: [],
      allResults: [],
      links: [],
      pageContents: {} // NEW: url → page text content
    };

    // Get cleaned name variants
    const nameVariants = this.cleanName(fullName);
    if (nameVariants.length === 0) {
      console.log(`    ⚠️ Could not extract valid name from: "${fullName}"`);
      return results;
    }

    console.log(`    📝 Name variants to search: ${nameVariants.join(' | ')}`);

    // Build queries from name variants
    const queries = [];
    for (const name of nameVariants) {
      queries.push(`"${name}" OD optometrist`);
      queries.push(`"${name}" optometrist`);
    }
    // Deduplicate
    const uniqueQueries = [...new Set(queries)];

    for (const query of uniqueQueries) {
      try {
        console.log(`    🔎 Query: ${query}`);
        const searchResults = await this.performSearch(query);
        if (searchResults && searchResults.length > 0) {
          console.log(`    ✅ Got ${searchResults.length} result(s)`);
          results.searches.push({ query, resultCount: searchResults.length });
          for (const result of searchResults) {
            // Avoid duplicates
            if (!results.allResults.find(r => r.link === result.link)) {
              results.allResults.push(result);
              results.links.push(result.link);
            }
          }
        } else {
          console.log(`    ℹ️ No results for this query`);
        }
      } catch (e) {
        console.log(`    ⚠️ Serper error for "${query}": ${e.message}`);
      }
      // Rate limit between searches
      await new Promise(r => setTimeout(r, 500));
    }

    // PHASE 2: Scrape top search result pages for deeper content
    const pagesToScrape = results.allResults
      .filter(r => r.link && !r.link.includes('serper.dev') && !r.link.includes('serpapi.com') && !r.link.includes('google.com/search'))
      .slice(0, 5); // Scrape top 5 pages max

    if (pagesToScrape.length > 0) {
      console.log(`    📄 Scraping ${pagesToScrape.length} page(s) for deeper analysis...`);
      for (const result of pagesToScrape) {
        try {
          const pageText = await this.fetchPageContent(result.link);
          if (pageText && pageText.length > 50) {
            results.pageContents[result.link] = pageText;
            console.log(`       ✅ Scraped ${result.link.substring(0, 60)}... (${pageText.length} chars)`);
          }
        } catch (e) {
          // Silently skip failed pages
        }
      }
    }

    console.log(`    📊 Total unique results: ${results.allResults.length}, Pages scraped: ${Object.keys(results.pageContents).length}`);
    return results;
  }

  /**
   * Perform a single Google search via Serper.dev
   * FIXED: Local result URLs no longer return API URLs
   */
  async performSearch(query) {
    if (!this.apiKey) {
      console.log(`    ⚠️ Serper not configured (missing SERPER_API_KEY)`);
      return [];
    }

    const data = await this.makeRequest(query, 10);

    if (!data) {
      console.log(`    ⚠️ No response from Serper`);
      return [];
    }

    // Check for API errors
    if (data.error || data.message) {
      console.log(`    ❌ Serper Error: ${data.error || data.message}`);
      return [];
    }

    // Log search info
    if (data.searchParameters) {
      console.log(`    📈 Search completed for: "${data.searchParameters.q}"`);
    }

    const results = [];

    // Extract organic results (Serper uses 'organic' array)
    if (data.organic && data.organic.length > 0) {
      for (const item of data.organic) {
        results.push({
          title: item.title || '',
          snippet: item.snippet || '',
          link: item.link || '',
          displayLink: (() => { try { return item.link ? new URL(item.link).hostname : ''; } catch (e) { return ''; } })(),
          source: 'organic',
          position: item.position,
          date: item.date || null  // Serper sometimes returns publication date
        });
      }
    }

    // Extract places/local results (Serper uses 'places' array)
    if (data.places && data.places.length > 0) {
      for (const place of data.places) {
        const placeName = place.title || '';
        const placeAddr = place.address || '';
        const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(placeName + ' ' + placeAddr)}`;

        results.push({
          title: placeName,
          snippet: [place.type, placeAddr, place.phoneNumber].filter(Boolean).join(' - '),
          link: place.website || mapsUrl,
          displayLink: placeAddr || placeName,
          source: 'local_pack',
          localData: {
            address: placeAddr,
            phone: place.phoneNumber || '',
            type: place.type || '',
            rating: place.rating || null,
            ratingCount: place.ratingCount || null,
            website: place.website || '',
            latitude: place.latitude,
            longitude: place.longitude
          }
        });
      }
    }

    // Extract knowledge graph if present (Serper uses 'knowledgeGraph')
    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph;
      if (kg.title) {
        results.push({
          title: kg.title,
          snippet: kg.description || '',
          link: kg.website || kg.descriptionLink || '',
          displayLink: kg.website || '',
          source: 'knowledge_graph',
          kgData: {
            type: kg.type || '',
            imageUrl: kg.imageUrl || '',
            attributes: kg.attributes || {}
          }
        });
      }
    }

    return results;
  }

  /**
   * Check if any search results mention the client company or parent company
   * ENHANCED: Now also checks scraped page content for mentions
   */
  checkResultsForClient(searchResults, clientName, companyResearch) {
    if (!searchResults || !searchResults.allResults || searchResults.allResults.length === 0) {
      return { match: false };
    }

    const normalizeForSearch = (str) => {
      if (!str) return '';
      return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    };

    const normClient = normalizeForSearch(clientName);
    
    // Get all names to check against (client + all its subsidiaries)
    const namesToCheck = [normClient];
    
    // If companyResearch is available, get all related names
    if (companyResearch && typeof companyResearch.getAllRelationships === 'function') {
      try {
        const allRelationships = companyResearch.getAllRelationships();
        // getAllRelationships() returns { manual: { parent: [subs] }, cached: { parent: [subs] } }
        const processRelObject = (relObj) => {
          if (!relObj || typeof relObj !== 'object') return;
          for (const [parent, subs] of Object.entries(relObj)) {
            const normParent = normalizeForSearch(parent);
            const subsArray = Array.isArray(subs) ? subs : [];
            const isRelevant = normParent === normClient ||
              subsArray.some(s => normalizeForSearch(s) === normClient);
            if (isRelevant) {
              namesToCheck.push(normParent);
              for (const sub of subsArray) {
                namesToCheck.push(normalizeForSearch(sub));
              }
            }
          }
        };

        if (allRelationships && typeof allRelationships === 'object') {
          processRelObject(allRelationships.manual);
          processRelObject(allRelationships.cached);
        }
      } catch (e) {
        console.log(`    ⚠️ Error getting company relationships: ${e.message}`);
      }
    }

    // Remove duplicates and filter short names
    const uniqueNames = [...new Set(namesToCheck)].filter(n => n.length > 2);

    // CHECK 1: Search result titles and snippets (existing logic, enhanced)
    for (const result of searchResults.allResults) {
      const normTitle = normalizeForSearch(result.title);
      const normSnippet = normalizeForSearch(result.snippet);
      const normLink = normalizeForSearch(result.displayLink || result.link);
      const combined = `${normTitle} ${normSnippet} ${normLink}`;

      for (const checkName of uniqueNames) {
        // Full name match
        if (combined.includes(checkName)) {
          return {
            match: true,
            reason: `Google Search: "${result.title}" mentions "${clientName}"`,
            matchedResult: result,
            matchedText: result.title,
            sourceUrl: result.link
          };
        }

        // Multi-word company name: check if all significant words appear
        const words = checkName.split(' ').filter(w => w.length > 3);
        if (words.length >= 2) {
          const allWordsFound = words.every(w => combined.includes(w));
          if (allWordsFound) {
            return {
              match: true,
              reason: `Google Search: "${result.title}" references "${clientName}" (word match)`,
              matchedResult: result,
              matchedText: result.title,
              sourceUrl: result.link
            };
          }
        }
      }
    }

    // CHECK 2: Scraped page contents (NEW - much deeper matching)
    if (searchResults.pageContents && Object.keys(searchResults.pageContents).length > 0) {
      for (const [pageUrl, pageText] of Object.entries(searchResults.pageContents)) {
        const normPage = normalizeForSearch(pageText);
        
        for (const checkName of uniqueNames) {
          if (normPage.includes(checkName)) {
            // Found client name in page content!
            const matchingResult = searchResults.allResults.find(r => r.link === pageUrl);
            return {
              match: true,
              reason: `Google Search: Page content at "${pageUrl.substring(0, 60)}..." mentions "${clientName}"`,
              matchedResult: matchingResult || { title: pageUrl, link: pageUrl },
              matchedText: matchingResult?.title || pageUrl,
              sourceUrl: pageUrl,
              matchSource: 'page_content'
            };
          }
          
          // Multi-word check on page content too
          const words = checkName.split(' ').filter(w => w.length > 3);
          if (words.length >= 2) {
            const allWordsFound = words.every(w => normPage.includes(w));
            if (allWordsFound) {
              const matchingResult = searchResults.allResults.find(r => r.link === pageUrl);
              return {
                match: true,
                reason: `Google Search: Page at "${pageUrl.substring(0, 60)}..." references "${clientName}" (word match in page)`,
                matchedResult: matchingResult || { title: pageUrl, link: pageUrl },
                matchedText: matchingResult?.title || pageUrl,
                sourceUrl: pageUrl,
                matchSource: 'page_content'
              };
            }
          }
        }
      }
    }

    return { match: false };
  }
}

module.exports = GoogleSearchService;
