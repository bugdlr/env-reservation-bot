// Test scheduling functions: parseScheduledRequest, parseTimeToEpoch, formatScheduledTime,
// buildPinnedMessageContent/parsePinnedMessageContent round-trip, overlap validation, reconciliation

// --- Copy pure functions from server.js ---

function parseDuration(input) {
    if (!input || typeof input !== 'string') {
        return 120;
    }
    const sanitized = input.trim().toLowerCase().substring(0, 50);
    if (sanitized === '') {
        return 120;
    }
    const hourMatch = sanitized.match(/^(\d{1,2})\s*(?:hours?|hrs?|h)$/);
    const minuteMatch = sanitized.match(/^(\d{1,3})\s*(?:minutes?|mins?|m)$/);
    const numberMatch = sanitized.match(/^(\d{1,3})$/);
    let duration = 0;
    if (hourMatch) {
        duration = parseInt(hourMatch[1], 10) * 60;
    } else if (minuteMatch) {
        duration = parseInt(minuteMatch[1], 10);
    } else if (numberMatch) {
        duration = parseInt(numberMatch[1], 10);
    } else {
        throw new Error('Invalid duration format. Use formats like "30min", "2 hours", or "90"');
    }
    if (duration < 5) throw new Error('Duration too short. Minimum is 5 minutes.');
    if (duration > 480) throw new Error('Duration too long. Maximum is 8 hours.');
    return duration;
}

function formatDuration(minutes) {
    if (minutes >= 60) {
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        if (remainingMinutes === 0) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
        return `${hours} ${hours === 1 ? 'hour' : 'hours'} and ${remainingMinutes} minutes`;
    }
    return `${minutes} minutes`;
}

function formatEndTime(durationMinutes) {
    const endTime = new Date(Date.now() + (durationMinutes * 60 * 1000));
    const ptTime = endTime.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: true });
    const etTime = endTime.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true });
    return `${ptTime} PST / ${etTime} EST`;
}

function formatScheduledTime(epochMs, timezone) {
    const tz = timezone || 'America/Los_Angeles';
    const targetDate = new Date(epochMs);
    const now = new Date();
    const timeStr = targetDate.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
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

function parseScheduledRequest(text) {
    if (!text || typeof text !== 'string' || text.trim() === '') {
        return { duration: 120, atText: null };
    }
    const trimmed = text.trim();
    const atIndex = trimmed.toLowerCase().indexOf(' at ');
    if (atIndex === -1) {
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

function parseTimeToEpoch(timeStr, userTimezone) {
    const tz = userTimezone || 'America/Los_Angeles';
    const s = timeStr.trim();
    let hours, minutes = 0;
    const meridiemFull = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    const meridiemShort = s.match(/^(\d{1,2})\s*(AM|PM)$/i);
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
    const now = new Date();
    const nowInTz = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const target = new Date(nowInTz);
    target.setHours(hours, minutes, 0, 0);
    if (target <= nowInTz) {
        target.setDate(target.getDate() + 1);
    }
    const tzOffset = nowInTz.getTime() - now.getTime();
    return target.getTime() - tzOffset;
}

// Pinned message functions
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
    let recovery = '';
    if (reservation) {
        const timeStr = formatEndTime(Math.ceil((reservation.expirationTime - Date.now()) / (60 * 1000)));
        const safeUserName = (reservation.user_name || 'User').replace(/[|·;()]/g, ' ').trim();
        const holderPart = `Holder <@${reservation.user_id}> (${safeUserName})`;
        const expiresPart = `Expires ${reservation.expirationTime} · Display ${timeStr}`;
        const queuePart = (queueEntries || []).length > 0
            ? (queueEntries || []).map(e => `<@${e.user_id}> ${e.duration} min (${(e.user_name || 'User').replace(/[|·;]/g, ' ')})`).join(' · ')
            : '';
        recovery = queuePart ? `${holderPart} · ${expiresPart} · Queue: ${queuePart}` : `${holderPart} · ${expiresPart}`;
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

function parsePinnedMessageContent(text) {
    if (!text || !text.includes(PINNED_MARKER)) return null;
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
                queue.push({ user_id: m[1], duration: parseInt(m[2], 10) || 120, user_name: m[3] || 'User' });
            }
        });
    }
    if (!userId || (!timeStr && !epoch)) return null;
    return { user_id: userId, user_name: userName, epoch, timeString: timeStr, queue, scheduled };
}

