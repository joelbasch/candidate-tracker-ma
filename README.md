# Eye to Eye Careers - Candidate Tracker

## Cloud Deployment (Render.com) — Recommended

Auto-deploys every time you push to GitHub.

### One-Time Setup

1. **Push this repo to GitHub** (if not already):
   - Create a new repo at https://github.com/new
   - Push your code:
     ```bash
     git remote add github https://github.com/YOUR_USERNAME/candidate-tracker-ma.git
     git push github main
     ```

2. **Deploy to Render**:
   - Go to https://render.com and sign in with GitHub
   - Click **New > Web Service**
   - Connect your `candidate-tracker-ma` repo
   - Render will auto-detect `render.yaml` and configure everything
   - Or click **New > Blueprint** and point to the repo

3. **Set your API keys** in Render dashboard > Environment:
   - `SERPER_API_KEY` — your Serper.dev key
   - `LOXO_API_KEY` — your Loxo API key (optional)
   - `LOXO_AGENCY_SLUG` — your Loxo agency slug (optional)

4. **Done!** Render gives you a URL like `https://candidate-tracker-XXXX.onrender.com`

### Auto-Deploy

Every time you push to GitHub, Render automatically rebuilds and deploys:
```bash
git add .
git commit -m "your changes"
git push github main
```

---

## Local Setup (Windows / Mac)

### Prerequisites
- Node.js (version 18 or higher)
- npm (comes with Node.js)

### Installation

1. **Open a terminal** and navigate to this folder:
   ```bash
   cd candidate-tracker-ma
   ```

2. **Copy and edit environment variables**:
   ```bash
   cp .env.example .env
   # Edit .env with your API keys
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Start the server**:
   ```bash
   npm start
   ```

5. **Open your browser** and go to:
   ```
   http://localhost:3001
   ```

### Usage

1. **Upload CSV**: Click "Upload CSV" to import candidates from Loxo export
2. **Run Check**: Click "Run Check" to scan NPI registry and create alerts
3. **View Alerts**: Click "Alerts" tab to see matches

### File Formats Supported

**Loxo Reporting Export** (recommended):
- ID, User, Company Name, Job Title, Candidate Name, Event Name, Created At, Notes

**Loxo People Export**:
- Id, Name, Phone, Email, Company, LinkedIn, etc.

### Troubleshooting

**Port already in use?**
Edit `.env` file and change `PORT=3001` to another port like `PORT=3002`

**Dependencies error?**
```bash
rm -rf node_modules
npm install
```

### Data Storage

All data is stored locally in `tracker-data.json`. This file is created automatically when you first run the server.

To reset all data:
```bash
rm tracker-data.json
npm start
```
