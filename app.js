require('dotenv').config();
const { App } = require('@slack/bolt');
const { google } = require('googleapis');

// Initialize Slack Bolt app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Google Sheets setup
const sheets = google.sheets({
  version: 'v4',
  auth: new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  }),
});
const spreadsheetId = process.env.SPREADSHEET_ID;
const sheetTitle = process.env.SHEET_TITLE || 'Sheet1';

// Pricing and payment configuration
const coffeePrice = Number(process.env.PRICE_COFFEE || 2);
const teaPrice = Number(process.env.PRICE_TEA || 1.5);
const payUrl = process.env.PAY_URL || 'https://paypal.me/youraccount';

if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_SIGNING_SECRET) {
  console.warn('Missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET in environment.');
}
if (!spreadsheetId) {
  console.warn('Missing SPREADSHEET_ID in environment. Google Sheets logging will fail.');
}

// In-memory store for simplicity (replace with database for production)
let userChoices = {};
// Track a single DM message per user for updates
const userMessageRefs = {}; // { [userId]: { channelId, ts, monthKey } }
const monthlySettled = {}; // { [monthKey]: { [userId]: boolean } }
let botUserId = null; // populated at startup via auth.test
let sheetIdCache = null;

async function getSheetId() {
  if (sheetIdCache) return sheetIdCache;
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = (meta.data.sheets || []).find(s => s.properties && s.properties.title === sheetTitle);
  if (!sheet) {
    throw new Error(`Sheet with title ${sheetTitle} not found`);
  }
  sheetIdCache = sheet.properties.sheetId;
  return sheetIdCache;
}

async function openDmChannel(userId) {
  const resp = await app.client.conversations.open({ users: userId });
  return resp.channel.id;
}

async function getUserDisplayName(userId) {
  try {
    const info = await app.client.users.info({ user: userId });
    const profile = info.user && info.user.profile ? info.user.profile : {};
    return profile.display_name || profile.real_name || info.user.name || userId;
  } catch (e) {
    return userId;
  }
}

function getCurrentMonthKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function getCurrentMonthLabel(date = new Date()) {
  return date.toLocaleString('default', { month: 'long', year: 'numeric' });
}

async function getUserMonthlySummary(userId, date = new Date()) {
  const targetYear = date.getFullYear();
  const targetMonth = date.getMonth();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetTitle}!A:E`,
  });
  const rows = res.data.values || [];
  let coffee = 0;
  let tea = 0;
  let amount = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row[0] !== userId) continue;
    const dateStr = row[2];
    const choice = row[3];
    const price = parseFloat(row[4] || '0') || 0;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) continue;
    if (d.getFullYear() === targetYear && d.getMonth() === targetMonth) {
      if (choice === 'coffee') coffee++;
      if (choice === 'tea') tea++;
      amount += price;
    }
  }
  return { coffee, tea, amount };
}

async function buildControlBlocks(userId) {
  const monthLabel = getCurrentMonthLabel();
  const { coffee, tea, amount } = await getUserMonthlySummary(userId);
  const monthKey = getCurrentMonthKey();
  const isSettled = !!(monthlySettled[monthKey] && monthlySettled[monthKey][userId]);
  const settledOption = {
    text: { type: 'plain_text', text: 'Settled' },
    value: 'settled',
  };
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Your tally in ${monthLabel}:\n☕ Coffee: ${coffee}\n🍵 Tea: ${tea}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Amount due: $${amount.toFixed(2)}`,
      },
      accessory: (() => {
        const accessory = {
          type: 'checkboxes',
          action_id: 'settled_toggle',
          options: [settledOption],
        };
        if (isSettled) {
          accessory.initial_options = [settledOption];
        }
        return accessory;
      })(),
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Coffee ☕', emoji: true },
          action_id: 'coffee_choice',
          value: 'coffee',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Tea 🍵', emoji: true },
          action_id: 'tea_choice',
          value: 'tea',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Undo Last Choice', emoji: true },
          action_id: 'revoke_choice',
          value: 'revoke',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Pay Now', emoji: true },
          url: payUrl,
          action_id: 'pay_now',
        },
      ],
    },
  ];
}

