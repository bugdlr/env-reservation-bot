require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const fs = require('fs');
const path = require('path');
const { WebClient } = require("@slack/web-api");
const crypto = require('crypto');

const PINNED_DATA_DIR = path.join(process.cwd(), 'data');
const PINNED_TS_FILE = path.join(PINNED_DATA_DIR, 'pinned_messages.json');

const app = express();
const port = process.env.PORT || 3000;
const token = process.env.SLACK_BOT_TOKEN;
const signingSecret = process.env.SLACK_SIGNING_SECRET;
const web = new WebClient(token, {
    timeout: 10000,
});

// Simple rate limiting - track requests per user
const userRequests = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 10; // Max 10 requests per minute per user

function rateLimitMiddleware(req, res, next) {
    const userId = req.body.user_id;
    if (!userId) {
        return next(); // Skip rate limiting if no user_id
    }
    
    const now = Date.now();
    const userKey = userId;
    
    if (!userRequests.has(userKey)) {
        userRequests.set(userKey, []);
    }
    
    const requests = userRequests.get(userKey);
    
    // Remove old requests outside the time window
    const validRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
    
    if (validRequests.length >= RATE_LIMIT_MAX) {
        console.log(`Rate limit exceeded for user ${userId}`);
        return res.status(429).send('Too many requests. Please wait a moment.');
    }
    
    validRequests.push(now);
    userRequests.set(userKey, validRequests);
    
    next();
}

// Default body parser - capture raw body for Slack signature verification
app.use(bodyParser.urlencoded({
    extended: true,
    verify: (req, res, buf, encoding) => {
        req.rawBody = buf.toString(encoding || 'utf8');
    }
}));

// Slack signature verification middleware
function verifySlackSignature(req, res, next) {
    if (!signingSecret) {
        console.error('SLACK_SIGNING_SECRET not configured');
        return res.status(500).send('Server configuration error');
    }

    const slackSignature = req.headers['x-slack-signature'];
    const timestamp = req.headers['x-slack-request-timestamp'];
    
    if (!slackSignature || !timestamp) {
        console.log('Missing Slack headers - rejecting request');
        return res.status(400).send('Missing Slack headers');
    }

    // Prevent replay attacks (timestamp older than 5 minutes)
    if (Math.abs(Date.now() / 1000 - timestamp) > 300) {
        console.log('Request too old - rejecting');
        return res.status(400).send('Request too old');
    }

    // Get raw body for signature verification
    let rawBody;
    if (req.rawBody) {
        rawBody = req.rawBody;
    } else if (req.body && typeof req.body === 'object') {
        // Convert parsed body back to raw format
        rawBody = Object.keys(req.body).map(key => `${encodeURIComponent(key)}=${encodeURIComponent(req.body[key])}`).join('&');
    } else {
        console.log('Unable to get raw body for signature verification');
        return res.status(400).send('Invalid request format');
    }

    // Create expected signature
    const sigBasestring = `v0:${timestamp}:${rawBody}`;
    const expectedSignature = 'v0=' + crypto
        .createHmac('sha256', signingSecret)
        .update(sigBasestring)
        .digest('hex');

    if (slackSignature !== expectedSignature) {
        console.log('Invalid signature - rejecting request');
        return res.status(401).send('Invalid signature');
    }

    console.log('✅ Signature verified successfully');
    next();
}

// Health check endpoint
app.get('/health', async (req, res) => {
    const activeReservations = Object.values(reservations).filter(r => r !== null).length;
    const totalQueueLength = Object.values(queues).reduce((sum, q) => sum + q.length, 0);
    const channelSummary = Object.entries(reservations)
        .filter(([, r]) => r !== null)
        .map(([ch, r]) => ({ channel: ch, user: r.user_name }));
    
    try {
        // Test Slack API connectivity
        await web.auth.test();
        
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: Math.floor(process.uptime()),
            active_channels: Object.keys(reservations).length,
            active_reservations: activeReservations,
            total_queue_length: totalQueueLength,
            channel_summary: channelSummary,
            slack_api: 'connected'
        });
    } catch (error) {
        res.status(503).json({
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: 'Slack API connection failed',
            slack_api: 'disconnected'
        });
    }
});

// Simple readiness check
app.get('/ready', (req, res) => {
    if (!token || !signingSecret) {
        return res.status(503).json({ status: 'not_ready' });
    }
    res.json({ status: 'ready' });
});

// Per-channel state storage
let reservations = {};  // { "C1234": { user_id, user_name, ... }, "C5678": null }
let queues = {};       // { "C1234": [...], "C5678": [...] }
let scheduledReservations = {}; // { channelId: [ { user_id, user_name, duration, channel_id, scheduledTime, timezone, scheduledTimer }, ... ] }
let pendingHandoffs = {}; // { channelId: { user_id, user_name, duration, graceTimer } }
let pinnedMessageTs = {};  // { "C1234": "1234567890.123456" } - loaded from file on startup

// Pinned message ts persistence
function loadPinnedMessageTs() {
    try {
        if (fs.existsSync(PINNED_TS_FILE)) {
            const data = JSON.parse(fs.readFileSync(PINNED_TS_FILE, 'utf8'));
            Object.assign(pinnedMessageTs, data);
        }
    } catch (e) {
        console.warn('Could not load pinned message ts:', e.message);
    }
}

function savePinnedMessageTs(channelId, ts) {
    try {
        if (!fs.existsSync(PINNED_DATA_DIR)) fs.mkdirSync(PINNED_DATA_DIR, { recursive: true });
        pinnedMessageTs[channelId] = ts;
        fs.writeFileSync(PINNED_TS_FILE, JSON.stringify(pinnedMessageTs, null, 0));
    } catch (e) {
        console.warn('Could not save pinned message ts:', e.message);
    }
}

// Helper functions for state access
function getCurrentReservation(channel_id) {
    return reservations[channel_id] || null;
}

function setCurrentReservation(channel_id, reservation) {
    reservations[channel_id] = reservation;
}

function clearCurrentReservation(channel_id) {
    reservations[channel_id] = null;
}

function getQueue(channel_id) {
    if (!queues[channel_id]) {
        queues[channel_id] = [];
    }
    return queues[channel_id];
}

function addToQueue(channel_id, queueEntry) {
    if (!queues[channel_id]) {
        queues[channel_id] = [];
    }
    queues[channel_id].push(queueEntry);
}

function removeFromQueue(channel_id, index) {
    if (!queues[channel_id]) {
        return null;
    }
    return queues[channel_id].splice(index, 1)[0];
}

function getNextInQueue(channel_id) {
    if (!queues[channel_id] || queues[channel_id].length === 0) {
        return null;
    }
    return queues[channel_id].shift();
}

// Scheduled reservation accessors
function getScheduledReservations(channel_id) {
    return scheduledReservations[channel_id] || [];
}

function getNextScheduledReservation(channel_id) {
    const arr = scheduledReservations[channel_id];
    return (arr && arr.length > 0) ? arr[0] : null;
}

function addScheduledReservation(channel_id, obj) {
    if (!scheduledReservations[channel_id]) {
        scheduledReservations[channel_id] = [];
    }
    const newStart = obj.scheduledTime;
    const newEnd = newStart + obj.duration * 60000;
    for (const entry of scheduledReservations[channel_id]) {
        const existingStart = entry.scheduledTime;
        const existingEnd = existingStart + entry.duration * 60000;
        if (newStart < existingEnd && newEnd > existingStart) {
            throw new Error(`Time conflict: overlaps with <@${entry.user_id}>'s reservation at ${formatScheduledTime(entry.scheduledTime, entry.timezone || 'America/Los_Angeles')}`);
        }
    }
    scheduledReservations[channel_id].push(obj);
    scheduledReservations[channel_id].sort((a, b) => a.scheduledTime - b.scheduledTime);
}

function removeScheduledReservation(channel_id, user_id) {
    if (!scheduledReservations[channel_id]) return;
    const idx = scheduledReservations[channel_id].findIndex(s => s.user_id === user_id);
    if (idx !== -1) {
        const entry = scheduledReservations[channel_id][idx];
        if (entry.scheduledTimer) clearTimeout(entry.scheduledTimer);
        scheduledReservations[channel_id].splice(idx, 1);
    }
}

function clearAllScheduledReservations(channel_id) {
    if (!scheduledReservations[channel_id]) return;
    for (const entry of scheduledReservations[channel_id]) {
        if (entry.scheduledTimer) clearTimeout(entry.scheduledTimer);
    }
    scheduledReservations[channel_id] = [];
}

// Pending handoff accessors
function getPendingHandoff(channel_id) {
    return pendingHandoffs[channel_id] || null;
}

function setPendingHandoff(channel_id, handoff) {
    pendingHandoffs[channel_id] = handoff;
}

function clearPendingHandoff(channel_id) {
    const handoff = pendingHandoffs[channel_id];
    if (handoff && handoff.graceTimer) clearTimeout(handoff.graceTimer);
    delete pendingHandoffs[channel_id];
}

