import { allServers, curSrv, esc, fnData, showToast, updateRefreshTimestamp } from './01-foundation.mjs';

// ═══ CUSTOM COMMANDS & AUTORESPONDERS ═══
// Two lists in one section because they are two halves of the same idea:
// custom commands answer a prefix command the server wrote, autoresponders
// answer ordinary chatter. Both are plain rows in SQLite, edited here through
// /api/server/:id/custom-commands and /api/server/:id/autoresponders.

const MATCH_LABELS = {
    exact: 'exact message',
    contains: 'contains',
    startswith: 'starts with',
    regex: 'regex',
};

function serverSelect() {
    const sel = document.getElementById('ccSrvSelect');
    if (!sel) return null;
    if (sel.options.length <= 1 && allServers.length) {
        sel.innerHTML = '<option value="">Select a server...</option>' + allServers.map(function (s) {
            return '<option value="' + s.id + '"' + (curSrv === s.id ? ' selected' : '') + '>' + esc(s.name) + '</option>';
        }).join('');
    }
    return sel;
}

export async function loadCustomCommands() {
    const sel = serverSelect();
    if (!sel) return;
    const cont = document.getElementById('customCommandsContent');
    if (!cont) return;

    const serverId = sel.value;
    if (!serverId) {
        cont.innerHTML = '<div class="empty"><p>Select a server to manage custom commands</p></div>';
        updateRefreshTimestamp('custom-commands');
        return;
    }

    cont.innerHTML = '<div class="loading" style="padding:30px;text-align:center;"><div class="spin"></div></div>';

    try {
        const [cmdRes, arRes] = await Promise.all([
            fetch('/api/server/' + serverId + '/custom-commands').then(function (r) { return r.json(); }),
            fetch('/api/server/' + serverId + '/autoresponders').then(function (r) { return r.json(); }),
        ]);
        const commands = cmdRes.commands || [];
        const responders = arRes.responders || [];
        const channels = arRes.channels || [];
        const prefix = cmdRes.prefix || ';';
        const max = cmdRes.maxPerGuild || 50;

        // ── Custom commands ──
        let html = '<div class="stg" style="margin-bottom:16px;"><label>Custom Commands</label>' +
            '<div class="stg-inl" style="margin-bottom:8px;flex-wrap:wrap;">' +
            '<input type="text" id="ccNewName" placeholder="Command name (e.g. rules)" style="flex:0 0 180px;">' +
            '<input type="text" id="ccNewResponse" placeholder="Response — {user} {server} {membercount} {channel} {args}" style="flex:1;min-width:240px;">' +
            '<label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim);"><input type="checkbox" id="ccNewEmbed" style="width:auto;">as embed</label>' +
            '<button class="btn btn-s" data-fn="saveCustomCommandUI" data-args=\'['+fnData(serverId)+']\'>Save Command</button>' +
            '</div>' +
            '<div class="stg-hint">Typed as <code>' + esc(prefix) + 'name</code>. Built-in commands always win, so a name that already exists is rejected. ' + commands.length + '/' + max + ' used.</div></div>';

        if (!commands.length) {
            html += '<div class="empty"><p>No custom commands yet</p><p class="empty-act">Add one above — it answers instantly, no restart.</p></div>';
        } else {
            html += commands.map(function (c) {
                return '<div class="card" style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">' +
                    '<div style="min-width:0;">' +
                    '<strong style="font-family:monospace;">' + esc(prefix) + esc(c.name) + '</strong>' +
                    (c.asEmbed ? '<span class="sub"> · embed</span>' : '') +
                    (c.uses ? '<span class="sub"> · ' + c.uses + ' uses</span>' : '') +
                    '<div class="sub" style="white-space:pre-wrap;word-break:break-word;">' + esc(c.response.slice(0, 300)) + '</div>' +
                    '</div>' +
                    '<div style="display:flex;gap:6px;flex-shrink:0;">' +
                    '<button class="btn btn-s" data-fn="editCustomCommandUI" data-args=\'['+fnData(serverId)+','+fnData(c.name)+']\'>Edit</button>' +
                    '<button class="btn btn-s" style="background:var(--danger)" data-fn="deleteCustomCommandUI" data-args=\'['+fnData(serverId)+','+fnData(c.name)+']\'>Delete</button>' +
                    '</div></div>';
            }).join('');
        }

        // ── Autoresponders ──
        html += '<div class="stg" style="margin-top:24px;margin-bottom:16px;"><label>Autoresponders</label>' +
            '<div class="stg-inl" style="margin-bottom:8px;flex-wrap:wrap;">' +
            '<input type="text" id="arNewTrigger" placeholder="Trigger text" style="flex:1;min-width:170px;">' +
            '<select id="arNewMatch" style="flex:0 0 150px;">' +
            Object.keys(MATCH_LABELS).map(function (k) { return '<option value="' + k + '"' + (k === 'contains' ? ' selected' : '') + '>' + MATCH_LABELS[k] + '</option>'; }).join('') +
            '</select>' +
            '<input type="text" id="arNewResponse" placeholder="Response" style="flex:1;min-width:200px;">' +
            '<select id="arNewChannel" style="flex:0 0 170px;"><option value="">Every channel</option>' + channels.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('') + '</select>' +
            '<button class="btn btn-s" data-fn="createAutoresponderUI" data-args=\'['+fnData(serverId)+']\'>Add Autoresponder</button>' +
            '</div>' +
            '<div class="stg-hint">Fires on ordinary messages (bots and its own replies are ignored), one response per message, throttled per member so a trigger cannot loop.</div></div>';

        if (!responders.length) {
            html += '<div class="empty"><p>No autoresponders yet</p></div>';
        } else {
            html += responders.map(function (a) {
                var ch = channels.find(function (c) { return c.id === a.channelId; });
                return '<div class="card" style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">' +
                    '<div style="min-width:0;">' +
                    '<strong>' + esc(a.trigger) + '</strong>' +
                    '<span class="sub"> · ' + esc(MATCH_LABELS[a.matchType] || a.matchType) + (a.channelId ? ' · ' + esc(ch ? ch.name : a.channelId) : ' · every channel') + (a.uses ? ' · ' + a.uses + ' uses' : '') + '</span>' +
                    '<div class="sub" style="word-break:break-word;">' + esc(a.response.slice(0, 300)) + '</div>' +
                    '</div>' +
                    '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
                    '<div class="tg ' + (a.enabled ? 'on' : '') + '" data-ar-toggle="' + esc(a.id) + '" data-fn="toggleAutoresponderUI" data-args=\'['+fnData(serverId)+','+fnData(a.id)+']\' style="cursor:pointer;" title="' + (a.enabled ? 'Enabled' : 'Paused') + '"></div>' +
                    '<button class="btn btn-s" style="background:var(--danger)" data-fn="deleteAutoresponderUI" data-args=\'['+fnData(serverId)+','+fnData(a.id)+']\'>Delete</button>' +
                    '</div></div>';
            }).join('');
        }

        cont.innerHTML = html;
    } catch (e) {
        cont.innerHTML = '<div class="empty"><p>Failed to load custom commands</p></div>';
    }
    updateRefreshTimestamp('custom-commands');
}