async function sendOrUpdateControlMessage(userId) {
  const monthLabel = getCurrentMonthLabel();
  const monthKey = getCurrentMonthKey();
  const blocks = await buildControlBlocks(userId);
  // Ensure we have a DM channel
  const channelId = userMessageRefs[userId]?.channelId || (await openDmChannel(userId));
  const record = userMessageRefs[userId];
  const text = `Your tally in ${monthLabel}`;
  if (record && record.ts && record.monthKey === monthKey) {
    await app.client.chat.update({ channel: channelId, ts: record.ts, text, blocks });
  } else {
    const resp = await app.client.chat.postMessage({ channel: channelId, text, blocks });
    userMessageRefs[userId] = { channelId, ts: resp.ts, monthKey };
  }
}

async function ensureHeaderRow() {
  // Create header only if the sheet's first row is empty/missing
  const header = ['UserID', 'UserName', 'Date', 'Choice', 'Price'];
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetTitle}!A1:E1`,
  });
  const rows = res.data.values || [];
  const firstRow = rows[0] || [];
  const isEmpty = firstRow.length === 0 || firstRow.every(c => !c || `${c}`.trim() === '');
  if (isEmpty) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetTitle}!A1:E1`,
      valueInputOption: 'RAW',
      resource: { values: [header] },
    });
  }
}

// Slash command: DM-only UX. Ack immediately and set up or update the control message in DM.
app.command('/coffee_tea', async ({ command, ack, respond }) => {
  await ack({ response_type: 'ephemeral', text: 'Check your DM for Coffee/Tea controls.' });
  const userId = command.user_id;
  if (!userChoices[userId]) {
    userChoices[userId] = { coffee: 0, tea: 0 };
  }
  try {
    await sendOrUpdateControlMessage(userId);
  } catch (error) {
    console.error('Failed to send or update DM control message:', error);
    // Fallback: show ephemeral controls in the channel when DM fails (e.g., missing im:write)
    try {
      const blocks = await buildControlBlocks(userId);
      await respond({
        response_type: 'ephemeral',
        text: `Could not DM you, showing controls here instead.`,
        blocks,
      });
    } catch (e2) {
      console.error('Also failed to send ephemeral fallback:', e2);
    }
  }
});

// Handle coffee/tea selection
app.action('coffee_choice', async ({ action, ack, say, body }) => {
  await ack();
  const userId = body.user.id;
  const choice = action.value;
  await logChoice(userId, choice);
  await sendOrUpdateControlMessage(userId);
});

app.action('tea_choice', async ({ action, ack, say, body }) => {
  await ack();
  const userId = body.user.id;
  const choice = action.value;
  await logChoice(userId, choice);
  await sendOrUpdateControlMessage(userId);
});

// Handle long-press revocation (simulated as a button)
app.action('revoke_choice', async ({ action, ack, say, body }) => {
  await ack();
  const userId = body.user.id;
  await revokeLastChoice(userId);
  await sendOrUpdateControlMessage(userId);
});

// Handle settled checkbox toggle
app.action('settled_toggle', async ({ action, ack, body }) => {
  await ack();
  const userId = body.user.id;
  const monthKey = getCurrentMonthKey();
  if (!monthlySettled[monthKey]) monthlySettled[monthKey] = {};
  const selected = action.selected_options && action.selected_options.find(o => o.value === 'settled');
  monthlySettled[monthKey][userId] = !!selected;
  await sendOrUpdateControlMessage(userId);
});

// Ack Pay Now clicks (button also opens the URL via Slack)
app.action('pay_now', async ({ ack }) => {
  await ack();
});

// Log choice to Google Sheet
async function logChoice(userId, choice) {
  if (!userChoices[userId]) {
    userChoices[userId] = { coffee: 0, tea: 0 };
  }
  userChoices[userId][choice]++;
  const price = choice === 'coffee' ? coffeePrice : teaPrice;
  const userName = await getUserDisplayName(userId);
  await ensureHeaderRow();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetTitle}!A:E`,
    valueInputOption: 'RAW',
    resource: {
      values: [[userId, userName, new Date().toISOString(), choice, price]],
    },
  });
}

// Revoke last choice
async function revokeLastChoice(userId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetTitle}!A:E`,
  });
  const rows = res.data.values || [];
  // Find last index for this user (including header at index 0)
  let lastIndex = -1;
  for (let i = rows.length - 1; i >= 1; i--) {
    if (rows[i][0] === userId) { lastIndex = i; break; }
  }
  if (lastIndex > 0) {
    const lastChoice = rows[lastIndex][3];
    userChoices[userId][lastChoice] = Math.max(0, userChoices[userId][lastChoice] - 1);
    const sheetId = await getSheetId();
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: lastIndex,
                endIndex: lastIndex + 1,
              },
            },
          },
        ],
      },
    });
  }
}