// Startup recovery function - restore from pinned message
async function recoverReservationState() {
    console.log('🔄 Checking for expired reservations from previous session...');
    loadPinnedMessageTs();

    const configuredChannels = process.env.MONITORED_CHANNELS
        ? process.env.MONITORED_CHANNELS.split(',').map(c => c.trim())
        : [];
    const storedChannels = Object.keys(pinnedMessageTs);
    const monitoredChannels = [...new Set([...configuredChannels, ...storedChannels])];

    if (monitoredChannels.length === 0) {
        console.log('⚠️ No monitored channels configured. Set MONITORED_CHANNELS=C1234,C5678 in .env');
        return;
    }

    let clearedCount = 0;
    let activeCount = 0;

    for (const channelId of monitoredChannels) {
        const ch = channelId.trim();
        try {
            let text = null;
            const ts = pinnedMessageTs[ch];
            if (ts) {
                const hist = await web.conversations.history({ channel: ch, latest: ts, oldest: ts, inclusive: true, limit: 1 });
                text = hist.messages?.[0]?.text || null;
            }
            if (!text) {
                const found = await findPinnedMessageInChannel(ch);
                if (found) {
                    text = found.text;
                    savePinnedMessageTs(ch, found.ts);
                }
            }

            if (!text) {
                await updatePinnedMessage(ch);
                continue;
            }

            const parsed = parsePinnedMessageContent(text);
            if (!parsed) {
                await updatePinnedMessage(ch);
                continue;
            }

            if (parsed.available) {
                console.log(`✅ Channel ${ch} already available`);
                // Still recover any scheduled reservations
                if (parsed.scheduled && parsed.scheduled.length > 0) {
                    for (const entry of parsed.scheduled) {
                        if (entry.scheduledTime > Date.now()) {
                            const msUntilActivation = entry.scheduledTime - Date.now();
                            const scheduledEntry = {
                                user_id: entry.user_id,
                                user_name: entry.user_name,
                                duration: entry.duration,
                                channel_id: ch,
                                scheduledTime: entry.scheduledTime,
                                timezone: entry.timezone,
                                scheduledTimer: setTimeout(() => activateScheduledReservation(ch, entry.user_id), msUntilActivation)
                            };
                            try {
                                addScheduledReservation(ch, scheduledEntry);
                                console.log(`📅 Recovered scheduled reservation for ${entry.user_name}`);
                            } catch (e) {
                                console.warn(`⚠️ Could not recover scheduled: ${e.message}`);
                            }
                        }
                    }
                }
                continue;
            }

            const isExpired = parsed.epoch
                ? parsed.epoch <= Date.now()
                : await isReservationExpired(parsed.timeString);
            if (isExpired) {
                if (parsed.queue.length > 0) {
                    console.log(`⏰ Reservation expired, giving to next in queue (${parsed.queue.length} waiting)`);
                    const nextUser = parsed.queue[0];
                    const restOfQueue = parsed.queue.slice(1);
                    for (const e of restOfQueue) addToQueue(ch, e);
                    const newReservation = {
                        user_id: nextUser.user_id,
                        user_name: nextUser.user_name,
                        duration: nextUser.duration,
                        channel_id: ch,
                        expirationTime: Date.now() + (nextUser.duration * 60 * 1000),
                        reminderTimer: nextUser.duration > 60 ? setTimeout(() => remindUserToExtend(nextUser.user_id, ch), nextUser.duration * 60 * 1000 - (10 * 60 * 1000)) : null,
                        releaseTimer: setTimeout(() => autoReleaseIfNoResponse(nextUser.user_id, ch), nextUser.duration * 60 * 1000)
                    };
                    setCurrentReservation(ch, newReservation);
                    await web.chat.postMessage({ channel: nextUser.user_id, text: `✅ The environment is now yours!` });
                    await updatePinnedMessage(ch);
                    clearedCount++;
                } else {
                    console.log(`⏰ Reservation expired - clearing`);
                    clearCurrentReservation(ch);
                    await updatePinnedMessage(ch);
                    clearedCount++;
                }
            } else {
                console.log(`✅ Reservation still valid - restoring to memory`);
                activeCount++;
                const expirationTime = parsed.epoch || parseTopicExpiration(parsed.timeString);
                if (expirationTime && expirationTime > Date.now()) {
                    const msUntilRelease = expirationTime - Date.now();
                    for (const e of parsed.queue) addToQueue(ch, e);
                    setCurrentReservation(ch, {
                        user_id: parsed.user_id,
                        user_name: parsed.user_name || 'User',
                        channel_id: ch,
                        expirationTime,
                        reservedAt: Date.now() - (msUntilRelease - 0),
                        reminderTimer: msUntilRelease > 10 * 60 * 1000
                            ? setTimeout(() => remindUserToExtend(parsed.user_id, ch), msUntilRelease - 10 * 60 * 1000)
                            : null,
                        releaseTimer: setTimeout(
                            () => autoReleaseIfNoResponse(parsed.user_id, ch),
                            msUntilRelease
                        )
                    });
                }
            }

            // Recover scheduled reservations
            if (parsed.scheduled && parsed.scheduled.length > 0) {
                for (const entry of parsed.scheduled) {
                    if (entry.scheduledTime > Date.now()) {
                        const msUntilActivation = entry.scheduledTime - Date.now();
                        const scheduledEntry = {
                            user_id: entry.user_id,
                            user_name: entry.user_name,
                            duration: entry.duration,
                            channel_id: ch,
                            scheduledTime: entry.scheduledTime,
                            timezone: entry.timezone,
                            scheduledTimer: setTimeout(() => activateScheduledReservation(ch, entry.user_id), msUntilActivation)
                        };
                        try {
                            addScheduledReservation(ch, scheduledEntry);
                            console.log(`📅 Recovered scheduled reservation for ${entry.user_name} at ${new Date(entry.scheduledTime).toISOString()}`);
                        } catch (e) {
                            console.warn(`⚠️ Could not recover scheduled reservation for ${entry.user_name}: ${e.message}`);
                        }
                    } else {
                        console.log(`⏭️ Scheduled reservation for ${entry.user_name} passed during downtime — skipping`);
                    }
                }
            }
        } catch (error) {
            console.error(`❌ Error checking channel ${ch}:`, error.message);
        }
    }

    console.log(`✅ Recovery complete: ${clearedCount} expired cleared, ${activeCount} active preserved`);
}

// Parse topic to get expiration timestamp (ms since epoch)
function parseTopicExpiration(timeString) {
    const pstMatch = timeString.match(/(\d{1,2}):(\d{2}) (AM|PM) PST/);
    if (!pstMatch) return null;
    const [, hours, minutes, ampm] = pstMatch;
    let hour24 = parseInt(hours);
    if (ampm === 'PM' && hour24 !== 12) hour24 += 12;
    else if (ampm === 'AM' && hour24 === 12) hour24 = 0;
    const now = new Date();
    const pstNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const reservationEnd = new Date(pstNow);
    reservationEnd.setHours(hour24, parseInt(minutes), 0, 0);
    return reservationEnd.getTime();
}

// Helper function to check if a reservation time string is expired
async function isReservationExpired(timeString) {
    try {
        // Parse format like "2:30 PM PST / 5:30 PM EST"
        // We'll use the PST time since that's the first one
        const pstMatch = timeString.match(/(\d{1,2}):(\d{2}) (AM|PM) PST/);
        
        if (!pstMatch) {
            console.log(`⚠️ Could not parse time format: "${timeString}" - assuming expired for safety`);
            return true; // If we can't parse it, assume expired for safety
        }
        
        const [, hours, minutes, ampm] = pstMatch;
        let hour24 = parseInt(hours);
        
        // Convert to 24-hour format
        if (ampm === 'PM' && hour24 !== 12) {
            hour24 += 12;
        } else if (ampm === 'AM' && hour24 === 12) {
            hour24 = 0;
        }
        
        // Create a Date object for today with the parsed time in PST
        const now = new Date();
        const pstNow = new Date(now.toLocaleString("en-US", {timeZone: "America/Los_Angeles"}));
        
        const reservationEnd = new Date(pstNow);
        reservationEnd.setHours(hour24, parseInt(minutes), 0, 0);
        
        // If the reservation time is in the past, it's expired
        const isExpired = reservationEnd < pstNow;
        
        console.log(`🕐 Parsed: ${timeString} → ${reservationEnd.toLocaleTimeString()} PST, now: ${pstNow.toLocaleTimeString()} PST, expired: ${isExpired}`);
        
        return isExpired;
    } catch (error) {
        console.error(`❌ Error parsing time "${timeString}":`, error);
        return true; // If parsing fails, assume expired for safety
    }
}

function formatDuration(minutes) {
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        if (remainingMinutes === 0) {
            return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
        }
        return `${hours} ${hours === 1 ? 'hour' : 'hours'} and ${remainingMinutes} minutes`;
    }
    return `${minutes} minutes`;
}

// Add this helper function to format the end time
function formatEndTime(durationMinutes) {
    const endTime = new Date(Date.now() + (durationMinutes * 60 * 1000));
    
    // Format in multiple time zones
    const ptTime = endTime.toLocaleTimeString('en-US', { 
        timeZone: 'America/Los_Angeles',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true 
    });
    const etTime = endTime.toLocaleTimeString('en-US', { 
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true 
    });

    return `${ptTime} PST / ${etTime} EST`;
}

// Format a scheduled time as human-readable (e.g., "3:00 PM today")
function formatScheduledTime(epochMs, timezone) {
    const tz = timezone || 'America/Los_Angeles';
    const targetDate = new Date(epochMs);
    const now = new Date();

    const timeStr = targetDate.toLocaleTimeString('en-US', {
        timeZone: tz,
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });

    const todayInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const targetInTz = new Date(targetDate.toLocaleString('en-US', { timeZone: tz }));

    const todayDay = new Date(todayInTz.getFullYear(), todayInTz.getMonth(), todayInTz.getDate());
    const targetDay = new Date(targetInTz.getFullYear(), targetInTz.getMonth(), targetInTz.getDate());
    const diffDays = Math.round((targetDay - todayDay) / (24 * 60 * 60 * 1000));

    if (diffDays === 0) return `${timeStr} today`;
    if (diffDays === 1) return `${timeStr} tomorrow`;
    const dateStr = targetDate.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
    return `${timeStr} on ${dateStr}`;
}

