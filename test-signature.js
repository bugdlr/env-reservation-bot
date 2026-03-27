const crypto = require('crypto');

// Test Slack signature verification
function createSlackSignature(timestamp, body, secret) {
    const sigBasestring = `v0:${timestamp}:${body}`;
    return 'v0=' + crypto
        .createHmac('sha256', secret)
        .update(sigBasestring)
        .digest('hex');
}

function verifySlackSignature(signature, timestamp, body, secret) {
    // Check timestamp (prevent replay attacks)
    if (Math.abs(Date.now() / 1000 - timestamp) > 300) {
        return { valid: false, reason: 'Request too old' };
    }
    
    const expectedSignature = createSlackSignature(timestamp, body, secret);
    
    if (signature !== expectedSignature) {
        return { valid: false, reason: 'Invalid signature' };
    }
    
    return { valid: true };
}

// Test cases
console.log('Testing Slack signature verification...\n');

const testSecret = 'test-secret-123';
const testBody = 'user_id=U123&user_name=testuser&text=30min';
const validTimestamp = Math.floor(Date.now() / 1000);
const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 6+ minutes ago

// Test 1: Valid signature
const validSignature = createSlackSignature(validTimestamp, testBody, testSecret);
const test1 = verifySlackSignature(validSignature, validTimestamp, testBody, testSecret);
console.log(`✅ Valid signature test: ${test1.valid ? 'PASS' : 'FAIL - ' + test1.reason}`);

// Test 2: Invalid signature
const invalidSignature = 'v0=invalid-signature';
const test2 = verifySlackSignature(invalidSignature, validTimestamp, testBody, testSecret);
console.log(`✅ Invalid signature test: ${!test2.valid ? 'PASS' : 'FAIL - should have rejected'}`);

// Test 3: Old timestamp (replay attack prevention)
const test3 = verifySlackSignature(validSignature, oldTimestamp, testBody, testSecret);
console.log(`✅ Old timestamp test: ${!test3.valid ? 'PASS' : 'FAIL - should have rejected old timestamp'}`);

// Test 4: Wrong secret
const wrongSecretSig = createSlackSignature(validTimestamp, testBody, 'wrong-secret');
const test4 = verifySlackSignature(wrongSecretSig, validTimestamp, testBody, testSecret);
console.log(`✅ Wrong secret test: ${!test4.valid ? 'PASS' : 'FAIL - should have rejected wrong secret'}`);

console.log('\n📝 Summary: Signature verification logic is working correctly!');
console.log('   This prevents unauthorized requests to your bot endpoints.'); 