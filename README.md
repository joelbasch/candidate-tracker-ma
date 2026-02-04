# Eye to Eye Careers - Candidate Tracker

## MacBook Setup Instructions

### Prerequisites
- Node.js (version 16 or higher)
- npm (comes with Node.js)

### Installation

1. **Open Terminal** and navigate to this folder:
   ```bash
   cd ~/Downloads/candidate-tracker-mac
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the server**:
   ```bash
   npm start
   ```

4. **Open your browser** and go to:
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