// Build topic string (full format, no user_id)
function buildReservationTopic(user_name, user_id, durationMinutes, queueEntries = []) {
    let topic = `🚀 In use by @${user_name} until ${formatEndTime(durationMinutes)}`;
    if (queueEntries && queueEntries.length > 0) {
        const qStr = queueEntries.map(e => `${e.user_id}:${e.duration}:${encodeURIComponent(e.user_name || '')}`).join(',');
        topic += ` || Q:${qStr}`;
    }
    return topic;
}

// Build pinned message content (human readable + recovery data)
const PINNED_MARKER = '📌 *Environment Reservation Status*';
const RECOVERY_PREFIX = '_Recovery Data: ';
const RECOVERY_SUFFIX = '_';

function buildPinnedMessageContent(reservation, queueEntries = [], scheduledEntries = [], pendingHandoff = null) {
    let text = `${PINNED_MARKER}\n\n`;

    if (pendingHandoff) {
        text += `*Status:* ⏳ Handoff pending to <@${pendingHandoff.user_id}>\n`;
    } else if (!reservation) {
        text += `*Status:* ✅ Available\n`;
    } else {
        const timeStr = formatEndTime(Math.ceil((reservation.expirationTime - Date.now()) / (60 * 1000)));
        text += `*In use by:* <@${reservation.user_id}>\n*Expires:* ${timeStr}\n`;
        if (queueEntries && queueEntries.length > 0) {
            text += `\n*Queue:*\n`;
            queueEntries.forEach((e, i) => {
                text += `${i + 1}. <@${e.user_id}> (${formatDuration(e.duration)})\n`;
            });
        }
    }

    if (scheduledEntries && scheduledEntries.length > 0) {
        text += `\n*Scheduled:*\n`;
        scheduledEntries.forEach((e, i) => {
            const timeDisplay = formatScheduledTime(e.scheduledTime, e.timezone);
            text += `${i + 1}. <@${e.user_id}> at ${timeDisplay} (${formatDuration(e.duration)})\n`;
        });
    }

    // Build recovery data
    let recovery = '';
    if (reservation) {
        const timeStr = formatEndTime(Math.ceil((reservation.expirationTime - Date.now()) / (60 * 1000)));
        const safeUserName = (reservation.user_name || 'User').replace(/[|·;()]/g, ' ').trim();
        const holderPart = `Holder <@${reservation.user_id}> (${safeUserName})`;
        const expiresPart = `Expires ${reservation.expirationTime} · Display ${timeStr}`;
        const queuePart = (queueEntries || []).length > 0
            ? (queueEntries || []).map(e => `<@${e.user_id}> ${e.duration} min (${(e.user_name || 'User').replace(/[|·;]/g, ' ')})`).join(' · ')
            : '';
        recovery = queuePart
            ? `${holderPart} · ${expiresPart} · Queue: ${queuePart}`
            : `${holderPart} · ${expiresPart}`;
    }

    if (scheduledEntries && scheduledEntries.length > 0) {
        const scheduledPart = scheduledEntries.map(e => {
            const safeName = (e.user_name || 'User').replace(/[|·;()]/g, ' ').trim();
            return `<@${e.user_id}> (${safeName}) at ${e.scheduledTime} for ${e.duration} min in ${e.timezone || 'America/Los_Angeles'}`;
        }).join(' | ');
        recovery += (recovery ? ' · ' : '') + `Scheduled: ${scheduledPart}`;
    }

    if (recovery) {
        text += `\n${RECOVERY_PREFIX}${recovery}${RECOVERY_SUFFIX}`;
    }

    return text;
}

// Parse pinned message for recovery. Returns { user_id, user_name, timeString, queue, scheduled } or null
function parsePinnedMessageContent(text) {
    if (!text || !text.includes(PINNED_MARKER)) return null;

    // Parse scheduled entries from recovery data first (needed for both available and in-use cases)
    const escaped = RECOVERY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const dataMatch = text.match(new RegExp(escaped + '(.+)' + RECOVERY_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm'));

    const scheduled = [];
    if (dataMatch) {
        const scheduledMatch = dataMatch[1].match(/Scheduled: (.+?)$/);
        if (scheduledMatch) {
            scheduledMatch[1].split(' | ').forEach(entry => {
                const m = entry.match(/<@(U[A-Z0-9]+)> \(([^)]+)\) at (\d{10,}) for (\d+) min in (.+)/);
                if (m) {
                    scheduled.push({
                        user_id: m[1],
                        user_name: m[2].trim(),
                        scheduledTime: parseInt(m[3], 10),
                        duration: parseInt(m[4], 10),
                        timezone: m[5].trim()
                    });
                }
            });
        }
    }

    if (text.includes('*Status:* ✅ Available') || text.includes('Handoff pending')) {
        return { available: true, scheduled };
    }

    if (!dataMatch) return null;
    const raw = dataMatch[1];
    const holderMatch = raw.match(/Holder <@(U[A-Z0-9]+)>(?:\s*\(([^)]+)\))?/);
    const epochMatch = raw.match(/Expires (\d{10,}) · Display (.+?)(?: · Queue:| · Scheduled:|$)/s);
    const legacyExpiresMatch = !epochMatch ? raw.match(/Expires (.+?)(?: · Queue:| · Scheduled:|$)/s) : null;
    const queueMatch = raw.match(/Queue: (.+?)(?:(?: · Scheduled:)|$)/s);
    const userId = holderMatch ? holderMatch[1] : null;
    const userName = holderMatch && holderMatch[2] ? holderMatch[2].trim() : null;
    const epoch = epochMatch ? parseInt(epochMatch[1], 10) : null;
    const timeStr = epochMatch ? epochMatch[2].trim() : (legacyExpiresMatch ? legacyExpiresMatch[1].trim() : null);
    const queue = [];
    if (queueMatch && queueMatch[1]) {
        queueMatch[1].split(' · ').forEach(entry => {
            const m = entry.match(/<@(U[A-Z0-9]+)> (\d+) min \((.+)\)$/);
            if (m) {
                queue.push({
                    user_id: m[1],
                    duration: parseInt(m[2], 10) || 120,
                    user_name: m[3] || 'User'
                });
            }
        });
    }
    if (!userId || (!timeStr && !epoch)) return null;
    return { user_id: userId, user_name: userName, epoch, timeString: timeStr, queue, scheduled };
}

// Create or update pinned message and topic
async function updatePinnedMessage(channel_id) {
    const reservation = getCurrentReservation(channel_id);
    const queue = getQueue(channel_id);
    const scheduled = getScheduledReservations(channel_id);
    const pendingHandoff = getPendingHandoff(channel_id);
    const content = buildPinnedMessageContent(reservation, queue, scheduled, pendingHandoff);

    try {
        const ts = pinnedMessageTs[channel_id];
        if (ts) {
            await web.chat.update({ channel: channel_id, ts, text: content });
        } else {
            const res = await web.chat.postMessage({ channel: channel_id, text: content });
            await web.pins.add({ channel: channel_id, timestamp: res.ts });
            savePinnedMessageTs(channel_id, res.ts);
        }
        let topic;
        if (pendingHandoff) {
            topic = `⏳ Handoff pending to @${pendingHandoff.user_name}`;
        } else if (reservation) {
            topic = buildReservationTopic(reservation.user_name, reservation.user_id, Math.ceil((reservation.expirationTime - Date.now()) / (60 * 1000)), queue);
        } else if (scheduled.length > 0) {
            const next = scheduled[0];
            topic = `✅ Available | Next: @${next.user_name} at ${formatScheduledTime(next.scheduledTime, next.timezone)}`;
        } else {
            topic = '✅ Available';
        }
        await web.conversations.setTopic({ channel: channel_id, topic });
    } catch (e) {
        if (e.data?.error === 'message_not_found' || e.data?.error === 'channel_not_found') {
            delete pinnedMessageTs[channel_id];
            try {
                if (fs.existsSync(PINNED_TS_FILE)) {
                    const data = JSON.parse(fs.readFileSync(PINNED_TS_FILE, 'utf8'));
                    delete data[channel_id];
                    fs.writeFileSync(PINNED_TS_FILE, JSON.stringify(data, null, 0));
                }
            } catch (err) {
                console.warn('Could not update pinned ts file:', err.message);
            }
        }
        console.error('updatePinnedMessage failed:', e.message);
    }
}

// Find our pinned message in channel (for recovery when ts not stored)
async function findPinnedMessageInChannel(channel_id) {
    try {
        const res = await web.conversations.history({ channel: channel_id, limit: 100 });
        for (const msg of res.messages || []) {
            if (msg.pinned_to && msg.pinned_to.includes(channel_id) && msg.text && msg.text.includes(PINNED_MARKER)) {
                return { ts: msg.ts, text: msg.text };
            }
        }
    } catch (e) {
        console.warn('findPinnedMessageInChannel failed:', e.message);
    }
    return null;
}

// Improved duration parsing with validation
function parseDuration(input) {
    if (!input || typeof input !== 'string') {
        return 120; // Default 2 hours
    }

    // Sanitize input - limit length and remove potentially harmful characters
    const sanitized = input.trim().toLowerCase().substring(0, 50);
    
    if (sanitized === '') {
        return 120; // Default 2 hours
    }

    // More restrictive regex patterns
    const hourMatch = sanitized.match(/^(\d{1,2})\s*(?:hours?|hrs?|h)$/);
    const minuteMatch = sanitized.match(/^(\d{1,3})\s*(?:minutes?|mins?|m)$/);
    const numberMatch = sanitized.match(/^(\d{1,3})$/);

    let duration = 0;
    
    if (hourMatch) {
        duration = parseInt(hourMatch[1], 10) * 60;
    } else if (minuteMatch) {
        duration = parseInt(minuteMatch[1], 10);
    } else if (numberMatch) {
        // If just a number is provided, assume minutes
        duration = parseInt(numberMatch[1], 10);
    } else {
        throw new Error('Invalid duration format. Use formats like "30min", "2 hours", or "90"');
    }

    // Enforce reasonable limits
    if (duration < 5) {
        throw new Error('Duration too short. Minimum is 5 minutes.');
    }
    if (duration > 480) { // Max 8 hours
        throw new Error('Duration too long. Maximum is 8 hours.');
    }

    return duration;
}

