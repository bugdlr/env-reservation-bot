require('dotenv').config();

console.log('Environment variables loaded:');
console.log('SLACK_BOT_TOKEN:', process.env.SLACK_BOT_TOKEN ? 'PRESENT' : 'MISSING');
console.log('SLACK_SIGNING_SECRET:', process.env.SLACK_SIGNING_SECRET ? 'PRESENT' : 'MISSING');
console.log('PORT:', process.env.PORT || 'default');

if (process.env.SLACK_SIGNING_SECRET) {
    console.log('✅ Signing secret loaded successfully');
} else {
    console.log('❌ Signing secret NOT loaded');
    console.log('Current working directory:', process.cwd());
    console.log('Looking for .env file at:', require('path').join(process.cwd(), '.env'));
} 