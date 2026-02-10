# Handoff Document - Candidate Tracker Session

## Date: February 10, 2026
## Branch: `claude/general-work-aDeNn`

## What Was Done This Session

### 1. Netrows API Integration (linkedinService.js)
- Integrated Netrows API for full LinkedIn profile data including employment history with dates
- Two-step approach: Google Search (Serper, free) finds LinkedIn URL → Netrows (100 free credits) gets full profile
- Falls back to Google snippet parsing if Netrows not configured
- API Key: `pk_live_3d735c548a4955433f4dd565b722c16e`

### 2. Reordered Monitoring Steps (monitoringScheduler.js)
- Changed from: Pipeline → NPI → LinkedIn → Google
- Changed to: **Pipeline → NPI → Google Search → LinkedIn**
- LinkedIn is SKIPPED if Google already found a match (saves Netrows credits)

### 3. Per-Candidate Client Enrichment (monitoringScheduler.js)
- Moved from upfront batch (all 26 clients scraped before any candidates) to lazy per-candidate with caching
- Each client is enriched on first encounter, cached for subsequent candidates
- Added junk domain filtering: skips indeed.com, instagram.com, zocdoc.com, yelp.com, etc.
- Cleaned up practice name extraction to reject garbage like "Get LASIK Pricing Does Cutarelli Vision"

### 4. Bug Fixes
- Fixed `getAllRelationships()` bug in linkedinService.js and googleSearchService.js (returns `{manual:[], cached:[]}` not array)
- Fixed Google page scraping: changed User-Agent from custom `EyeToEyeBot/1.0` to Chrome UA, increased timeout to 8s
- Added `date` field capture from Serper results
- Added `extractPageDates()` for date extraction from scraped pages

### 5. npiService.js
- User needed this file downloaded to get `getOrganizations()` (CMS Reassignment API)
- CMS Reassignment now working: `✓ CMS Reassignment dataset UUID: 20f51cff-...`

## User's API Keys
- **Serper (Google Search)**: `92df34822241944d6f3c59fb109c276c21af2758`
- **Netrows (LinkedIn profiles)**: `pk_live_3d735c548a4955433f4dd565b722c16e`

## User's Windows Setup
- No git installed, downloads files via curl from raw GitHub URLs
- Working folder: `C:\Users\User\Downloads\candidate-tracker-ma-claude-continue-windows-dev-OkEeR (7)\candidate-tracker-ma-claude-continue-windows-dev-OkEeR\`
- Update process (user knows these commands):
  ```
  set U=https://raw.githubusercontent.com/joelbasch/candidate-tracker-ma/claude/general-work-aDeNn
  curl -o linkedinService.js %U%/linkedinService.js
  curl -o monitoringScheduler.js %U%/monitoringScheduler.js
  curl -o googleSearchService.js %U%/googleSearchService.js
  curl -o npiService.js %U%/npiService.js
  ```
- Start server:
  ```
  set SERPER_API_KEY=92df34822241944d6f3c59fb109c276c21af2758
  set NETROWS_API_KEY=pk_live_3d735c548a4955433f4dd565b722c16e
  node server.js
  ```
- Clear database: `Invoke-WebRequest -Method POST -Uri http://localhost:3001/api/clear-all` (in PowerShell)

## Known Issues That NEED FIXING (Priority Order)

### 1. "Vision" False Positive in Company Matching (CRITICAL)
- `companyResearchService.areCompaniesRelated()` matches on generic words like "vision", "eyecare", "services", "optometry" (5+ chars)
- Example: "Boulder Vision Associates" falsely matched "Cutarelli Vision" because both contain "vision"
- Richard A. Cross got a wrong NPI alert due to this
- Fix: The `areCompaniesRelated()` method needs a stopwords list to exclude generic industry terms

### 2. Netrows Returns Empty Employment History
- Every profile returns `"0 positions in history"`
- The profile is found, full name and current employer come through, but `employmentHistory` array is empty
- Need to debug: log the raw Netrows API response to see what fields it actually returns
- The `parseNetrowsProfile()` method checks many field names but might be missing the actual one Netrows uses
- This makes LinkedIn matching almost useless since it can only match current employer, not history

### 3. Google Page Scraping Still Failing (Pages scraped: 0)
- Despite fixing User-Agent and timeout, most pages still return empty
- The scraping happens (`Scraping 5 page(s)...`) but `Pages scraped: 0`
- Likely cause: many sites use JavaScript rendering (React/SPA) so the raw HTML has no content
- The one success was a simple static site (lhvc.com)
- Consider: only scrape pages that are likely static (news sites, practice websites), skip SPAs

### 4. LinkedIn Middle Name Problem
- "Christopher Inman Clark" → searches for exact "Christopher Inman Clark" on LinkedIn → finds nothing
- Should also try without middle name: "Christopher Clark"
- Fix: in `linkedinService.cleanName()` or `findProfile()`, generate a variant without middle name(s)

### 5. NPI Name Selection with Common Names
- "Christopher Clark" returned 50 matches, picked the first one which may be wrong
- The current logic picks the first optometry-related result, but with 50 matches this is unreliable
- Could improve by cross-referencing with the candidate's known location/state from the submission

## What User Wants Next
- User explicitly said: **"I want you to remember there's workflow - I'm going to come back to it later. Before we start automating I need to make sure that the backend is working properly."**
- Focus is on fixing the backend accuracy issues above before any automation
- Future plans include: scheduling, CRM integration (Loxo), multi-tenant SaaS, mass automation
- User wants this to work for ANY industry, not just eye care (important for future)

## Files Modified This Session
| File | Changes |
|------|---------|
| `linkedinService.js` | Netrows integration, getAllRelationships fix, scoring system |
| `monitoringScheduler.js` | Reorder Google before LinkedIn, per-candidate enrichment, junk domain filter, practice name cleanup, date extraction |
| `googleSearchService.js` | getAllRelationships fix, date field, browser User-Agent, 8s timeout |
| `npiService.js` | No code changes, but user needed to download the version with getOrganizations |
| `update.js` | Helper script (can be deleted, user now uses curl commands) |

## Architecture Reminder
- Node.js/Express backend, React 18 frontend (CDN, Babel standalone)
- JSON file-based DB (`tracker-data.json`)
- Frontend alert source filtering uses EXACT string matching:
  - Pipeline: `source.includes('Pipeline')`
  - NPI: catch-all (not Pipeline, not 'Google Search', not 'LinkedIn')
  - Google Search: `source === 'Google Search'`
  - LinkedIn: `source === 'LinkedIn'`