// Fetch user timezone from Slack profile
async function getUserTimezone(user_id) {
    try {
        const result = await web.users.info({ user: user_id });
        return result.user?.tz || 'America/Los_Angeles';
    } catch (e) {
        console.warn(`Could not fetch timezone for ${user_id}:`, e.message);
        return 'America/Los_Angeles';
    }
}

// Parse "2h at 3:00 PM" into { duration, atText }
function parseScheduledRequest(text) {
    if (!text || typeof text !== 'string' || text.trim() === '') {
        return { duration: 120, atText: null };
    }
    const trimmed = text.trim();

    // Case-insensitive split on " at " keyword
    const atIndex = trimmed.toLowerCase().indexOf(' at ');
    if (atIndex === -1) {
        // Check if text starts with "at " (no duration prefix)
        if (trimmed.toLowerCase().startsWith('at ')) {
            return { duration: 120, atText: trimmed.substring(3).trim() };
        }
        return { duration: parseDuration(trimmed), atText: null };
    }

    const durationPart = trimmed.substring(0, atIndex).trim();
    const atText = trimmed.substring(atIndex + 4).trim();

    const duration = durationPart === '' ? 120 : parseDuration(durationPart);
    return { duration, atText: atText || null };
}

// Convert time string like "3:00 PM", "15:00", "3pm" to epoch ms
function parseTimeToEpoch(timeStr, userTimezone) {
    const tz = userTimezone || 'America/Los_Angeles';
    const s = timeStr.trim();

    let hours, minutes = 0;

    // Try "3:00 PM" or "3:00PM"
    const meridiemFull = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    // Try "3pm" or "3 PM"
    const meridiemShort = s.match(/^(\d{1,2})\s*(AM|PM)$/i);
    // Try "15:00" (24h)
    const military = s.match(/^(\d{1,2}):(\d{2})$/);

    if (meridiemFull) {
        hours = parseInt(meridiemFull[1], 10);
        minutes = parseInt(meridiemFull[2], 10);
        const meridiem = meridiemFull[3].toUpperCase();
        if (hours < 1 || hours > 12) throw new Error(`Invalid hour: ${hours}`);
        if (minutes < 0 || minutes > 59) throw new Error(`Invalid minutes: ${minutes}`);
        if (meridiem === 'PM' && hours !== 12) hours += 12;
        else if (meridiem === 'AM' && hours === 12) hours = 0;
    } else if (meridiemShort) {
        hours = parseInt(meridiemShort[1], 10);
        const meridiem = meridiemShort[2].toUpperCase();
        if (hours < 1 || hours > 12) throw new Error(`Invalid hour: ${hours}`);
        if (meridiem === 'PM' && hours !== 12) hours += 12;
        else if (meridiem === 'AM' && hours === 12) hours = 0;
    } else if (military) {
        hours = parseInt(military[1], 10);
        minutes = parseInt(military[2], 10);
        if (hours < 0 || hours > 23) throw new Error(`Invalid hour: ${hours}`);
        if (minutes < 0 || minutes > 59) throw new Error(`Invalid minutes: ${minutes}`);
    } else {
        throw new Error(`Invalid time format: "${s}". Use formats like "3:00 PM", "15:00", or "3pm".`);
    }

    // Get "now" in user's timezone
    const now = new Date();
    const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));

    // Build target date in user's timezone for today
    const target = new Date(nowInTz);
    target.setHours(hours, minutes, 0, 0);

    // If the target time is in the past (or within 2 minutes), bump to tomorrow
    if (target <= nowInTz) {
        target.setDate(target.getDate() + 1);
    }

    // Convert back to UTC epoch: offset = nowInTz - now (in ms)
    const tzOffset = nowInTz.getTime() - now.getTime();
    return target.getTime() - tzOffset;
}

app.post("/env-request", verifySlackSignature, rateLimitMiddleware, async (req, res) => {
    const { user_id, user_name, channel_id, text } = req.body;
    
    // Slash commands must be run in a channel (not DM) - DMs have channel_id starting with 'D'
    if (!channel_id || channel_id.startsWith('D')) {
        return res.send("⚠️ Please run `/env-request` in a channel, not in a direct message.");
    }
    
    console.log(`📥 /env-request from @${user_name} in channel ${channel_id}`);
    
    let currentReservation = getCurrentReservation(channel_id);
    
    // Fallback: if memory is empty, check pinned message (handles server restart, channels not in MONITORED_CHANNELS)
    if (!currentReservation) {
        try {
            let text = null;
            const ts = pinnedMessageTs[channel_id];
            if (ts) {
                const hist = await web.conversations.history({ channel: channel_id, latest: ts, oldest: ts, inclusive: true, limit: 1 });
                text = hist.messages?.[0]?.text || null;
            }
            if (!text) {
                const found = await findPinnedMessageInChannel(channel_id);
                text = found?.text || null;
                if (found) savePinnedMessageTs(channel_id, found.ts);
            }
            if (text) {
                const parsed = parsePinnedMessageContent(text);
                if (parsed && !parsed.available) {
                    const isExpired = await isReservationExpired(parsed.timeString);
                    if (isExpired && parsed.queue.length > 0) {
                        const nextUser = parsed.queue[0];
                        const restOfQueue = parsed.queue.slice(1);
                        for (const e of restOfQueue) addToQueue(channel_id, e);
                        setCurrentReservation(channel_id, {
                            user_id: nextUser.user_id,
                            user_name: nextUser.user_name,
                            duration: nextUser.duration,
                            channel_id,
                            expirationTime: Date.now() + (nextUser.duration * 60 * 1000),
                            reminderTimer: nextUser.duration > 60 ? setTimeout(() => remindUserToExtend(nextUser.user_id, channel_id), nextUser.duration * 60 * 1000 - (10 * 60 * 1000)) : null,
                            releaseTimer: setTimeout(() => autoReleaseIfNoResponse(nextUser.user_id, channel_id), nextUser.duration * 60 * 1000)
                        });
                        await web.chat.postMessage({ channel: nextUser.user_id, text: `✅ The environment is now yours!` });
                        await updatePinnedMessage(channel_id);
                        return res.send("");
                    }
                    if (!isExpired) {
                        const expirationTime = parseTopicExpiration(parsed.timeString);
                        if (expirationTime && expirationTime > Date.now()) {
                            const msUntilRelease = expirationTime - Date.now();
                            for (const e of parsed.queue) addToQueue(channel_id, e);
                            setCurrentReservation(channel_id, {
                                user_id: parsed.user_id,
                                user_name: 'User',
                                channel_id,
                                expirationTime,
                                reservedAt: Date.now(),
                                reminderTimer: null,
                                releaseTimer: setTimeout(() => autoReleaseIfNoResponse(parsed.user_id, channel_id), msUntilRelease)
                            });
                            currentReservation = getCurrentReservation(channel_id);
                        }
                    } else {
                        return res.send(`⚠️ Environment appears to be in use. Please ask the holder to run \`/env-release\` to free it, or wait for it to expire.`);
                    }
                }
            }
        } catch (err) {
            console.error('Error checking pinned message:', err.message);
        }
    }
    
    // First check if this user already has the reservation
    if (currentReservation && currentReservation.user_id === user_id) {
        await printQueueStatus(channel_id);
        return res.send("");
    }
    
    // Check for empty command
    if (!text || text.trim() === '') {
        return res.send("Usage: /env-request [duration] [at time]\nExamples:\n• `/env-request 30min`\n• `/env-request 2 hours`\n• `/env-request 2h at 3:00 PM`\n• `/env-request` (defaults to 2 hours)");
    }

    // Check if there's a pending handoff
    const pendingHandoff = getPendingHandoff(channel_id);
    if (pendingHandoff && pendingHandoff.user_id !== user_id) {
        return res.send(`⚠️ Environment is being handed off to <@${pendingHandoff.user_id}>. Please wait or join the queue.`);
    }

    let duration, atText;
    try {
        ({ duration, atText } = parseScheduledRequest(text));
    } catch (error) {
        return res.send(`⚠️ ${error.message}`);
    }

    // Handle scheduled (future) reservation
    if (atText) {
        try {
            const userTimezone = await getUserTimezone(user_id);
            const scheduledTime = parseTimeToEpoch(atText, userTimezone);

            // Check overlap with current active reservation
            if (currentReservation) {
                const scheduledEnd = scheduledTime + duration * 60000;
                if (scheduledTime < currentReservation.expirationTime && scheduledEnd > Date.now()) {
                    return res.send(`⚠️ Your scheduled reservation overlaps with the current active reservation (expires ${formatScheduledTime(currentReservation.expirationTime, userTimezone)}).`);
                }
            }

            // addScheduledReservation validates no overlap with other scheduled windows
            const entry = {
                user_id,
                user_name,
                duration,
                channel_id,
                scheduledTime,
                timezone: userTimezone,
                scheduledTimer: null
            };
            addScheduledReservation(channel_id, entry);

            // Set the activation timer
            const msUntilActivation = scheduledTime - Date.now();
            entry.scheduledTimer = setTimeout(() => activateScheduledReservation(channel_id, user_id), msUntilActivation);

            await updatePinnedMessage(channel_id);
            const timeDisplay = formatScheduledTime(scheduledTime, userTimezone);
            await web.chat.postMessage({
                channel: channel_id,
                text: `📅 <@${user_id}> scheduled a reservation for ${timeDisplay} (${formatDuration(duration)})`
            });
            return res.send("");
        } catch (error) {
            return res.send(`⚠️ ${error.message}`);
        }
    }

    // Check if environment is already reserved
    if (currentReservation !== null) {
        try {
            const conversationResponse = await web.conversations.open({
                users: user_id
            });

            const dmChannelId = conversationResponse.channel.id;

            await web.chat.postMessage({
                channel: dmChannelId,
                text: `⚠️ Currently in use. Join queue?`,
                blocks: [
                    {
                        "type": "section",
                        "text": {
                            "type": "mrkdwn",
                            "text": `⚠️ Currently in use. Join queue?`
                        }
                    },
                    {
                        "type": "actions",
                        "elements": [
                            {
                                "type": "button",
                                "text": {
                                    "type": "plain_text",
                                    "text": "Join Queue"
                                },
                                "value": JSON.stringify({
                                    duration,
                                    channel_id
                                }),
                                "action_id": "join_queue",
                                "style": "primary"
                            },
                            {
                                "type": "button",
                                "text": {
                                    "type": "plain_text",
                                    "text": "No Thanks"
                                },
                                "value": "cancel",
                                "action_id": "cancel_queue"
                            }
                        ]
                    }
                ]
            });

            await web.chat.postMessage({
                channel: channel_id,
                text: `⚠️ Environment is currently in use by @${currentReservation.user_name}. Check your DMs to join the queue.`
            });

            await printQueueStatus(channel_id);
            return res.send("");
        } catch (error) {
            console.error('Error sending DM:', error);
            return res.send(`⚠️ Error: ${error.message}`);
        }
    }

    // Check if immediate reservation would conflict with a scheduled one
    const nextScheduled = getNextScheduledReservation(channel_id);
    if (nextScheduled && nextScheduled.user_id !== user_id) {
        const now = Date.now();
        const requestedEnd = now + duration * 60000;
        if (requestedEnd > nextScheduled.scheduledTime) {
            const maxMinutes = Math.floor((nextScheduled.scheduledTime - now) / 60000);
            if (maxMinutes < 5) {
                return res.send(`⚠️ A scheduled reservation by <@${nextScheduled.user_id}> starts too soon (${formatScheduledTime(nextScheduled.scheduledTime, nextScheduled.timezone)}). Please wait or schedule for later.`);
            }
            // DM user with option to reserve for shorter duration
            try {
                const conversationResponse = await web.conversations.open({ users: user_id });
                const dmChannelId = conversationResponse.channel.id;
                const scheduledTimeStr = formatScheduledTime(nextScheduled.scheduledTime, nextScheduled.timezone);
                await web.chat.postMessage({
                    channel: dmChannelId,
                    text: `⚠️ A scheduled reservation starts at ${scheduledTimeStr}. You can reserve for up to ${maxMinutes} minutes.`,
                    blocks: [
                        {
                            "type": "section",
                            "text": {
                                "type": "mrkdwn",
                                "text": `⚠️ A scheduled reservation by <@${nextScheduled.user_id}> starts at ${scheduledTimeStr}.\n\nYou requested ${formatDuration(duration)}, but only ${maxMinutes} minutes are available.`
                            }
                        },
                        {
                            "type": "actions",
                            "elements": [
                                {
                                    "type": "button",
                                    "text": { "type": "plain_text", "text": `Reserve for ${maxMinutes} min` },
                                    "value": JSON.stringify({ duration: maxMinutes, channel_id }),
                                    "action_id": "reserve_capped_duration",
                                    "style": "primary"
                                },
                                {
                                    "type": "button",
                                    "text": { "type": "plain_text", "text": "No thanks" },
                                    "value": JSON.stringify({ channel_id }),
                                    "action_id": "cancel_queue"
                                }
                            ]
                        }
                    ]
                });
                return res.send("");
            } catch (error) {
                console.error('Error sending capped duration DM:', error);
                return res.send(`⚠️ Error: ${error.message}`);
            }
        }
    }

    // Create the reservation
    const startTime = Date.now();
    const expirationTime = startTime + (duration * 60 * 1000);

    const newReservation = {
        user_id,
        user_name,
        duration,
        channel_id,
        expirationTime,
        reservedAt: startTime,
        reminderTimer: duration > 60 ? setTimeout(
            () => remindUserToExtend(user_id, channel_id),
            duration * 60 * 1000 - (10 * 60 * 1000)  // 10 minutes before end
        ) : null,
        releaseTimer: setTimeout(
            () => autoReleaseIfNoResponse(user_id, channel_id),
            duration * 60 * 1000
        )
    };

    setCurrentReservation(channel_id, newReservation);

    await updatePinnedMessage(channel_id);

    console.log(`✅ Reserved channel ${channel_id} for @${user_name}`);
    await printQueueStatus(channel_id);
    return res.send("");
});

