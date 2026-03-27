// Test the parseDuration function
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

// Test cases
const testCases = [
    ['30min', 30],
    ['2 hours', 120],
    ['90', 90],
    ['', 120], // default
    ['5h', 300],
    ['600', null], // should error - too long
    ['2', null], // should error - too short
    ['invalid text', null], // should error
    ['999999 hours', null] // should error
];

console.log('Testing input validation...\n');

testCases.forEach(([input, expected]) => {
    try {
        const result = parseDuration(input);
        if (expected === null) {
            console.log(`❌ FAIL: "${input}" should have thrown error, but got ${result}`);
        } else if (result === expected) {
            console.log(`✅ PASS: "${input}" → ${result} minutes`);
        } else {
            console.log(`❌ FAIL: "${input}" expected ${expected}, got ${result}`);
        }
    } catch (error) {
        if (expected === null) {
            console.log(`✅ PASS: "${input}" correctly threw error: ${error.message}`);
        } else {
            console.log(`❌ FAIL: "${input}" unexpected error: ${error.message}`);
        }
    }
}); 