// Overlap validation (standalone version of addScheduledReservation logic)
function validateNoOverlap(existing, newEntry) {
    const newStart = newEntry.scheduledTime;
    const newEnd = newStart + newEntry.duration * 60000;
    for (const entry of existing) {
        const existingStart = entry.scheduledTime;
        const existingEnd = existingStart + entry.duration * 60000;
        if (newStart < existingEnd && newEnd > existingStart) {
            throw new Error('Overlap');
        }
    }
    return true;
}

// Reconciliation logic (standalone)
function reconcileQueueWithScheduled(newReservation, scheduledEntry) {
    if (!scheduledEntry) return { changed: false };
    const scheduledEnd = scheduledEntry.scheduledTime + scheduledEntry.duration * 60000;
    if (scheduledEnd > newReservation.expirationTime) {
        return { changed: true, newExpiration: scheduledEnd };
    }
    return { changed: false };
}

// --- Test runner ---

let passed = 0;
let failed = 0;

function assert(condition, testName) {
    if (condition) {
        console.log(`✅ PASS: ${testName}`);
        passed++;
    } else {
        console.log(`❌ FAIL: ${testName}`);
        failed++;
    }
}

function assertThrows(fn, testName) {
    try {
        fn();
        console.log(`❌ FAIL: ${testName} (expected error, got none)`);
        failed++;
    } catch (e) {
        console.log(`✅ PASS: ${testName} (threw: ${e.message})`);
        passed++;
    }
}

// ========== parseScheduledRequest tests ==========
console.log('\n--- parseScheduledRequest ---\n');

{
    const r = parseScheduledRequest('2h at 3:00 PM');
    assert(r.duration === 120 && r.atText === '3:00 PM', '"2h at 3:00 PM" → duration 120, atText "3:00 PM"');
}
{
    const r = parseScheduledRequest('30min at 15:00');
    assert(r.duration === 30 && r.atText === '15:00', '"30min at 15:00" → duration 30, atText "15:00"');
}
{
    const r = parseScheduledRequest('2h');
    assert(r.duration === 120 && r.atText === null, '"2h" → duration 120, atText null');
}
{
    const r = parseScheduledRequest('90 at 3pm');
    assert(r.duration === 90 && r.atText === '3pm', '"90 at 3pm" → duration 90, atText "3pm"');
}
{
    const r = parseScheduledRequest('at 3:00 PM');
    assert(r.duration === 120 && r.atText === '3:00 PM', '"at 3:00 PM" → duration 120 (default), atText "3:00 PM"');
}
{
    const r = parseScheduledRequest('');
    assert(r.duration === 120 && r.atText === null, '"" → duration 120 (default), atText null');
}

// ========== parseTimeToEpoch tests ==========
console.log('\n--- parseTimeToEpoch ---\n');