app.post("/env-release", verifySlackSignature, rateLimitMiddleware, async (req, res) => {
    const { user_id, channel_id } = req.body;

    if (!channel_id || channel_id.startsWith('D')) {
        return res.send("⚠️ Please run `/env-release` in a channel, not in a direct message.");
    }

    console.log(`📤 /env-release from @${user_id} in channel ${channel_id}`);

    const currentReservation = getCurrentReservation(channel_id);

    // If user has the active reservation, release it
    if (currentReservation && currentReservation.user_id === user_id) {
        if (currentReservation.releaseTimer) clearTimeout(currentReservation.releaseTimer);
        if (currentReservation.reminderTimer) clearTimeout(currentReservation.reminderTimer);
        clearCurrentReservation(channel_id);

        const queue = getQueue(channel_id);
        if (queue.length > 0) {
            const nextUser = getNextInQueue(channel_id);
            await initiateHandoff(channel_id, nextUser);
        } else {
            await updatePinnedMessage(channel_id);
        }
        return res.send("");
    }

    // If user has no active reservation, check for scheduled
    const userScheduled = getScheduledReservations(channel_id).find(s => s.user_id === user_id);
    if (userScheduled) {
        removeScheduledReservation(channel_id, user_id);
        await updatePinnedMessage(channel_id);
        await web.chat.postMessage({
            channel: channel_id,
            text: `📅 <@${user_id}> cancelled their scheduled reservation.`
        });
        return res.send("");
    }

    return res.send("⚠️ You don't have an active or scheduled reservation to release.");
});

async function remindUserToExtend(user_id, channel_id) {
    // Double check this is still the current reservation holder
    const currentReservation = getCurrentReservation(channel_id);
    if (!currentReservation) {
        return;
    }
    
    if (currentReservation.user_id !== user_id) {
        return;
    }

    await web.chat.postMessage({
        channel: user_id,  // DM the user
        text: `⏳ Your reservation ends soon!`,
        blocks: [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": `⏳ Your reservation ends soon! What would you like to do?`
                }
            },
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "Extend 30 minutes"
                        },
                        "value": JSON.stringify({ 
                            channel_id: channel_id,
                            minutes: 30
                        }),
                        "action_id": "extend_time_30"
                    },
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "Extend 1 hour"
                        },
                        "value": JSON.stringify({ 
                            channel_id: channel_id,
                            minutes: 60
                        }),
                        "action_id": "extend_time_60"
                    },
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "Extend 2 hours"
                        },
                        "value": JSON.stringify({ 
                            channel_id: channel_id,
                            minutes: 120
                        }),
                        "action_id": "extend_time_120"
                    },
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "Extend 3 hours"
                        },
                        "value": JSON.stringify({ 
                            channel_id: channel_id,
                            minutes: 180
                        }),
                        "action_id": "extend_time_180"
                    },
                    {
                        "type": "button",
                        "text": {
                            "type": "plain_text",
                            "text": "Release"
                        },
                        "value": JSON.stringify({ 
                            channel_id: channel_id 
                        }),
                        "action_id": "release_env",
                        "style": "danger"
                    }
                ]
            }
        ]
    });
}