export async function saveCustomCommandUI(serverId) {
    const name = document.getElementById('ccNewName')?.value || '';
    const response = document.getElementById('ccNewResponse')?.value || '';
    const asEmbed = !!document.getElementById('ccNewEmbed')?.checked;
    if (!name.trim() || !response.trim()) return showToast('A name and a response are required', true);
    try {
        const r = await fetch('/api/server/' + serverId + '/custom-commands', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, response, asEmbed }),
        });
        const d = await r.json();
        if (d.success) {
            showToast(d.created ? 'Command created!' : 'Command updated!');
            loadCustomCommands();
        } else showToast(d.error || 'Failed to save', true);
    } catch { showToast('Failed to save', true); }
}

// Loads the row back into the form so "Add" becomes "overwrite this one"
// instead of silently replacing something the user forgot they had.
export async function editCustomCommandUI(serverId, name) {
    try {
        const r = await fetch('/api/server/' + serverId + '/custom-commands');
        const d = await r.json();
        const cmd = (d.commands || []).find(function (c) { return c.name === name; });
        if (!cmd) return showToast('Command not found', true);
        const nameEl = document.getElementById('ccNewName');
        const respEl = document.getElementById('ccNewResponse');
        const embedEl = document.getElementById('ccNewEmbed');
        if (nameEl) nameEl.value = cmd.name;
        if (respEl) respEl.value = cmd.response;
        if (embedEl) embedEl.checked = !!cmd.asEmbed;
        respEl?.focus();
        showToast('Loaded — saving now overwrites it');
    } catch { showToast('Failed to load command', true); }
}

export async function deleteCustomCommandUI(serverId, name) {
    if (!confirm('Delete the custom command "' + name + '"?')) return;
    try {
        const r = await fetch('/api/server/' + serverId + '/custom-commands/' + encodeURIComponent(name), { method: 'DELETE' });
        const d = await r.json();
        if (d.success) { showToast('Command deleted'); loadCustomCommands(); } else showToast(d.error || 'Failed', true);
    } catch { showToast('Failed', true); }
}

export async function createAutoresponderUI(serverId) {
    const trigger = document.getElementById('arNewTrigger')?.value || '';
    const response = document.getElementById('arNewResponse')?.value || '';
    const matchType = document.getElementById('arNewMatch')?.value || 'contains';
    const channelId = document.getElementById('arNewChannel')?.value || null;
    if (!trigger.trim() || !response.trim()) return showToast('A trigger and a response are required', true);
    try {
        const r = await fetch('/api/server/' + serverId + '/autoresponders', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger, response, matchType, channelId }),
        });
        const d = await r.json();
        if (d.success) { showToast('Autoresponder added!'); loadCustomCommands(); } else showToast(d.error || 'Failed to add', true);
    } catch { showToast('Failed to add', true); }
}

export async function toggleAutoresponderUI(serverId, id) {
    const tg = document.querySelector('[data-ar-toggle="' + id + '"]');
    const enabled = !(tg && tg.classList.contains('on'));
    try {
        const r = await fetch('/api/server/' + serverId + '/autoresponders/' + encodeURIComponent(id), {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        });
        const d = await r.json();
        if (d.success) {
            if (tg) tg.classList.toggle('on', enabled);
            showToast(enabled ? 'Enabled' : 'Paused');
        } else showToast(d.error || 'Failed', true);
    } catch { showToast('Failed', true); }
}

export async function deleteAutoresponderUI(serverId, id) {
    if (!confirm('Delete this autoresponder?')) return;
    try {
        const r = await fetch('/api/server/' + serverId + '/autoresponders/' + encodeURIComponent(id), { method: 'DELETE' });
        const d = await r.json();
        if (d.success) { showToast('Autoresponder deleted'); loadCustomCommands(); } else showToast(d.error || 'Failed', true);
    } catch { showToast('Failed', true); }
}