// Send personalized view
// Deprecated: replaced by sendOrUpdateControlMessage for DM-only UX
async function updatePersonalizedView() {}

// Monthly tally and payment reminder
app.command('/monthly_tally', async ({ command, ack, say }) => {
  await ack();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetTitle}!A:E`,
  });
  const rows = res.data.values || [];
  const summary = {};
  // Expected columns: [userId, userName, date, choice, price]
  rows.forEach((row, idx) => {
    if (idx === 0) return; // skip header
    const userId = row[0];
    const choice = row[3];
    const price = parseFloat(row[4] || '0') || 0;
    if (!summary[userId]) {
      summary[userId] = { coffee: 0, tea: 0, amount: 0 };
    }
    summary[userId][choice]++;
    summary[userId].amount += price;
  });

  for (const userId in summary) {
    const { coffee, tea, amount } = summary[userId];
    const total = amount;
    await app.client.chat.postMessage({
      channel: userId,
      text: `Your monthly bill: ☕ ${coffee} coffees, 🍵 ${tea} teas = $${total.toFixed(2)}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Your monthly bill:\n☕ ${coffee} coffees\n🍵 ${tea} teas\nTotal: $${total.toFixed(2)}`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Pay Now', emoji: true },
              url: payUrl,
            },
          ],
        },
      ],
    });
  }
});

// Start the app
(async () => {
  await app.start(process.env.PORT || 3000);
  console.log('☕ Tea/Coffee Bot is running!');
  try {
    const auth = await app.client.auth.test();
    botUserId = auth.user_id || null;
  } catch (e) {
    console.warn('Could not determine bot user id via auth.test');
  }
  // Schedule monthly broadcast on the 1st at 09:00 local time
  function msUntilNextFirstNineAM(now = new Date()) {
    const year = now.getFullYear();
    const month = now.getMonth();
    const nextMonth = new Date(year, month + 1, 1, 9, 0, 0, 0);
    return nextMonth.getTime() - now.getTime();
  }

  async function broadcastForCurrentMonth() {
    try {
      // Fetch users and DM each
      const usersResp = await app.client.users.list();
      const members = (usersResp.members || []).filter(
        u => !u.is_bot && !u.deleted && u.id && u.id.startsWith('U')
      );
      for (const u of members) {
        try {
          await sendOrUpdateControlMessage(u.id);
        } catch (e) {
          console.error(`Failed to DM ${u.id}:`, e);
        }
      }
    } catch (e) {
      console.error('Monthly broadcast failed:', e);
    }
  }

  async function scheduleMonthlyBroadcast() {
    const delay = msUntilNextFirstNineAM();
    setTimeout(async () => {
      await broadcastForCurrentMonth();
      scheduleMonthlyBroadcast(); // schedule next month
    }, Math.max(1000, delay));
  }

  scheduleMonthlyBroadcast();
})();

// Command to clear prior bot messages in the DM with the user
app.command('/coffee_clear_dm', async ({ command, ack, respond }) => {
  await ack();
  try {
    const userId = command.user_id;
    const channelId = (await app.client.conversations.open({ users: userId })).channel.id;
    let totalDeleted = 0;
    let cursor = undefined;
    do {
      const history = await app.client.conversations.history({ channel: channelId, cursor, limit: 200 });
      for (const msg of history.messages || []) {
        const isOwn = !!(msg.user && botUserId && msg.user === botUserId);
        if (!isOwn) continue;
        try {
          await app.client.chat.delete({ channel: channelId, ts: msg.ts });
          totalDeleted++;
        } catch (eDel) {
          // ignore messages we cannot delete
        }
      }
      cursor = history.response_metadata && history.response_metadata.next_cursor ? history.response_metadata.next_cursor : undefined;
    } while (cursor);
    await respond({ response_type: 'ephemeral', text: `Deleted ${totalDeleted} prior bot message(s) in our DM.` });
  } catch (e) {
    const detail = (e && e.data && e.data.error) ? e.data.error : (e && e.message ? e.message : 'unknown_error');
    await respond({ response_type: 'ephemeral', text: `Could not clear DM messages. Ensure scopes: im:history, im:write, chat:write and the app is reinstalled. Error: ${detail}` });
  }
});