// Update the interactions endpoint to handle queue join and notify current reservation holder
app.post("/slack/interactions", verifySlackSignature, rateLimitMiddleware, bodyParser.json(), async (req, res) => {
    const payload = JSON.parse(req.body.payload);
    const { user, actions } = payload;
    
    try {
        // Safely parse the button value
        let buttonValue = {};
        try {
            buttonValue = actions[0].value ? JSON.parse(actions[0].value) : {};
        } catch (error) {
            console.error("Error parsing button value:", error);
        }

        const originalChannelId = buttonValue.channel_id;

        if (actions[0].action_id === "cancel_queue") {
            await web.chat.postMessage({
                channel: user.id,
                text: `👍 No problem! You can check back later with \`/env-request\` when you need the environment.`
            });
            await printQueueStatus(originalChannelId);
            return res.send("");
        }

        if (actions[0].action_id === "reserve_capped_duration") {
            const buttonValue = JSON.parse(actions[0].value);
            const { duration, channel_id } = buttonValue;
            const currentReservation = getCurrentReservation(channel_id);
            if (currentReservation) {
                await web.chat.postMessage({
                    channel: user.id,
                    text: `⚠️ The environment is no longer available — someone else has it now.`
                });
                return res.send("");
            }
            const newReservation = {
                user_id: user.id,
                user_name: user.name,
                duration,
                channel_id,
                expirationTime: Date.now() + duration * 60000,
                reservedAt: Date.now(),
                reminderTimer: duration > 60 ? setTimeout(() => remindUserToExtend(user.id, channel_id), duration * 60000 - 10 * 60000) : null,
                releaseTimer: setTimeout(() => autoReleaseIfNoResponse(user.id, channel_id), duration * 60000)
            };
            setCurrentReservation(channel_id, newReservation);
            await updatePinnedMessage(channel_id);
            await web.chat.postMessage({ channel: user.id, text: `✅ Reserved for ${formatDuration(duration)}.` });
            await web.chat.postMessage({ channel: channel_id, text: `🚀 <@${user.id}> reserved the environment for ${formatDuration(duration)}.` });
            await printQueueStatus(channel_id);
            return res.send("");
        }

        if (actions[0].action_id === "handoff_accept") {
            const buttonValue = JSON.parse(actions[0].value);
            const { channel_id, duration } = buttonValue;
            const handoff = getPendingHandoff(channel_id);
            if (!handoff || handoff.user_id !== user.id) {
                await web.chat.postMessage({ channel: user.id, text: `ℹ️ That handoff is no longer active.` });
                return res.send("");
            }
            clearPendingHandoff(channel_id);
            const newReservation = {
                user_id: user.id,
                user_name: user.name,
                duration,
                channel_id,
                expirationTime: Date.now() + duration * 60000,
                reservedAt: Date.now(),
                reminderTimer: duration > 60 ? setTimeout(() => remindUserToExtend(user.id, channel_id), duration * 60000 - 10 * 60000) : null,
                releaseTimer: setTimeout(() => autoReleaseIfNoResponse(user.id, channel_id), duration * 60000)
            };
            setCurrentReservation(channel_id, newReservation);
            await reconcileQueueWithScheduled(channel_id, newReservation);
            await web.chat.postMessage({ channel: user.id, text: `✅ The environment is now yours! (${formatDuration(duration)})` });
            await updatePinnedMessage(channel_id);
            await printQueueStatus(channel_id);
            return res.send("");
        }

        if (actions[0].action_id === "handoff_schedule") {
            const buttonValue = JSON.parse(actions[0].value);
            const { channel_id, duration } = buttonValue;
            const handoff = getPendingHandoff(channel_id);
            if (!handoff || handoff.user_id !== user.id) {
                await web.chat.postMessage({ channel: user.id, text: `ℹ️ That handoff is no longer active.` });
                return res.send("");
            }
            clearPendingHandoff(channel_id);
            // Show time offset buttons
            await web.chat.postMessage({
                channel: user.id,
                text: `When would you like to schedule your reservation?`,
                blocks: [
                    {
                        "type": "section",
                        "text": { "type": "mrkdwn", "text": `When would you like to use the environment? (${formatDuration(duration)})` }
                    },
                    {
                        "type": "actions",
                        "elements": [
                            { "type": "button", "text": { "type": "plain_text", "text": "+1h" }, "value": JSON.stringify({ channel_id, duration, offset: 60 }), "action_id": "handoff_schedule_offset_60" },
                            { "type": "button", "text": { "type": "plain_text", "text": "+2h" }, "value": JSON.stringify({ channel_id, duration, offset: 120 }), "action_id": "handoff_schedule_offset_120" },
                            { "type": "button", "text": { "type": "plain_text", "text": "+3h" }, "value": JSON.stringify({ channel_id, duration, offset: 180 }), "action_id": "handoff_schedule_offset_180" }
                        ]
                    }
                ]
            });
            // Move to next in queue or mark available
            const queue = getQueue(channel_id);
            if (queue.length > 0) {
                const nextUser = getNextInQueue(channel_id);
                await initiateHandoff(channel_id, nextUser);
            } else {
                await updatePinnedMessage(channel_id);
            }
            return res.send("");
        }

        if (actions[0].action_id.startsWith("handoff_schedule_offset_")) {
            const buttonValue = JSON.parse(actions[0].value);
            const { channel_id, duration, offset } = buttonValue;
            const scheduledTime = Date.now() + offset * 60000;
            try {
                const userTimezone = await getUserTimezone(user.id);
                const entry = {
                    user_id: user.id,
                    user_name: user.name,
                    duration,
                    channel_id,
                    scheduledTime,
                    timezone: userTimezone,
                    scheduledTimer: setTimeout(() => activateScheduledReservation(channel_id, user.id), offset * 60000)
                };
                addScheduledReservation(channel_id, entry);
                await updatePinnedMessage(channel_id);
                await web.chat.postMessage({
                    channel: user.id,
                    text: `📅 Scheduled! Your reservation will start at ${formatScheduledTime(scheduledTime, userTimezone)} (${formatDuration(duration)}).`
                });
            } catch (error) {
                await web.chat.postMessage({
                    channel: user.id,
                    text: `⚠️ Can't schedule — ${error.message}. Try a different time.`
                });
            }
            return res.send("");
        }

        if (actions[0].action_id === "handoff_pass") {
            const buttonValue = JSON.parse(actions[0].value);
            const { channel_id } = buttonValue;
            const handoff = getPendingHandoff(channel_id);
            if (!handoff || handoff.user_id !== user.id) {
                await web.chat.postMessage({ channel: user.id, text: `ℹ️ That handoff is no longer active.` });
                return res.send("");
            }
            clearPendingHandoff(channel_id);
            await web.chat.postMessage({ channel: user.id, text: `👍 Passed! The environment will go to the next person in line.` });
            const queue = getQueue(channel_id);
            if (queue.length > 0) {
                const nextUser = getNextInQueue(channel_id);
                await initiateHandoff(channel_id, nextUser);
            } else {
                await updatePinnedMessage(channel_id);
                await web.chat.postMessage({ channel: channel_id, text: `✅ Environment is now available.` });
            }
            return res.send("");
        }

        if (actions[0].action_id === "keep_reservation") {
            const buttonValue = JSON.parse(actions[0].value || '{}');
            const channel_id = buttonValue.channel_id || originalChannelId;
            const currentReservation = getCurrentReservation(channel_id);
            if (!currentReservation || currentReservation.user_id !== user.id) {
                await web.chat.postMessage({
                    channel: user.id,
                    text: `ℹ️ That message is outdated — the status has changed. Check the channel for the current status.`
                });
            } else {
                await web.chat.postMessage({
                    channel: user.id,
                    text: `👍 Got it! Your reservation will continue as scheduled.`
                });
            }
            await printQueueStatus(channel_id || originalChannelId);
            return res.send("");
        }

        if (actions[0].action_id === "join_queue") {
            // Handle join queue - validate that the interaction is still valid
            try {
                const buttonValue = JSON.parse(actions[0].value);
                const { duration, channel_id } = buttonValue;
                
                const currentReservation = getCurrentReservation(channel_id);
                const queue = getQueue(channel_id);
                
                // Interaction is stale: environment is now available
                if (!currentReservation) {
                    const durationHint = duration <= 60 ? `${duration}min` : `${Math.round(duration / 60)} hours`;
                    await web.chat.postMessage({
                        channel: user.id,
                        text: `ℹ️ That message is outdated — the environment is now available. Run \`/env-request ${durationHint}\` in the channel to reserve it.`
                    });
                    return res.send("");
                }
                
                // Check if user already has the reservation
                if (currentReservation && currentReservation.user_id === user.id) {
                    await web.chat.postMessage({
                        channel: user.id,
                        text: `⚠️ You already have the environment reserved!`
                    });
                    await printQueueStatus(channel_id);
                    return res.send("");
                }
                
                // Check if user is already in queue
                const userInQueue = queue.find(item => item.user_id === user.id);
                if (userInQueue) {
                    const position = queue.indexOf(userInQueue) + 1;
                    await web.chat.postMessage({
                        channel: user.id,
                        text: `⚠️ You are already in the queue at position #${position}.`
                    });
                    await printQueueStatus(channel_id);
                    return res.send("");
                }
                
                // Add user to queue
                const queueEntry = { 
                    user_id: user.id, 
                    user_name: user.name,
                    duration,
                    channel_id,
                    expirationTime: Date.now() + duration * 60 * 1000
                };
                
                addToQueue(channel_id, queueEntry);
                await updatePinnedMessage(channel_id);
                
                await web.chat.postMessage({
                    channel: user.id,
                    text: `✅ Added to queue`
                });
                
                // Notify the current reservation holder
                if (currentReservation) {
                    await notifyReservationHolderOfQueueJoin(currentReservation.user_id, currentReservation.user_name, user.name, channel_id);
                }
                
                await printQueueStatus(channel_id);
                return res.send("");
            } catch (error) {
                console.error("Queue join error:", error);
                await printQueueStatus(originalChannelId);
                return res.send("");
            }
        }

        if (actions[0].action_id.startsWith('extend_time_')) {
            // Handle extend - validate interaction is still valid
            const buttonValue = JSON.parse(actions[0].value);
            const { channel_id, minutes: extraTime } = buttonValue;
            const currentReservation = getCurrentReservation(channel_id);
            
            if (!currentReservation || currentReservation.user_id !== user.id) {
                await web.chat.postMessage({
                    channel: user.id,
                    text: `ℹ️ That message is outdated — your reservation may have ended or the status has changed. Check the channel for the current status.`
                });
                return res.send("");
            }
            
            {
                // Check if extension would conflict with a scheduled reservation
                const nextScheduled = getNextScheduledReservation(channel_id);
                if (nextScheduled && nextScheduled.user_id !== user.id) {
                    const newExpiration = currentReservation.expirationTime + extraTime * 60000;
                    if (newExpiration > nextScheduled.scheduledTime) {
                        const scheduledTimeStr = formatScheduledTime(nextScheduled.scheduledTime, nextScheduled.timezone);
                        await web.chat.postMessage({
                            channel: user.id,
                            text: `⚠️ Can't extend — <@${nextScheduled.user_id}> has a scheduled reservation at ${scheduledTimeStr}.`
                        });
                        return res.send("");
                    }
                }

                const currentTime = Date.now();

                // Update expiration time
                currentReservation.expirationTime = currentReservation.expirationTime + (extraTime * 60 * 1000);
                
                // Clear any existing timers
                if (currentReservation.releaseTimer) {
                    clearTimeout(currentReservation.releaseTimer);
                }
                if (currentReservation.reminderTimer) {
                    clearTimeout(currentReservation.reminderTimer);
                }
                
                // Set new release timer based on updated expiration time
                currentReservation.releaseTimer = setTimeout(
                    () => autoReleaseIfNoResponse(user.id, channel_id),
                    currentReservation.expirationTime - currentTime
                );
                
                // Update the reservation in storage
                setCurrentReservation(channel_id, currentReservation);
                
                await web.chat.postMessage({
                    channel: user.id,
                    text: `✅ Extended`
                });
                
                await updatePinnedMessage(channel_id);
                
                await printQueueStatus(channel_id);
                return res.send("");
            }
        }

        if (actions[0].action_id === "release_env" || actions[0].action_id === "release_for_queue") {
            // Handle release - get channel_id from button value
            const buttonValue = JSON.parse(actions[0].value);
            const { channel_id } = buttonValue;
            const currentReservation = getCurrentReservation(channel_id);
            
            if (!currentReservation) {
                await web.chat.postMessage({
                    channel: user.id,
                    text: `⚠️ Unable to release - the environment appears to already be released.`
                });
                await printQueueStatus(channel_id || originalChannelId);
                return res.send("");
            }
            
            // Check that channel_id exists
            if (!channel_id) {
                console.error("Missing channel_id in button value:", buttonValue);
                await web.chat.postMessage({
                    channel: user.id,
                    text: `⚠️ Error releasing environment: missing channel information. The environment has been released.`
                });
                
                // Force release the environment anyway
                clearCurrentReservation(currentReservation.channel_id);
                await printQueueStatus(originalChannelId);
                return res.send("");
            }
            
            const result = await releaseEnvironment(user.id, channel_id);
            
            await web.chat.postMessage({
                channel: user.id,
                text: result || `⚠️ Your reservation has ended`
            });
            
            await printQueueStatus(channel_id);
            return res.send("");
        } else if (actions[0].action_id === "leave_queue") {
            // Handle leave queue button press
            // We need to find which channel this user is in queue for
            let targetChannelId = null;
            let userIndex = -1;
            
            // Search all channels to find which queue the user is in
            for (const [channel_id, channelQueue] of Object.entries(queues)) {
                if (channelQueue) {
                    const index = channelQueue.findIndex(item => item.user_id === user.id);
                    if (index !== -1) {
                        targetChannelId = channel_id;
                        userIndex = index;
                        break;
                    }
                }
            }
            
            if (userIndex === -1 || !targetChannelId) {
                await web.chat.postMessage({
                    channel: user.id,
                    text: `⚠️ You are not currently in any queue.`
                });
                await printQueueStatus(originalChannelId);
                return res.send("");
            }
            
            // Store the queue before removing the user
            const queue = getQueue(targetChannelId);
            const oldQueue = [...queue];
            
            // Remove user from queue
            removeFromQueue(targetChannelId, userIndex);
            await updatePinnedMessage(targetChannelId);
            
            // Notify the user who left
            await web.chat.postMessage({
                channel: user.id,
                text: `✅ You have been removed from the queue.`
            });
            
            // Notify remaining queue members of their updated position
            await notifyQueueMembersOfUpdate(oldQueue, user.name, targetChannelId);
            
            await printQueueStatus(targetChannelId);
            return res.send("✅ Left queue");
        }
        
        await printQueueStatus(originalChannelId);
        return res.send("");
    } catch (error) {
        console.error("Error in interactions endpoint:", error);
        // Send a generic error message to the user
        try {
            await web.chat.postMessage({
                channel: user.id,
                text: `⚠️ Sorry, something went wrong processing your action. Please try again.`
            });
        } catch (innerError) {
            console.error("Error sending error message:", innerError);
        }
        await printQueueStatus(originalChannelId);
        return res.send("");
    }
});

