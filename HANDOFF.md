# Handoff Document - Candidate Tracker

## Date: February 10, 2026
## Branch: `claude/general-work-aDeNn`

## What Has Been Done (All Sessions)

### Session 1: Core Integration
1. **Netrows API Integration** (linkedinService.js)
   - Two-step LinkedIn: Serper (free) finds URL → Netrows (100 credits) gets full profile
   - Falls back to Google snippet parsing if Netrows not configured
2. **Reordered Monitoring** (monitoringScheduler.js)
   - Pipeline → NPI → Google Search → LinkedIn (Google before LinkedIn to save Netrows credits)
   - LinkedIn SKIPPED if Google already matched
3. **Per-Candidate Client Enrichment** (monitoringScheduler.js)
   - Lazy per-candidate with caching (not upfront batch)
   - Junk domain filtering (indeed, instagram, zocdoc, etc.)
   - Practice name extraction with junk word filter
4. **Bug Fixes**
   - `getAllRelationships()` returns object not array → fixed in LinkedIn + Google services
   - Google page scraping User-Agent changed from `EyeToEyeBot/1.0` to Chrome UA, timeout 8s
   - Date extraction from Serper results and scraped pages
   - User needed npiService.js with `getOrganizations()` for CMS Reassignment API

### Session 2: Accuracy Fixes
1. **Company Matching False Positives FIXED** (companyResearchService.js)
   - Added 50+ stopwords to `areCompaniesRelated()` common-word matching
   - Stops generic terms like "vision", "eyecare", "associates", "optical", "services" from causing matches
   - Fixes: "Boulder Vision Associates" no longer falsely matches "Cutarelli Vision"
2. **LinkedIn Middle Name Problem FIXED** (linkedinService.js)
   - `findProfile()` now generates name variants without middle names
   - "Christopher Inman Clark" also tries "Christopher Clark"
   - Scoring still uses full name for URL validation
3. **Netrows Debugging Added** (linkedinService.js)
   - `getFullProfile()` now logs raw response structure (keys, array sizes, first elements)
   - Will show `📦 Netrows raw keys: ...` in console output
   - Need user to run and share output so we can map actual Netrows field names

## User's API Keys
- **Serper (Google Search)**: `92df34822241944d6f3c59fb109c276c21af2758`
- **Netrows (LinkedIn profiles)**: `pk_live_3d735c548a4955433f4dd565b722c16e`

## User's Windows Setup
- No git installed, downloads files via curl from raw GitHub URLs
- Working folder: `C:\Users\User\Downloads\candidate-tracker-ma-claude-continue-windows-dev-OkEeR (7)\candidate-tracker-ma-claude-continue-windows-dev-OkEeR\`
- Download files:
  ```
  set U=https://raw.githubusercontent.com/joelbasch/candidate-tracker-ma/claude/general-work-aDeNn
  curl -o companyResearchService.js %U%/companyResearchService.js
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
- Clear database (PowerShell): `Invoke-WebRequest -Method POST -Uri http://localhost:3001/api/clear-all`
- Run monitoring (PowerShell): `Invoke-WebRequest -Method POST -Uri http://localhost:3001/api/monitoring/run`

## Known Issues Still Open (Priority Order)

### 1. Netrows Returns Empty Employment History
- Every profile returns `"0 positions in history"`
- Profile is found (full name, current employer work), but `employmentHistory` array is empty
- **Raw response logging was added** - next run will show `📦 Netrows raw keys: ...` with actual field names
- `parseNetrowsProfile()` checks many field name variants but may be missing the one Netrows uses
- Once user shares the raw keys output, fix the field name mapping in `parseNetrowsProfile()`

### 2. Google Page Scraping Still Failing (Pages scraped: 0)
- Most pages return empty despite Chrome UA and 8s timeout
- Cause: JS-rendered sites (React/SPA) have no content in raw HTML
- Only static sites work (e.g., lhvc.com)
- Consider: skip SPA-heavy sites, or use Serper's snippet data instead of scraping

### 3. NPI Common Name Matching
- "Christopher Clark" returned 50 matches, picks first optometry-related one
- Could be wrong person
- Improve by cross-referencing with candidate's known location/state from submission data

## What User Wants Next
- **"Before we start automating I need to make sure that the backend is working properly."**
- User needs to run monitoring with the new fixes and check:
  1. Are the "vision" false positives gone?
  2. What does the Netrows raw response look like? (📦 lines in console)
  3. Do middle-name candidates now find LinkedIn profiles?
- Future: scheduling, Loxo CRM integration, multi-tenant SaaS
- Must work for ANY industry, not just eye care

## Files Modified (All Sessions)
| File | Changes |
|------|---------|
| `companyResearchService.js` | Stopwords in areCompaniesRelated() to prevent false positives |
| `linkedinService.js` | Netrows integration, middle name variants, raw response logging, scoring system |
| `monitoringScheduler.js` | Reorder Google→LinkedIn, per-candidate enrichment, junk domains, practice name cleanup, date extraction |
| `googleSearchService.js` | getAllRelationships fix, date field, Chrome User-Agent, 8s timeout |
| `npiService.js` | No code changes (user needed version with getOrganizations) |
| `update.js` | Helper script (can be deleted, user uses curl commands) |

## Architecture Reminder
- Node.js/Express backend, React 18 frontend (CDN, Babel standalone)
- JSON file-based DB (`tracker-data.json`)
- Frontend alert source filtering uses EXACT string matching:
  - Pipeline: `source.includes('Pipeline')`
  - NPI: catch-all (not Pipeline, not 'Google Search', not 'LinkedIn')
  - Google Search: `source === 'Google Search'`
  - LinkedIn: `source === 'LinkedIn'`
