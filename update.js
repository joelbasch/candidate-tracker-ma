/**
 * UPDATE SCRIPT - Downloads the 3 updated files from GitHub
 *
 * 1. Save this as "update.js" in your candidate-tracker-ma folder
 * 2. Run: node update.js
 * 3. It downloads the latest linkedinService.js, monitoringScheduler.js, googleSearchService.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const branch = 'claude/general-work-aDeNn';
const repo = 'joelbasch/candidate-tracker-ma';
const filesToUpdate = [
  'linkedinService.js',
  'monitoringScheduler.js',
  'googleSearchService.js'
];

function download(filename) {
  return new Promise((resolve, reject) => {
    const url = `https://raw.githubusercontent.com/${repo}/${branch}/${filename}`;
    console.log(`  Downloading ${filename}...`);

    https.get(url, { headers: { 'User-Agent': 'Node' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, { headers: { 'User-Agent': 'Node' } }, (res2) => {
          let data = '';
          res2.on('data', chunk => data += chunk);
          res2.on('end', () => {
            fs.writeFileSync(path.join(__dirname, filename), data, 'utf8');
            console.log(`  ✅ ${filename} updated (${data.length} bytes)`);
            resolve();
          });
        }).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${filename}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        fs.writeFileSync(path.join(__dirname, filename), data, 'utf8');
        console.log(`  ✅ ${filename} updated (${data.length} bytes)`);
        resolve();
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('=== Candidate Tracker Updater ===\n');

  for (const file of filesToUpdate) {
    try {
      await download(file);
    } catch (e) {
      console.log(`  ❌ Failed: ${file} - ${e.message}`);
    }
  }

  console.log('\n=== Done! Now start the server: ===');
  console.log('  set SERPER_API_KEY=your_actual_key');
  console.log('  set NETROWS_API_KEY=pk_live_3d735c548a4955433f4dd565b722c16e');
  console.log('  node server.js');
}

main();