// New function to notify the reservation holder when someone joins the queue
async function notifyReservationHolderOfQueueJoin(holderId, holderName, joinerName, channel_id) {
    try {
        // When holderId is null (old topic format), post to channel and @mention holder
        const targetChannel = holderId || channel_id;
        const introText = holderId
            ? `📢 *@${joinerName}* just joined the queue for the environment you currently have reserved.\n\nAre you still using it? If not, would you like to release it for them?`
            : `📢 *@${joinerName}* just joined the queue for the environment @${holderName} currently has reserved.\n\n@${holderName}, are you still using it? If not, run \`/env-release\` to free it for them.`;
        
        const blocks = [
            { "type": "section", "text": { "type": "mrkdwn", "text": introText } }
        ];
        // Only add buttons when we can DM the holder (holderId exists)
        if (holderId) {
            blocks.push({
                "type": "actions",
                "elements": [
                    { "type": "button", "text": { "type": "plain_text", "text": "Release Environment" }, "value": JSON.stringify({ channel_id, action: "release" }), "action_id": "release_for_queue", "style": "primary" },
                    { "type": "button", "text": { "type": "plain_text", "text": "I'm Still Using It" }, "value": JSON.stringify({ channel_id, action: "keep" }), "action_id": "keep_reservation" }
                ]
            });
        }
        await web.chat.postMessage({
            channel: targetChannel,
            text: `📢 @${joinerName} just joined the queue.`,
            blocks
        });
    } catch (error) {
        console.error(`Error notifying reservation holder:`, error);
    }
}

async function autoReleaseIfNoResponse(user_id, channel_id) {
    const currentReservation = getCurrentReservation(channel_id);
    if (currentReservation && currentReservation.user_id === user_id) {
        await releaseEnvironment(user_id, channel_id);
        
        await web.chat.postMessage({
            channel: user_id,
            text: `⚠️ Your reservation has ended`
        });
    }
    await printQueueStatus(channel_id);
}

// Activate a scheduled reservation when its time arrives
async function activateScheduledReservation(channel_id, user_id) {
    const scheduled = getScheduledReservations(channel_id);
    const entry = scheduled.find(s => s.user_id === user_id);
    if (!entry) return;

    const currentReservation = getCurrentReservation(channel_id);

    if (currentReservation && currentReservation.user_id === user_id) {
        // User already holds the env (got it early from queue) — extend
        const scheduledEnd = entry.scheduledTime + entry.duration * 60000;
        if (scheduledEnd > currentReservation.expirationTime) {
            currentReservation.expirationTime = scheduledEnd;
            if (currentReservation.releaseTimer) clearTimeout(currentReservation.releaseTimer);
            if (currentReservation.reminderTimer) clearTimeout(currentReservation.reminderTimer);
            const msUntilRelease = scheduledEnd - Date.now();
            currentReservation.releaseTimer = setTimeout(() => autoReleaseIfNoResponse(user_id, channel_id), msUntilRelease);
            currentReservation.reminderTimer = msUntilRelease > 10 * 60 * 1000
                ? setTimeout(() => remindUserToExtend(user_id, channel_id), msUntilRelease - 10 * 60 * 1000)
                : null;
            setCurrentReservation(channel_id, currentReservation);
        }
        removeScheduledReservation(channel_id, user_id);
        await web.chat.postMessage({
            channel: user_id,
            text: `📅 Your scheduled time has started — reservation extended until ${formatScheduledTime(currentReservation.expirationTime, entry.timezone)}.`
        });
        await updatePinnedMessage(channel_id);
    } else if (!currentReservation && !getPendingHandoff(channel_id)) {
        // Env is free — create normal reservation
        const duration = entry.duration;
        const newReservation = {
            user_id: entry.user_id,
            user_name: entry.user_name,
            duration,
            channel_id,
            expirationTime: Date.now() + duration * 60000,
            reservedAt: Date.now(),
            reminderTimer: duration > 60 ? setTimeout(() => remindUserToExtend(user_id, channel_id), duration * 60000 - 10 * 60000) : null,
            releaseTimer: setTimeout(() => autoReleaseIfNoResponse(user_id, channel_id), duration * 60000)
        };
        removeScheduledReservation(channel_id, user_id);
        setCurrentReservation(channel_id, newReservation);
        await web.chat.postMessage({ channel: user_id, text: `✅ Your scheduled reservation is now active! (${formatDuration(duration)})` });
        await web.chat.postMessage({ channel: channel_id, text: `📅 <@${user_id}>'s scheduled reservation is now active.` });
        await updatePinnedMessage(channel_id);
    } else {
        // Env is busy (someone else) — put at front of queue
        removeScheduledReservation(channel_id, user_id);
        const queue = getQueue(channel_id);
        queue.unshift({ user_id: entry.user_id, user_name: entry.user_name, duration: entry.duration, channel_id });
        await web.chat.postMessage({
            channel: user_id,
            text: `⏳ Your scheduled time arrived but the environment is busy. You've been placed at the front of the queue.`
        });
        await updatePinnedMessage(channel_id);
    }
}

// If a promoted queue user also has a scheduled reservation, extend to cover scheduled window
async function reconcileQueueWithScheduled(channel_id, newReservation) {
    const scheduled = getScheduledReservations(channel_id);
    const entry = scheduled.find(s => s.user_id === newReservation.user_id);
    if (!entry) return;

    const scheduledEnd = entry.scheduledTime + entry.duration * 60000;
    if (scheduledEnd > newReservation.expirationTime) {
        newReservation.expirationTime = scheduledEnd;
        if (newReservation.releaseTimer) clearTimeout(newReservation.releaseTimer);
        if (newReservation.reminderTimer) clearTimeout(newReservation.reminderTimer);
        const msUntilRelease = scheduledEnd - Date.now();
        newReservation.releaseTimer = setTimeout(() => autoReleaseIfNoResponse(newReservation.user_id, channel_id), msUntilRelease);
        newReservation.reminderTimer = msUntilRelease > 10 * 60 * 1000
            ? setTimeout(() => remindUserToExtend(newReservation.user_id, channel_id), msUntilRelease - 10 * 60 * 1000)
            : null;
        setCurrentReservation(channel_id, newReservation);
    }
    removeScheduledReservation(channel_id, newReservation.user_id);
    await web.chat.postMessage({
        channel: newReservation.user_id,
        text: `📅 You got the env early! Reservation extended to cover your scheduled time until ${formatScheduledTime(newReservation.expirationTime, entry.timezone)}.`
    });
}

