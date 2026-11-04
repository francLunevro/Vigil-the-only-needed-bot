import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Card, Button, Input, Textarea } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// Per-server Settings, ported from vanilla's hub pane
// (src/dashboard/parts/02-ui-shell.mjs — loadSrvSettings / saveSrvSettings).
// It held two things and nothing else:
//
//   Command Prefix   d.prefix     → POST {prefix}     (default ';', max 5 chars, no spaces)
//   Embed Color      d.embedColor → POST {embedColor} ('#rrggbb', or '' for the bot default)
//   Punishment DMs   d.modDm      → POST {modDm}      ({enabled, appealInfo} — src/modDm.js)
//
// Both are read from GET /api/server/:id and written through
// POST /api/server/:id/settings, which answers {success:true} or a 400/403/404
// with {error}. Neither save nor load is a request of this pane's own: the
// server-detail route has already fetched that payload, so the form is seeded
// from it and cannot disagree with the header about which server it describes.
//
// The endpoint validates both fields but applies them one at a time - a bad
// prefix returns before anything is written, yet a valid prefix is written
// before a bad colour is rejected. The prefix is therefore checked here first,
// with the endpoint's own rule and message, so a rejected save cannot leave
// half of the form persisted. The colour needs no client-side check: it can only
// come from a colour input, which yields '#rrggbb' or nothing at all, and the
// payload's own value is already that form.

const DEFAULT_COLOR = '#5865F2';

// The API caps the appeal text at 500 characters (src/modDm.js owns the rule
// and re-applies it server-side); maxLength stops a longer paste from being
// silently trimmed into something the moderator did not write.
const APPEAL_MAX = 500;

// `useDefault` mirrors "this server has no custom colour", which is what the
// API's null means. Vanilla left the checkbox unchecked in that state, so the
// control described nothing and saving the prefix alone silently pinned the
// bot default as an explicit per-server value.
//
// Punishment DM receipts default to ON and an absent appealInfo means "use the
// built-in appeal line", so both of these seed from the API's own defaults
// rather than an invented "off/unset" state.
function seed(prefix, embedColor, modDmEnabled, appealInfo) {
    return {
        prefix: prefix || ';',
        embedColor: embedColor || DEFAULT_COLOR,
        useDefault: !embedColor,
        modDmEnabled: modDmEnabled !== false,
        appealInfo: appealInfo || '',
    };
}

export default function ServerSettings({ serverId, prefix, embedColor, modDmEnabled = true, appealInfo = '', onSaved }) {
    const toast = useToast();
    const [form, setForm] = useState(() => seed(prefix, embedColor, modDmEnabled, appealInfo));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    // Re-seed when the pane is re-pointed at another server, and when the loaded
    // payload changes underneath it — a save followed by a detail reload is
    // exactly that, so the form ends up showing what actually persisted rather
    // than what was typed.
    useEffect(() => {
        setForm(seed(prefix, embedColor, modDmEnabled, appealInfo));
        setError(null);
    }, [serverId, prefix, embedColor, modDmEnabled, appealInfo]);

    function set(field, value) {
        setForm((prev) => ({ ...prev, [field]: value }));
    }

    async function save() {
        const forId = serverId;
        const next = form.prefix.trim();
        if (next.length > 5 || /\s/.test(next)) {
            setError('Prefix must be 1-5 characters with no spaces');
            return;
        }
        const color = form.useDefault ? '' : form.embedColor;
        // '' means "no custom appeal line" and travels as null, which is the
        // shape the bot's receipt builder reads as "use the default" (an empty
        // string would otherwise be sent to members as a blank Appeal field).
        const appeal = form.appealInfo.trim();

        setBusy(true);
        setError(null);
        try {
            // Every field the pane owns goes together, as vanilla sent them; the
            // API treats an absent key as "leave this one alone", so sending all
            // of them is what makes the form and the stored config agree
            // afterwards. An invalid field is rejected before anything is
            // written only for the prefix — see the note above — which is why the
            // prefix is the one checked here.
            await api.post('/api/server/' + forId + '/settings', {
                prefix: next,
                embedColor: color,
                modDm: {
                    enabled: form.modDmEnabled,
                    appealInfo: appeal ? appeal.slice(0, APPEAL_MAX) : null,
                },
            });
            toast('Server settings saved');
            // The id goes with the notification: the reply can land after the
            // view has moved to another server, and it is the view that knows
            // whether this save still belongs to what it is showing.
            if (onSaved) onSaved(forId);
        } catch (err) {
            setError(err.message || 'Could not save server settings');
        } finally {
            setBusy(false);
        }
    }

    return (
        <Card title="Server Settings" icon="sliders"
            action={<Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>}>
            <div className="field">
                <label htmlFor="srv-prefix">Command Prefix</label>
                <Input id="srv-prefix" value={form.prefix} maxLength={5}
                    onChange={(e) => set('prefix', e.target.value)} />
            </div>
            <p className="hint">Prefix for text commands (default: ;). Max 5 characters, no spaces.</p>

            <div className="field">
                <label htmlFor="srv-embed-color">Embed Color</label>
                <input id="srv-embed-color" type="color" className="color-input" value={form.embedColor}
                    onChange={(e) => setForm((prev) => ({ ...prev, embedColor: e.target.value, useDefault: false }))} />
                <span className="mono">{form.useDefault ? 'Bot default' : form.embedColor}</span>
                <label className="inline-label">
                    <input type="checkbox" checked={form.useDefault}
                        onChange={(e) => set('useDefault', e.target.checked)} /> Use bot default
                </label>
            </div>
            <p className="hint">
                Accent color for this server’s embeds (welcome messages, giveaways, and other
                embeds that read guild config).
            </p>

            <div className="field">
                <label className="inline-label">
                    <input id="srv-mod-dm" type="checkbox" checked={form.modDmEnabled}
                        onChange={(e) => set('modDmEnabled', e.target.checked)} />
                    <span>Send members a DM receipt for warnings, timeouts, kicks and bans</span>
                </label>
            </div>
            <p className="hint">
                Every successful warning, timeout, kick and ban is also written to the mod log
                above. This only controls the private message to the member; a member who has
                DMs closed is never affected, and the punishment still happens.
            </p>

            <div className="field">
                <label htmlFor="srv-mod-appeal">Appeal Instructions</label>
                <Textarea id="srv-mod-appeal" rows={3} maxLength={APPEAL_MAX} value={form.appealInfo}
                    disabled={!form.modDmEnabled}
                    placeholder="Leave blank to use the default appeal line"
                    onChange={(e) => set('appealInfo', e.target.value)} />
            </div>
            <p className="hint">
                Goes out with every punishment receipt, alongside the reason and case number
                (max {APPEAL_MAX} characters).
            </p>

            {error && <p className="result result-bad" role="alert">{error}</p>}
        </Card>
    );
}
