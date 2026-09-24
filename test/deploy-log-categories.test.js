// Guards the drift that made two log categories unconfigurable from Discord:
// /log channel and /log toggle must offer exactly the categories the log
// dispatcher understands (constants.LOG_CATEGORIES). The choice lists are now
// generated from that constant, and this test keeps them that way.
const { test } = require('node:test');
const assert = require('node:assert');

const { commandDefs } = require('../src/deploy');
const { LOG_CATEGORIES, LOG_CATEGORY_LABELS } = require('../src/constants');

function logSubcommandOptions(subName) {
    const logCmd = commandDefs.find(c => c.name === 'log');
    assert.ok(logCmd, '/log command must exist');
    // deploy.js exports already-serialized command payloads (plain objects).
    const sub = logCmd.options.find(o => o.name === subName);
    assert.ok(sub, `subcommand ${subName} must exist`);
    return sub.options;
}

test('every log category is offered by /log channel', () => {
    const options = logSubcommandOptions('channel');
    const type = options.find(o => o.name === 'type');
    assert.deepStrictEqual(
        type.choices.map(c => c.value).sort(),
        [...LOG_CATEGORIES].sort(),
        '/log channel choices must match LOG_CATEGORIES exactly'
    );
});

test('every log category is offered by /log toggle', () => {
    const options = logSubcommandOptions('toggle');
    const category = options.find(o => o.name === 'category');
    assert.deepStrictEqual(
        category.choices.map(c => c.value).sort(),
        [...LOG_CATEGORIES].sort(),
        '/log toggle choices must match LOG_CATEGORIES exactly'
    );
});

test('the categories that previously went missing are selectable', () => {
    const values = logSubcommandOptions('channel').find(o => o.name === 'type').choices.map(c => c.value);
    assert.ok(values.includes('moderation'), 'moderation logs must be routable from Discord');
    assert.ok(values.includes('applications'), 'applications logs must be routable from Discord');
});

test('choice labels are human-readable and complete', () => {
    const choices = logSubcommandOptions('toggle').find(o => o.name === 'category').choices;
    for (const c of choices) {
        assert.ok(LOG_CATEGORY_LABELS[c.value], `missing label for ${c.value}`);
        assert.strictEqual(c.name, LOG_CATEGORY_LABELS[c.value]);
    }
});