// Initiate handoff: DM the next queuer with options instead of auto-assigning
async function initiateHandoff(channel_id, nextUser) {
    // Set pending handoff state
    const graceTimer = setTimeout(async () => {
        // Auto-accept after 3 minutes if no response
        const handoff = getPendingHandoff(channel_id);
        if (!handoff || handoff.user_id !== nextUser.user_id) return;
        clearPendingHandoff(channel_id);

        const newReservation = {
            user_id: nextUser.user_id,
            user_name: nextUser.user_name,
            duration: nextUser.duration,
            channel_id,
            expirationTime: Date.now() + nextUser.duration * 60000,
            reservedAt: Date.now(),
            reminderTimer: nextUser.duration > 60 ? setTimeout(() => remindUserToExtend(nextUser.user_id, channel_id), nextUser.duration * 60000 - 10 * 60000) : null,
            releaseTimer: setTimeout(() => autoReleaseIfNoResponse(nextUser.user_id, channel_id), nextUser.duration * 60000)
        };
        setCurrentReservation(channel_id, newReservation);
        await reconcileQueueWithScheduled(channel_id, newReservation);
        await web.chat.postMessage({
            channel: nextUser.user_id,
            text: `⏰ No response received — the environment has been reserved for you (${formatDuration(nextUser.duration)}).`
        });
        await updatePinnedMessage(channel_id);
    }, 3 * 60 * 1000);

    setPendingHandoff(channel_id, {
        user_id: nextUser.user_id,
        user_name: nextUser.user_name,
        duration: nextUser.duration,
        graceTimer
    });

    await updatePinnedMessage(channel_id);

    // DM the user with options
    await web.chat.postMessage({
        channel: nextUser.user_id,
        text: `The environment is now available! What would you like to do?`,
        blocks: [
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": `🎉 The environment is now available! What would you like to do?`
                }
            },
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": { "type": "plain_text", "text": "Take it now" },
                        "value": JSON.stringify({ channel_id, duration: nextUser.duration }),
                        "action_id": "handoff_accept",
                        "style": "primary"
                    },
                    {
                        "type": "button",
                        "text": { "type": "plain_text", "text": "Schedule for later" },
                        "value": JSON.stringify({ channel_id, duration: nextUser.duration }),
                        "action_id": "handoff_schedule"
                    },
                    {
                        "type": "button",
                        "text": { "type": "plain_text", "text": "Pass to next person" },
                        "value": JSON.stringify({ channel_id }),
                        "action_id": "handoff_pass",
                        "style": "danger"
                    }
                ]
            }
        ]
    });
}

// Release when stub reservation (no user_id) expires - can't DM holder
async function releaseEnvironmentStub(channel_id) {
    const currentReservation = getCurrentReservation(channel_id);
    if (!currentReservation || currentReservation.user_id !== null) return;

    if (currentReservation.releaseTimer) clearTimeout(currentReservation.releaseTimer);
    clearCurrentReservation(channel_id);

    const queue = getQueue(channel_id);
    if (queue.length > 0) {
        const nextUser = getNextInQueue(channel_id);
        await initiateHandoff(channel_id, nextUser);
    } else {
        await updatePinnedMessage(channel_id);
    }
}

// Update releaseEnvironment to handle per-channel state
async function releaseEnvironment(user_id, channel_id) {
    const currentReservation = getCurrentReservation(channel_id);

    if (!currentReservation || currentReservation.user_id !== user_id) {
        return "⚠️ You don't have the environment reserved.";
    }

    // Clear both timers
    if (currentReservation.releaseTimer) {
        clearTimeout(currentReservation.releaseTimer);
    }
    if (currentReservation.reminderTimer) {
        clearTimeout(currentReservation.reminderTimer);
    }

    clearCurrentReservation(channel_id);

    if (!channel_id) {
        return "⚠️ Environment released, but couldn't update channel topic due to missing channel information.";
    }

    const queue = getQueue(channel_id);
    if (queue.length > 0) {
        const nextUser = getNextInQueue(channel_id);
        await initiateHandoff(channel_id, nextUser);
        return "";
    }

    await updatePinnedMessage(channel_id);
    return "";
}

// Update the env-leave-queue endpoint to notify other queue members
app.post("/env-leave-queue", verifySlackSignature, rateLimitMiddleware, async (req, res) => {
    const { user_id, user_name, channel_id } = req.body;
    
    if (!channel_id || channel_id.startsWith('D')) {
        return res.send("⚠️ Please run `/env-leave-queue` in a channel, not in a direct message.");
    }
    
    const queue = getQueue(channel_id);
    
    // Check if user is in the queue
    const userIndex = queue.findIndex(item => item.user_id === user_id);
    
    if (userIndex === -1) {
        return res.send("⚠️ You are not in the queue");
    }
    
    // Store the queue before removing the user
    const oldQueue = [...queue];
    
    // Remove user from queue
    removeFromQueue(channel_id, userIndex);
    await updatePinnedMessage(channel_id);
    
    // Notify remaining queue members of their updated position
    await notifyQueueMembersOfUpdate(oldQueue, user_name, channel_id);
    
    const updatedQueue = getQueue(channel_id);
    if (updatedQueue.length > 0) {
        await printQueueStatus(channel_id);
    } else {
        await web.chat.postMessage({
            channel: channel_id,
            text: "📋 Queue is now empty"
        });
    }
    
    return res.send("");
});

// Function to notify queue members when positions change
async function notifyQueueMembersOfUpdate(oldQueue, departedUserName, channel_id) {
    const queue = getQueue(channel_id);
    
    if (queue.length === 0) {
        return;
    }
    
    for (let i = 0; i < queue.length; i++) {
        const user = queue[i];
        const oldPosition = oldQueue.findIndex(item => item.user_id === user.user_id) + 1;
        const newPosition = i + 1;
        
        if (oldPosition !== newPosition) {
            try {
                await web.chat.postMessage({
                    channel: user.user_id,
                    text: `📊 Your position in the queue has changed from #${oldPosition} to #${newPosition} because @${departedUserName} left the queue.`,
                    blocks: [
                        {
                            "type": "section",
                            "text": {
                                "type": "mrkdwn",
                                "text": `📊 *Queue Update*\n@${departedUserName} left the queue. Your position has moved up from #${oldPosition} to #${newPosition}.`
                            }
                        },
                        {
                            "type": "actions",
                            "elements": [
                                {
                                    "type": "button",
                                    "text": {
                                        "type": "plain_text",
                                        "text": "Leave Queue"
                                    },
                                    "value": "leave_queue",
                                    "action_id": "leave_queue",
                                    "style": "danger"
                                }
                            ]
                        }
                    ]
                });
            } catch (error) {
                console.error(`Error notifying ${user.user_name} of queue change:`, error);
            }
        }
    }
}

// Add a test endpoint to verify bot permissions
app.post("/test-dm", async (req, res) => {
    const { user_id } = req.body;
    
    try {
        // Test bot token
        const auth = await web.auth.test();
        
        // Try to open DM
        const conv = await web.conversations.open({ users: user_id });
        
        // Try to send message
        const msg = await web.chat.postMessage({
            channel: conv.channel.id,
            text: "Test message - checking bot permissions"
        });
        
        return res.send("Test completed successfully - check logs");
    } catch (error) {
        console.error('Test failed:', error);
        return res.send(`Test failed: ${error.message}`);
    }
});

// Update pinned message and post queue status when queue changes
async function printQueueStatus(channel_id) {
    await updatePinnedMessage(channel_id);
    const currentReservation = getCurrentReservation(channel_id);
    const queue = getQueue(channel_id);
    let message = "";
    if (currentReservation && queue.length > 0) {
        message += `🚀 *Current:* @${currentReservation.user_name} until ${formatEndTime(Math.ceil((currentReservation.expirationTime - Date.now()) / (60 * 1000)))}\n`;
    }
    if (queue.length > 0) {
        message += `\n📋 *Queue:*\n`;
        queue.forEach((user, index) => {
            message += `${index + 1}. @${user.user_name} (${formatDuration(user.duration)})\n`;
        });
    }
    if (message) {
        await web.chat.postMessage({
            channel: channel_id,
            text: message,
            mrkdwn: true
        });
    }
}

// Graceful shutdown handler
function gracefulShutdown() {
    console.log('Graceful shutdown initiated');

    // Clear all active reservation timers
    Object.values(reservations).forEach(reservation => {
        if (reservation) {
            if (reservation.releaseTimer) clearTimeout(reservation.releaseTimer);
            if (reservation.reminderTimer) clearTimeout(reservation.reminderTimer);
        }
    });

    // Clear all scheduled reservation timers
    Object.keys(scheduledReservations).forEach(ch => clearAllScheduledReservations(ch));

    // Clear all pending handoff timers
    Object.keys(pendingHandoffs).forEach(ch => clearPendingHandoff(ch));

    console.log('Cleared all active timers');
    process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Error handling for unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error(new Error(`Unhandled Rejection: ${reason}`), { promise });
});

process.on('uncaughtException', (error) => {
    console.error(error, { type: 'uncaughtException' });
    process.exit(1);
});

app.listen(port, async () => {
    console.log(`Server running on port ${port}`);
    
    // Recover any existing reservations after restart
    console.log('🔄 Checking for existing reservations...');
    await recoverReservationState();
    console.log('✅ Startup recovery complete');
});