{
    const epoch = parseTimeToEpoch('3:00 PM', 'America/Los_Angeles');
    const d = new Date(epoch);
    const inTz = new Date(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    assert(inTz.getHours() === 15 && inTz.getMinutes() === 0, '"3:00 PM" PT → 3 PM in PT');
    assert(epoch > Date.now(), '"3:00 PM" PT → future epoch');
}
{
    const epoch = parseTimeToEpoch('15:00', 'America/New_York');
    const d = new Date(epoch);
    const inTz = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    assert(inTz.getHours() === 15 && inTz.getMinutes() === 0, '"15:00" ET → 3 PM in ET');
}
{
    const epoch = parseTimeToEpoch('3pm', 'America/Los_Angeles');
    const d = new Date(epoch);
    const inTz = new Date(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    assert(inTz.getHours() === 15, '"3pm" PT → 3 PM in PT');
}

assertThrows(() => parseTimeToEpoch('25:00', 'America/Los_Angeles'), '"25:00" → error (invalid hour)');
assertThrows(() => parseTimeToEpoch('abc', 'America/Los_Angeles'), '"abc" → error (invalid format)');

// ========== formatScheduledTime tests ==========
console.log('\n--- formatScheduledTime ---\n');

{
    // Create a time for today at 3 PM PT (if it's future), otherwise tomorrow
    const epoch = parseTimeToEpoch('3:00 PM', 'America/Los_Angeles');
    const result = formatScheduledTime(epoch, 'America/Los_Angeles');
    assert(result.includes('3:00 PM') && (result.includes('today') || result.includes('tomorrow')),
        `formatScheduledTime(3PM PT) → "${result}" (contains "3:00 PM" and today/tomorrow)`);
}

// ========== buildPinnedMessageContent / parsePinnedMessageContent round-trip ==========
console.log('\n--- Pinned message round-trip ---\n');

{
    // Active reservation + scheduled
    const reservation = { user_id: 'U123', user_name: 'alice', expirationTime: Date.now() + 60 * 60000 };
    const scheduled = [{ user_id: 'U789', user_name: 'bob.lee', scheduledTime: Date.now() + 2 * 60 * 60000, duration: 90, timezone: 'America/New_York' }];
    const content = buildPinnedMessageContent(reservation, [], scheduled);
    const parsed = parsePinnedMessageContent(content);
    assert(parsed !== null && parsed.user_id === 'U123', 'Round-trip: active reservation user_id preserved');
    assert(parsed.scheduled.length === 1, 'Round-trip: 1 scheduled entry preserved');
    assert(parsed.scheduled[0].user_id === 'U789', 'Round-trip: scheduled user_id preserved');
    assert(parsed.scheduled[0].duration === 90, 'Round-trip: scheduled duration preserved');
    assert(parsed.scheduled[0].timezone === 'America/New_York', 'Round-trip: scheduled timezone preserved');
}

{
    // Available + scheduled only
    const scheduled = [{ user_id: 'U789', user_name: 'bob', scheduledTime: Date.now() + 60 * 60000, duration: 60, timezone: 'America/Los_Angeles' }];
    const content = buildPinnedMessageContent(null, [], scheduled);
    const parsed = parsePinnedMessageContent(content);
    assert(parsed.available === true, 'Available + scheduled: available is true');
    assert(parsed.scheduled.length === 1, 'Available + scheduled: 1 scheduled entry');
}

{
    // Active only (no scheduled) — backward compat
    const reservation = { user_id: 'U123', user_name: 'alice', expirationTime: Date.now() + 60 * 60000 };
    const content = buildPinnedMessageContent(reservation, []);
    const parsed = parsePinnedMessageContent(content);
    assert(parsed.user_id === 'U123', 'Active only: user_id parsed');
    assert(!parsed.scheduled || parsed.scheduled.length === 0, 'Active only: no scheduled entries');
}

{
    // Active reservation + queue + scheduled
    const reservation = { user_id: 'U123', user_name: 'alice', expirationTime: Date.now() + 60 * 60000 };
    const queue = [{ user_id: 'U456', user_name: 'jane', duration: 60 }];
    const scheduled = [
        { user_id: 'U789', user_name: 'bob', scheduledTime: Date.now() + 2 * 60 * 60000, duration: 90, timezone: 'America/New_York' },
        { user_id: 'U012', user_name: 'dave', scheduledTime: Date.now() + 4 * 60 * 60000, duration: 120, timezone: 'America/Los_Angeles' }
    ];
    const content = buildPinnedMessageContent(reservation, queue, scheduled);
    const parsed = parsePinnedMessageContent(content);
    assert(parsed.user_id === 'U123', 'Full: holder preserved');
    assert(parsed.queue.length === 1 && parsed.queue[0].user_id === 'U456', 'Full: queue preserved');
    assert(parsed.scheduled.length === 2, 'Full: 2 scheduled entries preserved');
    assert(parsed.scheduled[0].user_id === 'U789' && parsed.scheduled[1].user_id === 'U012', 'Full: scheduled order preserved');
}

{
    // Old format (no epoch) backward compat
    const oldFormat = `${PINNED_MARKER}\n\n*In use by:* <@U123>\n*Expires:* 2:30 PM PST / 5:30 PM EST\n\n${RECOVERY_PREFIX}Holder <@U123> (alice) · Expires 2:30 PM PST / 5:30 PM EST${RECOVERY_SUFFIX}`;
    const parsed = parsePinnedMessageContent(oldFormat);
    assert(parsed !== null && parsed.user_id === 'U123', 'Old format: user_id parsed');
    assert(parsed.epoch === null, 'Old format: no epoch');
}

// ========== Overlap validation ==========
console.log('\n--- Overlap validation ---\n');

{
    // No existing, add one → success
    const result = validateNoOverlap([], { scheduledTime: hour(14), duration: 60 });
    assert(result === true, 'No existing + add one → success');
}

function hour(h) {
    // Returns epoch for today at hour h (UTC)
    const d = new Date();
    d.setHours(h, 0, 0, 0);
    return d.getTime();
}

{
    // Existing 2-3 PM, add 3-4 PM (adjacent) → success
    const existing = [{ scheduledTime: hour(14), duration: 60 }];
    const result = validateNoOverlap(existing, { scheduledTime: hour(15), duration: 60 });
    assert(result === true, 'Adjacent (2-3 PM + 3-4 PM) → success');
}

{
    // Existing 2-3 PM, add 2:30-3:30 PM → overlap
    const existing = [{ scheduledTime: hour(14), duration: 60 }];
    assertThrows(() => validateNoOverlap(existing, { scheduledTime: hour(14) + 30 * 60000, duration: 60 }), 'Overlap (2-3 PM + 2:30-3:30 PM) → error');
}

{
    // Existing 2-3 PM, add 1-2:30 PM → overlap
    const existing = [{ scheduledTime: hour(14), duration: 60 }];
    assertThrows(() => validateNoOverlap(existing, { scheduledTime: hour(13), duration: 90 }), 'Overlap (2-3 PM + 1-2:30 PM) → error');
}

{
    // Existing 2-3 PM and 4-5 PM, add 3:15-3:45 PM (in gap) → success
    const existing = [{ scheduledTime: hour(14), duration: 60 }, { scheduledTime: hour(16), duration: 60 }];
    const result = validateNoOverlap(existing, { scheduledTime: hour(15) + 15 * 60000, duration: 30 });
    assert(result === true, 'In gap (3:15-3:45 PM between 2-3 and 4-5) → success');
}

{
    // Existing 2-3 PM, add 1-1:30 PM (before, no overlap) → success, sorted first
    const existing = [{ scheduledTime: hour(14), duration: 60 }];
    const result = validateNoOverlap(existing, { scheduledTime: hour(13), duration: 30 });
    assert(result === true, 'Before (1-1:30 PM before 2-3 PM) → success');
}

// ========== Reconciliation logic ==========
console.log('\n--- Reconciliation ---\n');

{
    // User promoted, scheduled ends later → extend
    const newRes = { user_id: 'U123', expirationTime: Date.now() + 60 * 60000 };
    const sched = { scheduledTime: Date.now() + 90 * 60000, duration: 60 }; // ends at +150 min
    const result = reconcileQueueWithScheduled(newRes, sched);
    assert(result.changed === true, 'Scheduled ends later → changed');
    assert(result.newExpiration === sched.scheduledTime + 60 * 60000, 'Scheduled ends later → new expiration correct');
}

{
    // User promoted, scheduled ends earlier → no change
    const newRes = { user_id: 'U123', expirationTime: Date.now() + 120 * 60000 };
    const sched = { scheduledTime: Date.now() + 30 * 60000, duration: 30 }; // ends at +60 min
    const result = reconcileQueueWithScheduled(newRes, sched);
    assert(result.changed === false, 'Scheduled ends earlier → no change');
}

{
    // User promoted, no scheduled → no change
    const newRes = { user_id: 'U123', expirationTime: Date.now() + 60 * 60000 };
    const result = reconcileQueueWithScheduled(newRes, null);
    assert(result.changed === false, 'No scheduled → no change');
}

// ========== Summary ==========
console.log(`\n📝 Summary: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
    process.exit(1);
}
