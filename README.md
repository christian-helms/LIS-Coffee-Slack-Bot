## Coffee/Tea Slack Bot

A simple Slack bot to track daily Coffee ☕ / Tea 🍵 choices, log them to Google Sheets, and send monthly tallies with a payment link.

### Prerequisites
- Slack workspace admin access
- Node.js 18+
- Google Cloud project with a Service Account that has access to the target Google Sheet

### 1) Create a Slack App
1. Go to `https://api.slack.com/apps` → Create New App (from scratch)
2. Add Bot Token Scopes: `chat:write`, `commands`, `channels:history` (optional if needed)
3. Enable Interactivity and set Request URL to your public URL (ngrok in local dev) + `/slack/events`
4. Slash Commands:
   - `/coffee_tea` — describe: "Post Coffee/Tea choices"
   - `/monthly_tally` — describe: "Send monthly tallies via DM"
5. Install the app to your workspace → copy `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`

### 2) Google Sheets Setup

- Install 

1. Create a Sheet with columns: `UserID`, `Date`, `Choice` (Sheet1)
2. In Google Cloud Console:
   - Create a Service Account
   - Create a JSON key and download it (save as `service-account.json` in project root)
   - Share the Google Sheet with the service account email
3. Grab the Sheet ID from the URL and set `SPREADSHEET_ID`

### 3) Configure Environment
Copy `.env.example` to `.env` and fill in values:
```
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
PORT=3000
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
SPREADSHEET_ID=...
SHEET_TITLE=Sheet1
PRICE_COFFEE=2
PRICE_TEA=1.5
PAY_URL=https://paypal.me/youraccount
```

### 4) Install and Run
```
npm install
npm run dev
```
Use ngrok (or similar) to expose your local server:
```
ngrok http 3000
```
Set the Slack Interactivity and Slash Command Request URL to the ngrok URL.

### Usage
- In a channel, run `/coffee_tea` — you’ll get an ephemeral confirmation.
- Then interact in the DM with the bot. A single message shows:
  - Buttons: Coffee, Tea, Undo Last Choice
  - Your current tally (updates inline in that one message)
- The bot logs `[UserID, UserName, Date, Choice, Price]` to the sheet (`A:E`).
- Run `/monthly_tally` to DM each user their totals and a Pay link.

### Notes
- Pricing is configurable via `PRICE_COFFEE` and `PRICE_TEA`
- Replace `PAY_URL` with your PayPal/Venmo link
- For production, consider persisting counts in a database instead of memory
