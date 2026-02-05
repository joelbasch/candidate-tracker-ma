# Eye to Eye Careers - Candidate Tracker

A candidate placement tracking and monitoring system for Eye to Eye Careers.

## Prerequisites

- Node.js (version 18 or higher)
- npm (comes with Node.js)

---

## Windows Setup Instructions

### Installation

1. **Open Command Prompt** (or PowerShell) and navigate to this folder:
   ```cmd
   cd %USERPROFILE%\Downloads\candidate-tracker
   ```
   Or if using PowerShell:
   ```powershell
   cd $env:USERPROFILE\Downloads\candidate-tracker
   ```

2. **Install dependencies**:
   ```cmd
   npm install
   ```

3. **Start the server**:
   ```cmd
   npm start
   ```
   Or use the included batch file:
   ```cmd
   start.bat
   ```

4. **Open your browser** and go to:
   ```
   http://localhost:3001
   ```

### Quick Start (Windows)

Double-click `start.bat` to launch the server automatically. A browser window will open to the application.

### Windows Troubleshooting

**Port already in use?**
Edit `.env` file and change `PORT=3001` to another port like `PORT=3002`

**Dependencies error?**
```cmd
rmdir /s /q node_modules
npm install
```

**PowerShell execution policy error?**
Run PowerShell as Administrator and execute:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

**Node.js not recognized?**
- Download Node.js from https://nodejs.org/
- During installation, ensure "Add to PATH" is checked
- Restart your terminal after installation

---

## MacOS Setup Instructions

### Installation

1. **Open Terminal** and navigate to this folder:
   ```bash
   cd ~/Downloads/candidate-tracker
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

### MacOS Troubleshooting

**Port already in use?**
Edit `.env` file and change `PORT=3001` to another port like `PORT=3002`

**Dependencies error?**
```bash
rm -rf node_modules
npm install
```

---

## Usage

1. **Upload CSV**: Click "Upload CSV" to import candidates from Loxo export
2. **Run Check**: Click "Run Check" to scan NPI registry and create alerts
3. **View Alerts**: Click "Alerts" tab to see matches

## File Formats Supported

**Loxo Reporting Export** (recommended):
- ID, User, Company Name, Job Title, Candidate Name, Event Name, Created At, Notes

**Loxo People Export**:
- Id, Name, Phone, Email, Company, LinkedIn, etc.

## Environment Configuration

Create a `.env` file in the project root with the following variables:

```env
PORT=3001
LOXO_API_KEY=your_loxo_api_key
LOXO_DOMAIN=your-domain.app.loxo.co
LOXO_AGENCY_SLUG=your-agency-slug
SERPER_API_KEY=your_serper_api_key
NODE_ENV=development
```

## Data Storage

All data is stored locally in `tracker-data.json`. This file is created automatically when you first run the server.

### Reset All Data

**Windows:**
```cmd
del tracker-data.json
npm start
```

**MacOS/Linux:**
```bash
rm tracker-data.json
npm start
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start the production server |
| `npm run dev` | Start with auto-reload (development) |

## Support

For issues or questions, contact your system administrator.
