// Drives server.js's Socket Mode dispatch with fake events; never connects to Slack.
const assert = require('assert');
const { SocketModeClient } = require('@slack/socket-mode');

let client;
SocketModeClient.prototype.start = async function () { client = this; };
process.env.PORT = '0';
process.env.SLACK_APP_TOKEN = 'xapp-test';
process.env.MONITORED_CHANNELS = '';
require('./server.js');

function send(type, body) {
    return new Promise((resolve) => {
        client.emit('slack_event', { type, body, ack: async (response) => resolve(response) });
    });
}

(async () => {
    while (!client) await new Promise(r => setTimeout(r, 10));

    const status = await send('slash_commands', { command: '/env-status', channel_id: 'C1', user_id: 'U1' });
    assert.match(status.text, /Available/);
    assert.doesNotMatch(status.text, /Recovery Data/);

    const dm = await send('slash_commands', { command: '/env-status', channel_id: 'D1', user_id: 'U1' });
    assert.match(dm.text, /not in a direct message/);

    assert.strictEqual(await send('events_api', {}), undefined);

    for (let i = 0; i < 8; i++) await send('slash_commands', { command: '/env-status', channel_id: 'C1', user_id: 'U1' });
    const limited = await send('slash_commands', { command: '/env-status', channel_id: 'C1', user_id: 'U1' });
    assert.match(limited.text, /Too many requests/);

    console.log('✅ Socket Mode dispatch: 5 checks passed');
    process.exit(0);
})().catch((error) => {
    console.error('❌', error);
    process.exit(1);
});
